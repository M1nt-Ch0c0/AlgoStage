import { appendFileSync, mkdirSync } from "node:fs";
import { loadavg } from "node:os";
import path from "node:path";
import {
  expect,
  test,
  type BrowserContext,
  type CDPSession,
  type Locator,
  type Page,
  type Route,
  type TestInfo,
} from "@playwright/test";

/**
 * Cancel paint: event.timeStamp of 取消 pointerup to the next frame where
 * [data-ask-panel] is visually gone (display:none, aria-hidden, inert, or
 * absent). Node removal is recorded and is not the paint end. Timing test,
 * not in daily e2e. The whole file is skipped unless S4_CANCEL_PAINT=1.
 * Helpers are copied from the r5c cancel harness, not imported.
 */

const CACHE_KEY = "a".repeat(40);
const SCRIPT_VERSION = "b".repeat(40);
const QUESTION = "这一步在做什么？";
const ANSWER_NARRATION = "把相同字母的词放进同一组。";

const ENABLED = process.env.S4_CANCEL_PAINT === "1";
const ROUNDS = Number(process.env.S4_CANCEL_ROUNDS ?? 6);
const BUDGET_MS = 100;
const CPU_RATE = 4;
const OUT_DIR = process.env.S4_OUT_DIR;
/** Default opens from the viz chip. `S4_OPEN=marquee` keeps drag-then-chip for debugging. */
const OPEN_MARQUEE = process.env.S4_OPEN === "marquee";

type StepOpts = { id?: string; narration?: string; viz?: boolean };
type Phase = "preparing" | "waiting";
type Width = 390 | 1280;

type LongTask = { s: number; d: number };
type ReleaseStamp = { ts: number; dispatch: number };
/** Paint-time focus, same shape as the prof harness. `where` is `chip:<key>` on a shortcut. */
type FocusAtPaint = {
  ok: boolean;
  where: string | null;
  chipN: number;
  bar: boolean;
  panelHidden: boolean;
};

type PaintBag = {
  __lt: LongTask[];
  __rel: ReleaseStamp | null;
  __paint: number | null;
  __paintPost: number | null;
  __unmount: number | null;
  __hide: number | null;
  __downState: string | null;
  __upState: string | null;
  __geom: GeomFrame | null;
  __focusAtPaint: FocusAtPaint | null;
};

type GeomFrame = {
  occl: string;
  selTop: number | null;
  selBottom: number | null;
  barTop: number | null;
};

type PaintResult = {
  missing?: boolean;
  rel?: boolean;
  stallAdj: number;
  unmountMs: number;
  paintMs: number;
  focusAtPaint: FocusAtPaint | null;
  via: string;
};

type RoundRow = {
  w: Width;
  phase: Phase;
  round: number;
  paintMs: number;
  unmountMs: number;
  stallAdj: number;
  load: number;
  focusChip: boolean;
  occl1: string | null;
  occlSettled: string | null;
};

function step(opts: StepOpts = {}) {
  const id = opts.id ?? "s1";
  return {
    id,
    narration: opts.narration ?? "开局把词按字母分组",
    targets: [{ kind: "code-line", start: 1, end: 2 }],
    effects: [],
    dwellMs: 60_000,
    ...(opts.viz === false
      ? {}
      : { viz: { type: "array", state: { values: [1, 2, 3], highlight: [0] } } }),
  };
}

function lectureNdjson(options: {
  steps?: ReturnType<typeof step>[];
  askDisabledStepIds?: string[];
  withResult?: boolean;
}) {
  const steps = options.steps ?? [step(), step({ id: "s2", narration: "再写回结果" }), step({ id: "s3", narration: "返回分组" })];
  const lines = steps.map((item) => JSON.stringify({ type: "step", step: item }));
  if (options.withResult !== false) {
    lines.push(
      JSON.stringify({
        type: "result",
        script: {
          problemSlug: "group-anagrams",
          mode: "lecture",
          language: "zh",
          solutionLanguage: "typescript",
          steps,
        },
        cacheKey: CACHE_KEY,
        scriptVersion: SCRIPT_VERSION,
        answers: {},
        askDisabledStepIds: options.askDisabledStepIds ?? [],
      }),
    );
  }
  return `${lines.join("\n")}\n`;
}

