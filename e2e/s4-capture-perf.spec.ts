import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page, type Route } from "@playwright/test";
import type { AskTimingProbe } from "../lib/ask/ask-timing";

/**
 * S4-a：提问提交时 captureStage（modern-screenshot domToCanvas）的性能测量。
 * 整组跳过，除非 S4_PERF=1。不进日常 e2e。
 * 帮手从 e2e/ask-selection.spec.ts 原样复制，不 import。
 */

const CACHE_KEY = "a".repeat(40);
const SCRIPT_VERSION = "b".repeat(40);
const QUESTION = "这一步在做什么？";
const ANSWER_NARRATION = "把相同字母的词放进同一组。";

type StepOpts = { id?: string; narration?: string; viz?: boolean };

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

async function mockAsk(page: Page, handler: (route: Route) => Promise<void>) {
  await page.route("**/api/lecture/ask", handler);
}

async function startGenerated(page: Page, ndjson = lectureNdjson({})) {
  await mockSettings(page, false);
  await mockLecture(page, ndjson);
  await page.goto("/problem/group-anagrams");
  await page.locator("header").getByRole("button", { name: "开始讲课", exact: true }).click();
  await expect(page.getByText("第 1 / 3 步")).toBeVisible();
}

const entry = (page: Page) => page.locator("[data-ask-entry]");

async function pauseLecture(page: Page) {
  const pause = page.locator("header").getByRole("button", { name: "暂停", exact: true });
  const resume = page.locator("header").getByRole("button", { name: "继续", exact: true });
  await expect(pause.or(resume)).toBeVisible();
  if (await pause.isVisible()) await pause.click();
  await expect(resume).toBeVisible();
}

async function enterSelection(page: Page) {
  const button = entry(page);
  await expect(button).toBeVisible();
  await expect(button).toBeEnabled();
  await expect(button).not.toHaveAttribute("aria-disabled", "true");
  await button.click();
  await expect(page.locator("[data-ask-layer]")).toBeVisible();
  await expect(button).toHaveAttribute("aria-pressed", "true");
}

async function dragOnStage(page: Page) {
  const stage = page.locator("[data-ask-stage]");
  const viz = stage.locator('[data-ask-id="viz:s1"]').first();
  await expect(viz).toBeVisible();
  const box = await viz.boundingBox();
  if (!box) throw new Error("viz target has no box");
  const startX = box.x + 8;
  const startY = box.y + 8;
  const endX = box.x + Math.max(box.width - 8, 40);
  const endY = box.y + Math.max(Math.min(box.height - 8, 80), 36);
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(endX, endY, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator("[data-ask-panel]")).toBeVisible();
}

async function dragOnSubtitle(page: Page) {
  const subtitleBody = page.locator('[data-ask-target="subtitle"] p').filter({ hasNotText: "字幕" }).first();
  await subtitleBody.scrollIntoViewIfNeeded();
  const box = await subtitleBody.boundingBox();
  if (!box) throw new Error("subtitle body has no box");
  const startX = box.x + 20;
  const startY = box.y + 5;
  const endX = box.x + box.width - 20;
  const endY = box.y + box.height + 30;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(endX, endY, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator("[data-ask-panel]")).toBeVisible();
}

type LongTask = { start: number; duration: number };

type CaptureGeometry = {
  devicePixelRatio: number;
  scale: number;
  crop: { x: number; y: number; w: number; h: number };
  canvas: { width: number; height: number };
};

type PerfSummary = {
  width: number;
  ab: string[];
  longestTaskMs: number;
  longTaskCount: number;
  longTasks: LongTask[];
  /** Long tasks whose interval overlaps [captureStart, longTaskEnd]. */
  domToCanvasLongTaskCount: number;
  domToCanvasLongTaskMaxMs: number;
  domToCanvasSingleLongTask: boolean;
  requestElapsedMs: number;
  imageAttached: boolean;
  encoder: "worker" | "main" | null;
  devicePixelRatio: number | null;
  scale: number | null;
  crop: { x: number; y: number; w: number; h: number } | null;
  canvas: { width: number; height: number } | null;
  phases: AskTimingProbe | null;
};

declare global {
  interface Window {
    __s4LongTasks?: LongTask[];
    __s4Marks?: { t0?: number };
    __s4Capture?: {
      encoder: "worker" | "main";
      mime: "image/webp" | "image/jpeg";
      bytes: number;
      devicePixelRatio: number;
      scale: number;
      crop: { x: number; y: number; w: number; h: number };
      canvas: { width: number; height: number };
    };
  }
}

/** Comma list from S4_AB, for example "noPrewarm,noSettle". Empty when unset. */
const AB_FLAGS = (process.env.S4_AB ?? "")
  .split(",")
  .map((flag) => flag.trim())
  .filter((flag) => flag.length > 0);

function abScript(): string {
  const flags = {
    noPrewarm: AB_FLAGS.includes("noPrewarm"),
    noDoubleRaf: AB_FLAGS.includes("noDoubleRaf"),
    noSettle: AB_FLAGS.includes("noSettle"),
  };
  return `window.__ASK_AB__ = ${JSON.stringify(flags)};`;
}