function askStream(stepId: string) {
  const segment = { id: "seg1", narration: ANSWER_NARRATION };
  const answer = {
    v: 1,
    id: "ans-e2e-sel",
    stepId,
    question: QUESTION,
    selection: {
      mode: "region",
      bbox: { x: 0, y: 0, width: 40, height: 40 },
      targets: [{ kind: "viz", id: `viz:${stepId}`, stepId, text: "可视化" }],
    },
    segments: [segment],
    createdAt: "2026-10-14T00:00:00.000Z",
  };
  return [
    JSON.stringify({ type: "start", answerId: answer.id, stepId, imageUsed: false }),
    JSON.stringify({ type: "segment", segment }),
    JSON.stringify({ type: "result", answer }),
  ].join("\n") + "\n";
}

async function fulfillJson(route: Route, body: unknown, delayMs = 0) {
  if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function mockSettings(page: Page, serverKeyDisabled: boolean, delayMs = 0) {
  await page.route("**/api/settings", (route) =>
    fulfillJson(route, { serverKeyDisabled, keySource: "env" }, delayMs),
  );
}

async function mockLecture(page: Page, body: string | (() => Promise<string> | string)) {
  await page.route("**/api/lecture", async (route) => {
    if (route.request().url().includes("/api/lecture/ask")) {
      await route.fallback();
      return;
    }
    const payload = typeof body === "function" ? await body() : body;
    await route.fulfill({
      status: 200,
      contentType: "application/x-ndjson",
      body: payload,
    });
  });
}

const entry = (p: Page) => p.locator("[data-ask-entry]");
const VH = (w: number) => (w === 390 || w === 320 ? 844 : 800);

async function hitOf(page: Page, el: Locator) {
  const b = (await el.boundingBox())!;
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  const ok = await el.evaluate((n, point) => {
    const [x, y] = point as [number, number];
    const h = document.elementFromPoint(x, y);
    return !!h && (h === n || n.contains(h));
  }, [cx, cy]);
  return {
    cx,
    cy,
    ok,
    box: { x: +b.x.toFixed(2), y: +b.y.toFixed(2), w: +b.width.toFixed(2), h: +b.height.toFixed(2) },
  };
}

type Ask = { hasImage: boolean; b64: string; mime: string | null };

async function setup(page: Page, w: number, askDelay = 1500) {
  const asks: Ask[] = [];
  const failed: string[] = [];
  page.on("requestfailed", (r) => {
    if (r.url().includes("/api/lecture/ask")) failed.push(r.failure()?.errorText ?? "failed");
  });
  await page.route("**/api/lecture/ask", async (route) => {
    let b: Record<string, unknown> = {};
    try {
      b = route.request().postDataJSON() as Record<string, unknown>;
    } catch {
      /* keep {} */
    }
    const im = b.image as { dataBase64?: string; mime?: string } | null | undefined;
    asks.push({ hasImage: !!im?.dataBase64, b64: im?.dataBase64 ?? "", mime: im?.mime ?? null });
    await new Promise((r) => setTimeout(r, askDelay));
    await route.fulfill({ status: 200, contentType: "application/x-ndjson", body: askStream("s1") }).catch(() => {});
  });
  await page.addInitScript(() => {
    const W = window as unknown as PaintBag;
    W.__lt = [];
    W.__rel = null;
    W.__paint = null;
    W.__paintPost = null;
    W.__unmount = null;
    W.__geom = null;
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) W.__lt.push({ s: e.startTime, d: e.duration });
    }).observe({ type: "longtask", buffered: true });
  });
  await page.setViewportSize({ width: w, height: VH(w) });
  await mockSettings(page, false);
  await mockLecture(page, lectureNdjson({}));
  await page.goto("problem/group-anagrams");
  await page.locator("header").getByRole("button", { name: "开始讲课", exact: true }).click();
  await expect(page.getByText("第 1 / 3 步")).toBeVisible();
  const pause = page.locator("header").getByRole("button", { name: "暂停", exact: true });
  if (await pause.isVisible()) await pause.click();
  await page.waitForTimeout(600);
  return { asks, failed };
}

async function tapAt(page: Page, x: number, y: number, touch: boolean) {
  if (touch) await page.touchscreen.tap(x, y);
  else await page.mouse.click(x, y);
}

async function enter(page: Page, touch: boolean) {
  await entry(page).scrollIntoViewIfNeeded();
  const h = await hitOf(page, entry(page));
  await tapAt(page, h.cx, h.cy, touch);
  await expect(page.locator("[data-ask-layer]")).toBeVisible();
  await page.waitForTimeout(300);
  return h;
}

/**
 * Mobile drops [data-ask-entry] while ask is open, so a later enter() cannot
 * see it. Esc closes the panel, then exits ask so the entry is visible.
 */
async function exitAskToIdle(page: Page) {
  const layer = page.locator("[data-ask-layer]");
  for (let i = 0; i < 4; i += 1) {
    if ((await layer.count()) === 0) break;
    await page.keyboard.press("Escape");
  }
  await expect(layer).toHaveCount(0);
  await expect(entry(page)).toBeVisible();
}

async function marquee(page: Page, x0: number, y0: number, x1: number, y1: number) {
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  await page.mouse.move(x1, y1, { steps: 8 });
  await page.mouse.up();
}

/** Real tap on the viz chip. Records chip open-source so cancel restores that chip. */
async function tapVizChip(page: Page, touch: boolean) {
  const s = page.locator('[data-ask-shortcut="viz"]').first();
  await s.scrollIntoViewIfNeeded();
  const h = await hitOf(page, s);
  await tapAt(page, h.cx, h.cy, touch);
}

/**
 * Open the viz ask panel and fill the question.
 * Default matches the prof harness: chip first, returns "chip". No marquee.
 * S4_OPEN=marquee keeps the old drag, then chip fallback, for debugging.
 */
async function openViz(page: Page, touch: boolean): Promise<"chip" | "marquee" | "shortcut-viz"> {
  if (!OPEN_MARQUEE) {
    await tapVizChip(page, touch);
    await expect(page.locator("[data-ask-panel]")).toBeVisible();
    await page.locator("[data-ask-question]").fill(QUESTION);
    return "chip";
  }
  const viz = page.locator('[data-ask-stage] [data-ask-id="viz:s1"]').first();
  await viz.scrollIntoViewIfNeeded();
  const vb = (await viz.boundingBox())!;
  await marquee(page, vb.x + 8, vb.y + 8, vb.x + vb.width - 8, vb.y + Math.min(vb.height - 8, 80));
  let via: "marquee" | "shortcut-viz" = "marquee";
  if (!(await page.locator("[data-ask-panel]").isVisible({ timeout: 1500 }).catch(() => false))) {
    via = "shortcut-viz";
    await tapVizChip(page, touch);
  }
  await expect(page.locator("[data-ask-panel]")).toBeVisible();
  await page.locator("[data-ask-question]").fill(QUESTION);
  return via;
}

const isPrep = (p: Page) => p.evaluate(() => !!document.querySelector("[data-ask-capture-preparing]"));

async function waitPrep(page: Page) {
  for (let i = 0; i < 300; i++) {
    if (await isPrep(page)) return true;
    await page.waitForTimeout(3);
  }
  return false;
}

/**
 * Capture-phase pointerup on [data-ask-cancel] records event.timeStamp.
 * Paint is the next rAF where the panel is visually gone (display:none,
 * aria-hidden, inert, or absent). MutationObserver only notes node removal
 * and is not the paint end. At 390 preparing, that same rAF reads occlusion,
 * selection, and the bottom bar.
 */