const OUT_DIR = process.env.S4_OUT_DIR ?? "/workspace/logs/gavin-s4-capture";
const LABEL = process.env.S4_LABEL ?? "run";

async function installLongTaskObserver(page: Page) {
  if (AB_FLAGS.length > 0) await page.addInitScript(abScript());
  await page.addInitScript(() => {
    window.__ASK_TIMING__ = {};
    window.__s4LongTasks = [];
    window.__s4Marks = {};
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        window.__s4LongTasks?.push({ start: entry.startTime, duration: entry.duration });
      }
    });
    observer.observe({ type: "longtask", buffered: true });
  });
}

async function measureCapture(page: Page, width: number) {
  test.setTimeout(120_000);
  await installLongTaskObserver(page);

  let imageAttached = false;
  let requestElapsedMs = 0;
  let received: () => void = () => {};
  const asked = new Promise<void>((resolve) => {
    received = resolve;
  });

  await mockAsk(page, async (route) => {
    const body = route.request().postDataJSON() as { image?: unknown };
    imageAttached = body.image != null;
    requestElapsedMs = await page.evaluate(() => {
      const t0 = window.__s4Marks?.t0 ?? 0;
      return performance.now() - t0;
    });
    received();
    await route.fulfill({
      status: 200,
      contentType: "application/x-ndjson",
      body: askStream("s1"),
    });
  });

  await startGenerated(page);
  await pauseLecture(page);
  await enterSelection(page);
  if (width === 390) await dragOnSubtitle(page);
  else await dragOnStage(page);

  const panel = page.locator("[data-ask-panel]");
  await panel.locator("[data-ask-question]").fill(QUESTION);

  const client = await page.context().newCDPSession(page);
  await client.send("Emulation.setCPUThrottlingRate", { rate: 4 });

  mkdirSync(OUT_DIR, { recursive: true });
  const tracePath = path.join(OUT_DIR, `${LABEL}-${width}.trace.zip`);
  // playwright.config.ts sets trace: "retain-on-failure", which already called tracing.start.
  // A second start throws "Tracing has already been started". Stop that session (discard the
  // pre-click chunk), then start again so the submit window is the recorded trace.
  const priorChunk = path.join(OUT_DIR, `.${LABEL}-${width}.prior.trace.zip`);
  await page.context().tracing.stopChunk({ path: priorChunk });
  await page.context().tracing.stop();
  rmSync(priorChunk, { force: true });
  await page.context().tracing.start({ screenshots: true, snapshots: true, title: `s4-capture-${width}` });

  try {
    await page.evaluate(() => {
      window.__s4LongTasks = [];
      window.__s4Marks = window.__s4Marks ?? {};
      window.__s4Marks.t0 = performance.now();
    });

    await panel.locator("[data-ask-submit]").click();
    await page.waitForTimeout(50);
    await page.screenshot({
      path: path.join(OUT_DIR, `${LABEL}-${width}-after-click.png`),
    });

    await asked;
    await page.waitForTimeout(500);

    const longTasks = await page.evaluate(() => {
      const t0 = window.__s4Marks?.t0 ?? 0;
      return (window.__s4LongTasks ?? []).filter((task) => task.start >= t0);
    });
    const capture = await page.evaluate(() => window.__s4Capture ?? null);
    const encoder = capture?.encoder ?? null;
    const geometry: CaptureGeometry | null = capture
      ? {
          devicePixelRatio: capture.devicePixelRatio,
          scale: capture.scale,
          crop: capture.crop,
          canvas: capture.canvas,
        }
      : null;
    const phases = await page.evaluate(() => window.__ASK_TIMING__ ?? null);
    if (test.info().project.name === "chromium" && !AB_FLAGS.includes("noPrewarm")) {
      expect(encoder).toBe("worker");
    }
    const longestTaskMs = longTasks.reduce((max, task) => Math.max(max, task.duration), 0);
    const captureStart = phases?.captureStart ?? null;
    const longTaskEnd = phases?.longTaskEnd ?? null;
    const overlapping =
      captureStart == null || longTaskEnd == null
        ? []
        : longTasks.filter((task) => task.start < longTaskEnd && task.start + task.duration > captureStart);
    const domToCanvasLongTaskMaxMs = overlapping.reduce((max, task) => Math.max(max, task.duration), 0);
    const summary: PerfSummary = {
      width,
      ab: AB_FLAGS,
      longestTaskMs,
      longTaskCount: longTasks.length,
      longTasks,
      domToCanvasLongTaskCount: overlapping.length,
      domToCanvasLongTaskMaxMs,
      domToCanvasSingleLongTask: overlapping.length === 1,
      requestElapsedMs,
      imageAttached,
      encoder,
      devicePixelRatio: geometry?.devicePixelRatio ?? null,
      scale: geometry?.scale ?? null,
      crop: geometry?.crop ?? null,
      canvas: geometry?.canvas ?? null,
      phases,
    };

    writeFileSync(path.join(OUT_DIR, `${LABEL}-${width}.json`), `${JSON.stringify(summary, null, 2)}\n`);
    console.log(
      JSON.stringify({
        label: LABEL,
        ab: AB_FLAGS,
        width,
        longestTaskMs,
        domToCanvasMs: phases?.domToCanvasMs ?? null,
        domToCanvasLongTaskCount: overlapping.length,
        domToCanvasLongTaskMaxMs,
        domToCanvasSingleLongTask: overlapping.length === 1,
        requestElapsedMs,
        longTaskCount: longTasks.length,
        imageAttached,
        encoder,
        devicePixelRatio: geometry?.devicePixelRatio ?? null,
        scale: geometry?.scale ?? null,
        crop: geometry?.crop ?? null,
        canvas: geometry?.canvas ?? null,
        phases,
        submitAt: phases?.submitAt ?? null,
        preCaptureMs: phases?.preCaptureMs ?? null,
        workerInitAt: phases?.workerInitAt ?? null,
        workerReadyAt: phases?.workerReadyAt ?? null,
        cancelPaintAfterReleaseMs: phases?.cancelPaintAfterReleaseMs ?? null,
      }),
    );
    console.log(
      `[s4-capture] ${LABEL} ${width}px longest=${longestTaskMs.toFixed(1)}ms count=${longTasks.length} elapsed=${requestElapsedMs.toFixed(1)}ms image=${imageAttached} encoder=${encoder}`,
    );

    await page.screenshot({
      path: path.join(OUT_DIR, `${LABEL}-${width}-end.png`),
    });
  } finally {
    await client.send("Emulation.setCPUThrottlingRate", { rate: 1 }).catch(() => {});
    await page.context().tracing.stop({ path: tracePath });
  }
}