const armPaint = (p: Page, recordGeom: boolean) =>
  p.evaluate((wantGeom) => {
    const W = window as unknown as PaintBag;
    W.__rel = null;
    W.__paint = null;
    W.__paintPost = null;
    W.__unmount = null;
    W.__hide = null;
    W.__geom = null;
    W.__focusAtPaint = null;
    /** Uma: visually cancelled = gone OR hideAskPanelNow (display:none / aria-hidden / inert). */
    const visuallyGone = () => {
      const el = document.querySelector<HTMLElement>("[data-ask-panel]");
      if (!el) return true;
      return el.style.display === "none" || el.getAttribute("aria-hidden") === "true" || el.hasAttribute("inert");
    };
    /** Prof harness: chip opener is `chip:<key>`; otherwise layer / ask-id / selection. */
    const describeFocus = () => {
      const active = document.activeElement;
      const a = active instanceof HTMLElement ? active : null;
      const chipN = document.querySelectorAll("[data-ask-shortcut]").length;
      const bar = !!document.querySelector("[data-ask-bottom-bar]");
      const panel = document.querySelector<HTMLElement>("[data-ask-panel]");
      const panelHidden =
        !panel || panel.style.display === "none" || panel.getAttribute("aria-hidden") === "true";
      const base = { chipN, bar, panelHidden };
      if (!a || a === document.body) return { ok: false, where: null, ...base };
      const chip = a.closest("[data-ask-shortcut]");
      if (chip) {
        return { ok: true, where: `chip:${chip.getAttribute("data-ask-shortcut") ?? ""}`, ...base };
      }
      if (a.closest("[data-ask-selection]")) return { ok: true, where: "selection", ...base };
      if (a.matches("[data-ask-id]") || a.closest("[data-ask-id]")) {
        return { ok: true, where: "ask-id", ...base };
      }
      if (a.closest("[data-ask-layer]")) return { ok: true, where: "layer", ...base };
      const cancel = a.hasAttribute("data-ask-cancel") ? "#cancel" : "";
      return { ok: false, where: `${a.tagName}${cancel}`, ...base };
    };
    const stampPaint = () => {
      if (W.__paint != null) return;
      W.__paint = performance.now();
      W.__focusAtPaint = describeFocus();
      if (wantGeom) {
        const sel = document.querySelector("[data-ask-selection]");
        const bar = document.querySelector("[data-ask-bottom-bar]");
        const selBox = sel?.getBoundingClientRect();
        const barBox = bar?.getBoundingClientRect();
        W.__geom = {
          occl: getComputedStyle(document.documentElement).getPropertyValue("--ask-bottom-occlusion").trim(),
          selTop: selBox ? selBox.top : null,
          selBottom: selBox ? selBox.bottom : null,
          barTop: barBox ? barBox.top : null,
        };
      }
      const ch = new MessageChannel();
      ch.port1.onmessage = () => {
        W.__paintPost = performance.now();
      };
      ch.port2.postMessage(0);
    };
    // Uma metric: release timeStamp → next frame paint (panel visually cancelled).
    // Do NOT wait for React unmount / MutationObserver removal.
    const armFrame = () => {
      requestAnimationFrame(() => {
        if (visuallyGone()) {
          if (W.__hide == null) W.__hide = performance.now();
          stampPaint();
        } else {
          requestAnimationFrame(() => {
            if (W.__hide == null) W.__hide = performance.now();
            stampPaint();
          });
        }
      });
    };
    document.addEventListener(
      "pointerdown",
      (e) => {
        const c = (e.target as Element | null)?.closest?.("[data-ask-cancel]");
        if (c) {
          W.__downState = document.querySelector("[data-ask-waiting]")
            ? "waiting"
            : document.querySelector("[data-ask-capture-preparing]")
              ? "preparing"
              : "idle";
        }
      },
      { capture: true },
    );
    document.addEventListener(
      "pointerup",
      (e) => {
        const c = (e.target as Element | null)?.closest?.("[data-ask-cancel]");
        if (c && !W.__rel) {
          W.__rel = { ts: e.timeStamp, dispatch: performance.now() };
          W.__upState = document.querySelector("[data-ask-waiting]")
            ? "waiting"
            : document.querySelector("[data-ask-capture-preparing]")
              ? "preparing"
              : "idle";
          armFrame();
        }
      },
      { capture: true },
    );
    // informational only: when React finally removes the node
    const mo = new MutationObserver(() => {
      if (W.__rel && !W.__unmount && !document.querySelector("[data-ask-panel]")) {
        W.__unmount = performance.now();
        mo.disconnect();
      }
    });
    mo.observe(document.body, { subtree: true, childList: true });
  }, recordGeom);

const paintMetrics = (p: Page): Promise<PaintResult> =>
  p.evaluate(() => {
    const W = window as unknown as PaintBag;
    const rel = W.__rel;
    if (!rel || W.__paint == null) {
      return { missing: true, rel: !!rel, stallAdj: 0, unmountMs: 0, paintMs: 0, focusAtPaint: null, via: "" };
    }
    let start = rel.ts;
    for (const x of W.__lt) {
      if (x.s <= start && start <= x.s + x.d) start = x.s + x.d;
    }
    const r = (x: number) => Math.round(x * 10) / 10;
    const paintAt = W.__paintPost ?? W.__paint;
    return {
      missing: false,
      stallAdj: r(start - rel.ts),
      unmountMs: r((W.__unmount ?? start) - start),
      paintMs: r(paintAt - start),
      focusAtPaint: W.__focusAtPaint,
      via: "",
    };
  });

async function cdpPress(cdp: CDPSession, page: Page, x: number, y: number, touch: boolean, holdMs = 150) {
  if (touch) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: Math.round(x), y: Math.round(y) }],
    });
    await new Promise((r) => setTimeout(r, holdMs));
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    return;
  }
  await page.mouse.move(x, y);
  await page.mouse.down();
  await new Promise((r) => setTimeout(r, holdMs));
  await page.mouse.up();
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function appendRound(row: RoundRow) {
  if (!OUT_DIR) return;
  mkdirSync(OUT_DIR, { recursive: true });
  appendFileSync(path.join(OUT_DIR, "cancel-paint.jsonl"), `${JSON.stringify(row)}\n`);
}

async function freshRound(context: BrowserContext, width: Width, phase: Phase) {
  const page = await context.newPage();
  const askDelay = phase === "waiting" ? 20_000 : 1_500;
  const bag = await setup(page, width, askDelay);
  return { page, asks: bag.asks };
}

async function runCancelRound(page: Page, width: Width, phase: Phase, touch: boolean): Promise<PaintResult> {
  await enter(page, touch);
  const via = await openViz(page, touch);
  const submit = await hitOf(page, page.locator("[data-ask-submit]"));
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU_RATE });
  try {
    const recordGeom = width === 390 && phase === "preparing";
    await armPaint(page, recordGeom);
    await tapAt(page, submit.cx, submit.cy, touch);
    if (phase === "preparing") {
      const saw = await waitPrep(page);
      expect(saw, "preparing row appeared").toBe(true);
    } else {
      await page.locator("[data-ask-waiting]").waitFor({ timeout: 15_000 });
      await page.waitForTimeout(800);
    }
    const cancel = await hitOf(page, page.locator("[data-ask-cancel]").first());
    await cdpPress(cdp, page, cancel.cx, cancel.cy, touch, 150);
    await expect(page.locator("[data-ask-panel]")).toHaveCount(0, { timeout: 5_000 });
    await expect
      .poll(async () => page.evaluate(() => (window as unknown as PaintBag).__paintPost != null), { timeout: 5_000 })
      .toBe(true);
    const paint = await paintMetrics(page);
    return { ...paint, via };
  } finally {
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 }).catch(() => {});
  }
}

async function assertOcclusion(page: Page) {
  const first = await page.evaluate(() => (window as unknown as PaintBag).__geom);
  expect(first, "first-frame geometry").not.toBeNull();
  const frame = first as GeomFrame;
  await page.waitForTimeout(600);
  const settled = await page.evaluate(() => {
    const sel = document.querySelector("[data-ask-selection]");
    const bar = document.querySelector("[data-ask-bottom-bar]");
    const selBox = sel?.getBoundingClientRect();
    const barBox = bar?.getBoundingClientRect();
    return {
      occl: getComputedStyle(document.documentElement).getPropertyValue("--ask-bottom-occlusion").trim(),
      selTop: selBox ? selBox.top : null,
      selBottom: selBox ? selBox.bottom : null,
      barTop: barBox ? barBox.top : null,
      innerHeight: window.innerHeight,
    };
  });
  expect(frame.occl).toBe(settled.occl);
  // 390×844: player 164 + chip bar 60 + gap 8. Both the cancel frame and the
  // settled value are that total. The player sits flush (bottom-0) so
  // measureAskPlayerBarHeight reads 164, not the old sticky bottom-2's 162.
  console.log(`cancel-paint occlusion settled=${settled.occl} innerHeight=${settled.innerHeight}`);
  expect(frame.occl).toBe("232px");
  expect(settled.occl).toBe("232px");
  expect(frame.selTop, "selection top at first frame").toEqual(expect.any(Number));
  expect(settled.selTop, "selection top settled").toEqual(expect.any(Number));
  expect(Math.abs((frame.selTop as number) - (settled.selTop as number))).toBeLessThanOrEqual(0.5);
  expect(settled.barTop, "bottom bar top").toEqual(expect.any(Number));
  expect(settled.selBottom, "selection bottom").toEqual(expect.any(Number));
  expect(settled.barTop as number).toBeGreaterThanOrEqual((settled.selBottom as number) - 0.5);
  return { occl1: frame.occl, occlSettled: settled.occl };
}

function logRounds(info: TestInfo, width: Width, phase: Phase, rows: RoundRow[]) {
  const paints = rows.map((row) => row.paintMs);
  const summary = {
    w: width,
    phase,
    rounds: rows.length,
    median: median(paints),
    max: Math.max(...paints),
    all: paints,
    rows,
  };
  console.log(`cancel-paint ${JSON.stringify(summary)}`);
  info.annotations.push({ type: "cancel-paint", description: JSON.stringify(summary) });
  expect(summary.max).toBeLessThan(BUDGET_MS);
}

test.skip(!ENABLED, "set S4_CANCEL_PAINT=1 to measure cancel paint");