/**
 * Press and release 取消 while the preparing row is up. The panel stamps
 * cancelPointerUpAt on that pointerup and cancelPaintAt on the next frame
 * after the cancelled state renders.
 */
async function measureCancelPaint(page: Page, width: number) {
  test.setTimeout(120_000);
  await installLongTaskObserver(page);

  await mockAsk(page, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/x-ndjson",
      body: askStream("s1"),
    });
  });

  await startGenerated(page);
  await pauseLecture(page);
  await enterSelection(page);
  if (width === 390) await dragOnSubtitle(page);
  else await dragOnStage(page);

  const panel = page.locator("[data-ask-panel]");
  await panel.locator("[data-ask-question]").fill(QUESTION);
  await panel.locator("[data-ask-submit]").click();
  const preparing = page.locator("[data-ask-capture-preparing]");
  await expect(preparing).toBeAttached({ timeout: 15_000 });

  const cancel = page.locator("[data-ask-cancel]");
  const box = await cancel.boundingBox();
  if (!box) throw new Error("取消 has no box while preparing");
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.up();

  await expect(page.locator("[data-ask-panel]")).toHaveCount(0, { timeout: 15_000 });
  await page.waitForTimeout(50);
  const phases = await page.evaluate(() => window.__ASK_TIMING__ ?? null);
  const summary = {
    width,
    ab: AB_FLAGS,
    kind: "cancel-paint",
    cancelPointerUpAt: phases?.cancelPointerUpAt ?? null,
    cancelPointerUpDispatchAt: phases?.cancelPointerUpDispatchAt ?? null,
    cancelPaintAt: phases?.cancelPaintAt ?? null,
    cancelPaintAfterReleaseMs: phases?.cancelPaintAfterReleaseMs ?? null,
    phases,
  };
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(
    path.join(OUT_DIR, `${LABEL}-${width}-cancel.json`),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  console.log(
    JSON.stringify({
      label: LABEL,
      ab: AB_FLAGS,
      width,
      kind: "cancel-paint",
      cancelPointerUpAt: phases?.cancelPointerUpAt ?? null,
      cancelPointerUpDispatchAt: phases?.cancelPointerUpDispatchAt ?? null,
      cancelPaintAfterReleaseMs: phases?.cancelPaintAfterReleaseMs ?? null,
    }),
  );
}

test.describe("S4-a capture perf", () => {
  test.skip(process.env.S4_PERF !== "1", "set S4_PERF=1 to measure ask-submit capture");

  test.describe("1280x800", () => {
    test.use({ viewport: { width: 1280, height: 800 } });

    test("submit capture long tasks at 1280x800", async ({ page }) => {
      await measureCapture(page, 1280);
    });

    test("cancel during preparing paints at 1280x800", async ({ page }) => {
      await measureCancelPaint(page, 1280);
    });
  });

  test.describe("390x844", () => {
    test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

    test("submit capture long tasks at 390x844", async ({ page }) => {
      await measureCapture(page, 390);
    });

    test("cancel during preparing paints at 390x844", async ({ page }) => {
      await measureCancelPaint(page, 390);
    });
  });
});