function requireRounds() {
  if (!Number.isFinite(ROUNDS) || ROUNDS < 6) {
    throw new Error(`S4_CANCEL_ROUNDS must be >= 6 (got ${process.env.S4_CANCEL_ROUNDS ?? "6"})`);
  }
}

async function collectRounds(
  context: BrowserContext,
  info: TestInfo,
  width: Width,
  phase: Phase,
  touch: boolean,
) {
  requireRounds();
  test.setTimeout(ROUNDS * 20_000 + 30_000);
  const rows: RoundRow[] = [];
  for (let round = 1; round <= ROUNDS; round += 1) {
    const { page, asks } = await freshRound(context, width, phase);
    try {
      const paint = await runCancelRound(page, width, phase, touch);
      expect(paint.missing, `round ${round} paint`).toBe(false);
      if (paint.missing) continue;
      expect(paint.paintMs).toBeLessThan(BUDGET_MS);
      await expect(page.locator("[data-ask-panel]")).toHaveCount(0);
      await expect(page.locator("[data-ask-error]")).toHaveCount(0);
      if (phase === "preparing") expect(asks).toHaveLength(0);
      // Chip opener: Uma's gate is focus at paint (`chip:<key>`), not live
      // activeElement after the panel has unmounted (focus can drift by then).
      const focusWhere = paint.focusAtPaint?.where ?? "";
      const focusChip = focusWhere.startsWith("chip:");
      const liveFocus = await page.evaluate(() => {
        const active = document.activeElement;
        if (!(active instanceof HTMLElement) || active === document.body) return "BODY";
        const chip = active.closest("[data-ask-shortcut]");
        if (chip instanceof HTMLElement) return `chip:${chip.getAttribute("data-ask-shortcut") ?? ""}`;
        if (active.closest("[data-ask-layer]")) return "layer";
        if (active.closest("[data-ask-id]")) return "ask-id";
        return active.tagName;
      });
      console.log(
        `cancel-paint round ${round} via=${paint.via} focusAtPaint=${focusWhere || "null"} liveActive=${liveFocus}`,
      );
      if (!OPEN_MARQUEE) expect(paint.via, "open source is chip").toBe("chip");
      expect(focusChip, "chip keeps focus").toBe(true);
      let occl1: string | null = null;
      let occlSettled: string | null = null;
      if (width === 390 && phase === "preparing") {
        const occl = await assertOcclusion(page);
        occl1 = occl.occl1;
        occlSettled = occl.occlSettled;
      }
      const row: RoundRow = {
        w: width,
        phase,
        round,
        paintMs: paint.paintMs,
        unmountMs: paint.unmountMs,
        stallAdj: paint.stallAdj,
        load: loadavg()[0] ?? 0,
        focusChip,
        occl1,
        occlSettled,
      };
      rows.push(row);
      appendRound(row);
    } finally {
      await page.close();
    }
  }
  logRounds(info, width, phase, rows);
}

test.describe("cancel paint 1280", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  for (const phase of ["preparing", "waiting"] as const) {
    test(`1280 ${phase}`, async ({ context }, info) => {
      await collectRounds(context, info, 1280, phase, false);
    });
  }
});

test.describe("cancel paint 390", () => {
  test.use({
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 3,
    viewport: { width: 390, height: 844 },
  });

  for (const phase of ["preparing", "waiting"] as const) {
    test(`390 ${phase}`, async ({ context }, info) => {
      await collectRounds(context, info, 390, phase, true);
    });
  }

  test("cache refresh after rotate", async ({ page }) => {
    test.setTimeout(90_000);
    const bag = await setup(page, 390, 1_500);
    await enter(page, true);
    await openViz(page, true);
    await page.setViewportSize({ width: 844, height: 390 });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator("[data-ask-layer]")).toBeVisible({ timeout: 10_000 });
    await exitAskToIdle(page);
    const paint = await runCancelRound(page, 390, "preparing", true);
    expect(paint.missing).toBe(false);
    if (paint.missing) return;
    expect(paint.paintMs).toBeLessThan(BUDGET_MS);
    expect(paint.focusAtPaint?.where ?? "", "focus at paint is the chip").toMatch(/^chip:/);
    expect(bag.asks).toHaveLength(0);
    await expect(page.locator("[data-ask-error]")).toHaveCount(0);
    await expect(page.locator("[data-ask-panel]")).toHaveCount(0);
    await assertOcclusion(page);
  });
});
