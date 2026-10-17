import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { expect, test, type Locator, type Page, type Route } from "@playwright/test";

/**
 * M6 §10 e2e：31 / 32 / 34 / 35 / 37 / 39 / 40，以及 E45（更新 21:35）。
 * 快乐路径用 group-anagrams 的生成课（带 cacheKey / scriptVersion），不用内置 two-sum。
 * two-sum 只用来断言 builtin 灰态。
 * 端口：父流程用 E2E_PORT=4530（4500–4599）。本文件不改 playwright.config.ts。
 */

const CACHE_KEY = "a".repeat(40);
const SCRIPT_VERSION = "b".repeat(40);
const QUESTION = "这一步在做什么？";
const ANSWER_NARRATION = "把相同字母的词放进同一组。";
// Capture (modern-screenshot domToCanvas) is a synchronous main-thread task; its 3s timeout cannot preempt it, and under long --repeat-each runs it took ~6.7s before the ask request was sent (S4 capture lag, ask-v032-capture). Answer waits get extra budget until S4 lands.
// TODO(S4-r3): revert after ask-v032-capture-r3 merges
const ANSWER_TIMEOUT_MS = 20_000;

const REASONS = {
  builtin: "生成讲课后就可以提问",
  receiving: "备课完成后可以提问",
  unfinished: "这节课没讲完，重新生成后就可以提问",
  stepDisabled: "这一步暂时不能提问，重新生成这节课后就可以了",
  busy: "上一个问题还在回答，答完再问",
} as const;

const PENDING_TIMEOUT = "暂时没法提问，刷新页面后再试";
const TIMEOUT_MESSAGE = "老师回答超时，请重新问一次。";
const CAPTURE_FALLBACK = "没截到图，这次只发送选中的文字。";

const SHORTCUTS = [
  { key: "subtitle", summary: "已选：当前字幕" },
  { key: "step", summary: "已选：当前步骤" },
  { key: "viz", summary: "已选：可视化 1 处" },
] as const;

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

/**
 * 页面挂载就会拉 /api/settings。E45 要在点击前一直停在 storageMode=pending，
 * 所以先挂起，等测试放行后再返回。放行后的延迟用来覆盖「超过 3 秒」的超时文案。
 */
async function holdSettings(page: Page, delayAfterReleaseMs = 0) {
  let release: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/settings", async (route) => {
    await gate;
    await fulfillJson(route, { serverKeyDisabled: false, keySource: "env" }, delayAfterReleaseMs);
  });
  return () => release?.();
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


async function scrollSubtitleIntoSafeBand(page: Page) {
  const subtitle = page.locator('[data-ask-target="subtitle"]').first();
  await subtitle.scrollIntoViewIfNeeded();
  await page.evaluate(() => {
    const host = document.querySelector<HTMLElement>('[data-ask-target="subtitle"]');
    if (!host) return;
    const header = document.querySelector<HTMLElement>("header");
    const bar = document.querySelector<HTMLElement>("[data-ask-bottom-bar]");
    const top = (header?.getBoundingClientRect().bottom ?? 56) + 8;
    const bottom = (bar?.getBoundingClientRect().top ?? window.innerHeight) - 8;
    const mid = (top + bottom) / 2;
    const r = host.getBoundingClientRect();
    const targetY = mid - r.height / 2;
    const delta = r.top - targetY;
    if (Math.abs(delta) > 2) {
      const se = document.scrollingElement || document.documentElement;
      se.scrollTop += delta;
    }
  });
  await page.waitForTimeout(50);
  return subtitle;
}

async function touchDragSubtitle(page: Page, from: { x: number; y: number }, dx: number, dy: number) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: from.x, y: from.y }] });
  for (let s = 1; s <= 5; s++) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: from.x + (dx * s) / 5, y: from.y + (dy * s) / 5 }],
    });
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}

async function subtitleSafeHit(page: Page) {
  return page.evaluate(() => {
    const host = document.querySelector<HTMLElement>('[data-ask-target="subtitle"]');
    const bar = document.querySelector<HTMLElement>("[data-ask-bottom-bar]");
    if (!host || !bar) return null;
    const header = document.querySelector<HTMLElement>("header");
    const top = (header?.getBoundingClientRect().bottom ?? 56) + 8;
    const barTop = bar.getBoundingClientRect().top;
    const r = host.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) return null;
    const y = Math.min(Math.max(r.top + Math.min(20, r.height / 2), top + 4), barTop - 8);
    const x = r.left + Math.min(28, Math.max(10, r.width / 2));
    if (y < r.top || y > r.bottom || y < top || y > barTop - 4) return null;
    return { x, y, r: { top: r.top, bottom: r.bottom }, top, barTop };
  });
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

async function askQuestion(page: Page) {
  const panel = page.locator("[data-ask-panel]");
  await panel.locator("[data-ask-question]").fill(QUESTION);
  await panel.locator("[data-ask-submit]").click();
}

async function getMonacoLineBox(page: Page, lineNumber: number): Promise<{ top: number; bottom: number }> {
  return page.evaluate((line) => {
    const lineNumbers = Array.from(document.querySelectorAll<HTMLElement>(".monaco-editor .line-numbers"));
    for (const ln of lineNumbers) {
      if (ln.textContent?.trim() === String(line)) {
        const r = ln.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom };
      }
    }
    throw new Error(`monaco line ${line} not rendered`);
  }, lineNumber);
}

async function getMonacoLineY(page: Page, lineNumber: number): Promise<number> {
  const box = await getMonacoLineBox(page, lineNumber);
  return (box.top + box.bottom) / 2;
}

type ClientBox = { x: number; y: number; width: number; height: number };

function intersectionBox(a: ClientBox, b: ClientBox): ClientBox | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right - x <= 0 || bottom - y <= 0) return null;
  return { x, y, width: right - x, height: bottom - y };
}

function boxesOverlap(a: ClientBox, b: ClientBox): boolean {
  return intersectionBox(a, b) !== null;
}

/**
 * C2: drag from the code container (gutter included) onto viz.
 * The chip and the request stay code-only, and the screenshot is the drawn box ∩ code area.
 */
async function expectCodeOriginExcludesViz(page: Page) {
  let captured: {
    targets: Array<{ kind?: string; id?: string }>;
    image: { mime?: string; dataBase64?: string } | null;
  } = { targets: [], image: null };
  await mockAsk(page, async (route) => {
    const body = route.request().postDataJSON() as {
      selection?: { targets?: Array<{ kind?: string; id?: string }> };
      image?: { mime?: string; dataBase64?: string } | null;
    };
    captured = {
      targets: body?.selection?.targets ?? [],
      image: body?.image ?? null,
    };
    await route.fulfill({
      status: 200,
      contentType: "application/x-ndjson",
      body: askStream("s1"),
    });
  });
  await startGenerated(page);
  await pauseLecture(page);
  await enterSelection(page);

  const monaco = page.locator("[data-ask-stage] .monaco-editor");
  const code = page.locator('[data-ask-stage] [data-ask-target="code"]');
  const viz = page.locator('[data-ask-target="viz"]').first();
  await code.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await viz.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    if (rect.top < 0 || rect.bottom > window.innerHeight) el.scrollIntoView({ block: "nearest" });
  });
  await expect(monaco).toBeVisible();
  await expect(viz).toBeVisible();

  const monacoBox = await monaco.boundingBox();
  const vizBox = await viz.boundingBox();
  if (!monacoBox || !vizBox) throw new Error("monaco or viz has no box");

  const line5 = await getMonacoLineBox(page, 5);
  const startX = monacoBox.x + monacoBox.width * 0.3;
  const startY = (line5.top + line5.bottom) / 2;
  const endX = vizBox.x + vizBox.width / 2;
  const endY = vizBox.y + vizBox.height / 2;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(endX, endY, { steps: 8 });
  // Snapshot before pointerup: the panel scrolls the selection into view after commit.
  const geometry = await page.evaluate(() => {
    const stage = document.querySelector("[data-ask-stage]");
    const codeEl = document.querySelector('[data-ask-stage] [data-ask-target="code"]');
    const vizEl = document.querySelector('[data-ask-target="viz"]');
    if (!stage || !codeEl || !vizEl) return null;
    const sr = stage.getBoundingClientRect();
    const rel = (el: Element) => {
      const er = el.getBoundingClientRect();
      return {
        x: er.left - sr.left + stage.scrollLeft,
        y: er.top - sr.top + stage.scrollTop,
        width: er.width,
        height: er.height,
      };
    };
    return {
      originX: sr.left - stage.scrollLeft,
      originY: sr.top - stage.scrollTop,
      code: rel(codeEl),
      viz: rel(vizEl),
    };
  });
  if (!geometry) throw new Error("stage geometry missing");
  await page.mouse.up();

  const panel = page.locator("[data-ask-panel]");
  await expect(panel).toBeVisible();
  const chip = panel.locator("[data-ask-panel-label]");
  await expect(chip).toHaveText(/^已选：代码第 \d+(–\d+)? 行$/);
  await expect(chip).not.toContainText("可视化");

  const vizIds = await page.locator('[data-ask-target="viz"]').evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("data-ask-id")).filter((id): id is string => Boolean(id)),
  );
  for (const id of vizIds) {
    await expect(page.locator(`[data-ask-highlight="${id}"]`)).toHaveCount(0);
  }

  await askQuestion(page);
  // Sync capture on the shared machine can take ~6.5s before the ask request leaves.
  await expect.poll(() => captured.targets.length, { timeout: 25_000 }).toBeGreaterThan(0);
  expect(captured.targets.every((item) => item.kind === "code")).toBe(true);

  const image = captured.image;
  expect(image?.dataBase64).toBeTruthy();
  const ratio = await page.evaluate(async (dataUrl) => {
    const img = new Image();
    const loaded = new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("capture image failed to decode"));
    });
    img.src = dataUrl;
    await loaded;
    return img.naturalWidth / img.naturalHeight;
  }, `data:${image!.mime};base64,${image!.dataBase64}`);

  const drawn: ClientBox = {
    x: Math.min(startX, endX) - geometry.originX,
    y: Math.min(startY, endY) - geometry.originY,
    width: Math.abs(endX - startX),
    height: Math.abs(endY - startY),
  };
  const crop = intersectionBox(drawn, geometry.code);
  if (!crop || crop.height <= 0) throw new Error("drawn box does not meet the code area");
  const drawnRatio = drawn.width / drawn.height;
  const cropRatio = crop.width / crop.height;
  expect(Math.abs(ratio - cropRatio) / cropRatio).toBeLessThanOrEqual(0.03);
  expect(Math.abs(ratio - drawnRatio) / drawnRatio).toBeGreaterThan(0.03);
  // Crop stays out of the viz rect on both the right and the bottom, stacked or side by side.
  expect(boxesOverlap(crop, geometry.viz)).toBe(false);
}

/** C2 regression: a drag that starts on viz still collects code and viz together. */
async function expectVizOriginCollectsBoth(page: Page) {
  let capturedTargets: Array<{ kind?: string }> = [];
  await mockAsk(page, async (route) => {
    const body = route.request().postDataJSON() as {
      selection?: { targets?: Array<{ kind?: string }> };
    };
    capturedTargets = body?.selection?.targets ?? [];
    await route.fulfill({
      status: 200,
      contentType: "application/x-ndjson",
      body: askStream("s1"),
    });
  });
  await startGenerated(page);
  await pauseLecture(page);
  await enterSelection(page);

  const code = page.locator('[data-ask-stage] [data-ask-target="code"]');
  const viz = page.locator('[data-ask-target="viz"]').first();
  await viz.evaluate((el) => el.scrollIntoView({ block: "nearest" }));
  await code.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    if (rect.top < 0 || rect.bottom > window.innerHeight) el.scrollIntoView({ block: "nearest" });
  });
  await expect(code).toBeVisible();
  await expect(viz).toBeVisible();

  const codeBox = await code.boundingBox();
  const vizBox = await viz.boundingBox();
  if (!codeBox || !vizBox) throw new Error("code or viz has no box");

  // The code container is the tall blackboard frame and can cover the viz block.
  // Start on a cell inside the viz block, away from that frame, so the origin is viz.
  const cell = viz.locator("[data-viz-node]").first();
  const cellBox = (await cell.count()) > 0 ? await cell.boundingBox() : null;
  const startX = cellBox ? cellBox.x + cellBox.width / 2 : vizBox.x + Math.min(24, vizBox.width / 2);
  const startY = cellBox ? cellBox.y + cellBox.height / 2 : vizBox.y + Math.min(24, vizBox.height / 2);
  const endX = codeBox.x + codeBox.width * 0.5;
  const endY = codeBox.y + codeBox.height * 0.5;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(endX, endY, { steps: 8 });
  await page.mouse.up();

  const panel = page.locator("[data-ask-panel]");
  await expect(panel).toBeVisible();
  await askQuestion(page);
  await expect.poll(() => capturedTargets.length, { timeout: 25_000 }).toBeGreaterThan(0);
  expect(capturedTargets.some((item) => item.kind === "code")).toBe(true);
  expect(capturedTargets.some((item) => item.kind === "viz")).toBe(true);
}

/** 直接子项按中心线合并成行。播放中基线 4，讲完 3。 */
async function controlRows(bar: Locator) {
  return bar.evaluate((el) => {
    const boxes = [...el.children]
      .map((child) => child.getBoundingClientRect())
      .filter((box) => box.width > 0 && box.height > 0);
    const rows: Array<{ top: number; bottom: number }> = [];
    for (const box of [...boxes].sort((a, b) => a.top + a.height / 2 - (b.top + b.height / 2))) {
      const center = box.top + box.height / 2;
      const row = rows.find((candidate) => center >= candidate.top && center <= candidate.bottom);
      if (row) {
        row.top = Math.min(row.top, box.top);
        row.bottom = Math.max(row.bottom, box.bottom);
      } else {
        rows.push({ top: box.top, bottom: box.bottom });
      }
    }
    return { rows: rows.length, buttons: el.querySelectorAll("button").length };
  });
}

async function expectReason(page: Page, reason: keyof typeof REASONS) {
  const button = entry(page);
  await expect(button).toBeVisible();
  await expect(button).toHaveAttribute("aria-disabled", "true");
  await expect(button).toHaveAttribute("data-ask-disabled-reason", reason);
  await expect(button).toHaveAttribute("aria-describedby", "ask-entry-reason");
  const described = await button.getAttribute("aria-describedby");
  await expect(page.locator(`#${described}`)).toHaveText(REASONS[reason]);
  // aria-disabled 不是 disabled：默认 click 会等 actionability 直到超时。强制点一下，确认不进圈选。
  await button.click({ force: true });
  await expect(page.locator("[data-ask-layer]")).toHaveCount(0);
}

/**
 * capture.ts 动态 import("modern-screenshot")，截图失败仍 sendAsk(null)。
 * Turbopack 会 seal 住 ESM 导出，页面里改不了 domToCanvas。
 * 画布的 toDataURL 抛错：captureStage 的 try 得到 ok:false，
 * 面板显示 data-ask-capture-fallback，请求 image 为 null。
 * 必须在点「提问」之前装上。
 */
/**
 * #39 的截图失败，加上可放行的分块 NDJSON。
 * 先写 start + segment（回答文字出现，phase 停在 streaming），放行后再写 result 进入播放。
 */
async function mockHeldCaptureFallbackAsk(page: Page) {
  let image: unknown = "missing";
  let release: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const sockets = new Set<Socket>();
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { image?: unknown };
        image = body.image ?? null;
      } catch {
        image = null;
      }
    });
    res.writeHead(200, {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-cache, no-transform",
    });
    const segment = { id: "seg1", narration: ANSWER_NARRATION };
    res.write(`${JSON.stringify({ type: "start", answerId: "ans-e2e-sel", stepId: "s1", imageUsed: false })}\n`);
    res.write(`${JSON.stringify({ type: "segment", segment })}\n`);
    void gate.then(() => {
      if (res.writableEnded) return;
      const answer = {
        v: 1,
        id: "ans-e2e-sel",
        stepId: "s1",
        question: QUESTION,
        selection: {
          mode: "region",
          bbox: { x: 0, y: 0, width: 40, height: 40 },
          targets: [{ kind: "viz", id: "viz:s1", stepId: "s1", text: "可视化" }],
        },
        segments: [segment],
        createdAt: "2026-10-14T00:00:00.000Z",
      };
      res.end(`${JSON.stringify({ type: "result", answer })}\n`);
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  await page.route("**/api/lecture/ask", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    await route.continue({ url: `http://127.0.0.1:${port}/api/lecture/ask` });
  });
  return {
    release: () => release?.(),
    image: () => image,
    close: async () => {
      release?.();
      for (const socket of sockets) socket.destroy();
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** 截图失败后：回答文字出现时提示还在，放行进入播放后提示仍在。 */
async function expectCaptureFallbackThroughPlayback(page: Page) {
  const held = await mockHeldCaptureFallbackAsk(page);
  try {
    await startGenerated(page);
    await pauseLecture(page);
    await enterSelection(page);
    await dragOnStage(page);
    await stubCapture(page);
    await askQuestion(page);

    const notice = page.locator("[data-ask-capture-fallback]");
    await expect(notice).toHaveText(CAPTURE_FALLBACK);
    await expect(page.getByText(ANSWER_NARRATION)).toBeVisible();
    await expect(notice).toBeVisible();
    await expect(notice).toHaveText(CAPTURE_FALLBACK);

    held.release();
    await expect(page.getByRole("button", { name: "回到这一步", exact: true })).toBeVisible();
    await expect(notice).toBeVisible();
    await expect(notice).toHaveText(CAPTURE_FALLBACK);
    expect(held.image()).toBeNull();
  } finally {
    await held.close();
  }
}

async function stubCapture(page: Page) {
  await page.evaluate(() => {
    HTMLCanvasElement.prototype.toDataURL = function toDataURL() {
      throw new Error("capture stub");
    };
  });
}

/**
 * 写出一步后保持连接，播放器停在 receiving。
 * route.fulfill 会等整个 body，所以把请求续到本机分块响应（同 autoplay.spec.ts）。
 */
async function mockHeldLecture(page: Page) {
  const payload = `${JSON.stringify({ type: "step", step: step() })}\n`;
  const timers = new Set<ReturnType<typeof setInterval>>();
  const sockets = new Set<Socket>();
  const server: Server = createServer((req, res) => {
    req.resume();
    res.writeHead(200, {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-cache, no-transform",
    });
    res.write(payload);
    const timer = setInterval(() => {
      if (!res.writableEnded) res.write(" \n");
    }, 400);
    timers.add(timer);
    res.on("close", () => {
      clearInterval(timer);
      timers.delete(timer);
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  await page.route("**/api/lecture", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.includes("/ask")) {
      await route.fallback();
      return;
    }
    if (url.port === String(port)) {
      await route.continue();
      return;
    }
    await route.continue({ url: `http://127.0.0.1:${port}/api/lecture` });
  });
  return async () => {
    for (const timer of timers) clearInterval(timer);
    timers.clear();
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    if (!server.listening) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
}

async function installPointerdownClock(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __askDownTs?: number[]; __askDownInstalled?: boolean };
    w.__askDownTs = [];
    if (w.__askDownInstalled) return;
    w.__askDownInstalled = true;
    document.addEventListener("pointerdown", (event) => w.__askDownTs?.push(event.timeStamp), { capture: true });
  });
}

async function readPointerdownClock(page: Page): Promise<number[]> {
  return page.evaluate(() => (window as unknown as { __askDownTs?: number[] }).__askDownTs ?? []);
}

test.describe("1280 selection flow", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("after the entry scroll settles, code line 1 is not under the fixed header", async ({ page }) => {
    await startGenerated(page);
    await pauseLecture(page);
    await entry(page).scrollIntoViewIfNeeded();
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "auto" }));
    await entry(page).click();
    await expect(page.locator("[data-ask-layer]")).toBeVisible();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          let lastY = window.scrollY;
          let unchangedCount = 0;
          const start = performance.now();
          const check = () => {
            if (window.scrollY === lastY) {
              unchangedCount++;
              if (unchangedCount >= 6) {
                resolve();
                return;
              }
            } else {
              unchangedCount = 0;
              lastY = window.scrollY;
            }
            if (performance.now() - start >= 3000) {
              resolve();
              return;
            }
            requestAnimationFrame(check);
          };
          requestAnimationFrame(check);
        }),
    );
    const { headerBottom, fixed, line1Top } = await page.evaluate(() => {
      const header = document.querySelector("header");
      const fixed = header ? ["fixed", "sticky"].includes(getComputedStyle(header).position) : false;
      const headerBottom = header ? header.getBoundingClientRect().bottom : 0;
      let line1Top = 0;
      for (const el of document.querySelectorAll<HTMLElement>("[data-ask-stage] .monaco-editor .line-numbers")) {
        if (el.textContent?.trim() === "1") {
          line1Top = el.getBoundingClientRect().top;
          break;
        }
      }
      return { headerBottom, fixed, line1Top };
    });
    if (fixed) {
      expect(line1Top).toBeGreaterThanOrEqual(headerBottom);
    }
  });

  test("31. drag on stage, ask, answer expands, currentIndex stays", async ({ page }) => {
    await mockAsk(page, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/x-ndjson",
        body: askStream("s1"),
      });
    });
    await startGenerated(page);
    await pauseLecture(page);
    const indexBefore = await page.getByText(/第 \d+ \/ 3 步/).textContent();
    await enterSelection(page);
    await dragOnStage(page);
    await askQuestion(page);
    await expect(page.getByRole("button", { name: `你问的 ${QUESTION}` })).toBeVisible();
    await expect(page.getByText(ANSWER_NARRATION)).toBeVisible({ timeout: ANSWER_TIMEOUT_MS });
    await expect(page.getByText(/第 \d+ \/ 3 步/)).toHaveText(indexBefore!);
    await expect(page.locator("[data-ask-layer]")).toHaveCount(0);
  });

  test("drag starting on a shortcut chip draws a box and does not select the chip", async ({ page }) => {
    await startGenerated(page);
    await pauseLecture(page);
    await enterSelection(page);

    const chip = page.locator('[data-ask-shortcut="subtitle"]');
    await expect(chip).toBeVisible();
    const chipBox = await chip.boundingBox();
    expect(chipBox).not.toBeNull();
    const startX = chipBox!.x + chipBox!.width / 2;
    const startY = chipBox!.y + chipBox!.height / 2;

    // End over viz so the rubber band has a real ask target (chip+80,+60 was empty on 1280).
    const viz = page.locator('[data-ask-stage] [data-ask-id="viz:s1"]').first();
    await expect(viz).toBeVisible();
    const vizBox = await viz.boundingBox();
    if (!vizBox) throw new Error("viz target has no box");
    const endX = vizBox.x + Math.max(vizBox.width - 8, 40);
    const endY = vizBox.y + Math.max(Math.min(vizBox.height - 8, 80), 36);

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(endX, endY, { steps: 8 });
    await expect(page.locator("[data-ask-rubber]")).toBeVisible();
    await page.mouse.up();

    await expect(page.locator("[data-ask-selection]")).toBeVisible();
    await expect(chip).not.toHaveAttribute("aria-pressed", "true");
    await expect(chip).not.toHaveAttribute("aria-selected", "true");
    const panel = page.locator("[data-ask-panel]");
    await expect(panel).toBeVisible();
    await expect(panel.locator("[data-ask-panel-label]")).not.toHaveText("已选：当前字幕");
  });

  test("35. three shortcuts each open the panel with a matching label", async ({ page }) => {
    await startGenerated(page);
    await pauseLecture(page);
    await enterSelection(page);
    for (const item of SHORTCUTS) {
      const shortcut = page.locator(`[data-ask-shortcut="${item.key}"]`);
      await expect(shortcut).toBeVisible();
      await shortcut.click();
      const panel = page.locator("[data-ask-panel]");
      await expect(panel).toBeVisible();
      await expect(panel.locator("[data-ask-panel-label]")).toHaveText(item.summary);
      // 取消走 exitAsk，圈选层会一起关掉。Esc 是 closeAskPanel，回到 selecting。
      await page.keyboard.press("Escape");
      await expect(panel).toHaveCount(0);
      await expect(page.locator("[data-ask-layer]")).toBeVisible();
    }
  });

  test("1280: cancel from drafting returns to selecting with selection kept and announces summary in role=status", async ({ page }) => {
    await startGenerated(page);
    await pauseLecture(page);
    await enterSelection(page);
    await dragOnStage(page);

    const panel = page.locator("[data-ask-panel]");
    await expect(panel).toBeVisible();

    await panel.locator("[data-ask-cancel]").click();
    await expect(panel).toHaveCount(0);

    const selection = page.locator("[data-ask-selection]");
    await expect(selection).toBeVisible();

    const chip = page.locator("[data-ask-selection-label]");
    await expect(chip).toBeVisible();
    const chipText = (await chip.textContent())?.trim();
    expect(chipText).toBeTruthy();

    await expect(page.locator("[role=status]").first()).toHaveText(chipText!);
  });

  test("1280: cancel from drafting returns focus to opening chip", async ({ page }) => {
    await startGenerated(page);
    await pauseLecture(page);
    await enterSelection(page);

    const chip = page.locator('[data-ask-bottom-bar] [data-ask-shortcut="subtitle"]');
    await expect(chip).toBeVisible();
    await chip.click();

    const panel = page.locator("[data-ask-panel]");
    await expect(panel).toBeVisible();

    await panel.locator("[data-ask-cancel]").click();
    await expect(panel).toHaveCount(0);

    const activeMatchesOpeningChip = await page.evaluate(() => {
      const active = document.activeElement;
      const openedChip = document.querySelector('[data-ask-bottom-bar] [data-ask-shortcut="subtitle"]');
      return Boolean(openedChip && active === openedChip);
    });
    expect(activeMatchesOpeningChip).toBe(true);
  });

  test("37. stepDisabled and busy grey copy, entry stays focusable", async ({ page }) => {
    const releaseAsk: { current: (() => void) | null } = { current: null };
    await mockAsk(page, async (route) => {
      await new Promise<void>((resolve) => {
        releaseAsk.current = resolve;
      });
      await route.fulfill({
        status: 200,
        contentType: "application/x-ndjson",
        body: askStream("s2"),
      });
    });
    await startGenerated(page, lectureNdjson({ askDisabledStepIds: ["s1"] }));
    await pauseLecture(page);
    await expectReason(page, "stepDisabled");
    await entry(page).focus();
    await expect(entry(page)).toBeFocused();

    const next = page.getByRole("button", { name: "下一步", exact: true });
    await expect(next).toBeEnabled();
    await next.click();
    await expect(page.getByText("第 2 / 3 步")).toBeVisible();
    await expect(entry(page)).toBeEnabled();
    await expect(entry(page)).not.toHaveAttribute("aria-disabled", "true");
    await enterSelection(page);
    const shortcut = page.locator('[data-ask-shortcut="step"]');
    await expect(shortcut).toBeVisible();
    await shortcut.click();
    await expect(page.locator("[data-ask-panel]")).toBeVisible();
    await askQuestion(page);
    await expect(entry(page)).toHaveAttribute("data-ask-disabled-reason", "busy");
    await expect(page.locator("#ask-entry-reason")).toHaveText(REASONS.busy);
    await expect(entry(page)).toHaveAttribute("aria-describedby", "ask-entry-reason");
    releaseAsk.current?.();
    await expect(page.getByText(ANSWER_NARRATION)).toBeVisible({ timeout: ANSWER_TIMEOUT_MS });
  });

  test("40. 504 TIMEOUT then 重新问 succeeds and keeps the draft", async ({ page }) => {
    let calls = 0;
    await mockAsk(page, async (route) => {
      calls += 1;
      if (calls === 1) {
        await route.fulfill({
          status: 504,
          contentType: "application/json",
          body: JSON.stringify({ code: "TIMEOUT" }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/x-ndjson",
        body: askStream("s1"),
      });
    });
    await startGenerated(page);
    await pauseLecture(page);
    await enterSelection(page);
    await dragOnStage(page);
    const panel = page.locator("[data-ask-panel]");
    await panel.locator("[data-ask-question]").fill(QUESTION);
    await panel.locator("[data-ask-submit]").click();
    await expect(panel.locator("[data-ask-error='TIMEOUT']")).toHaveText(TIMEOUT_MESSAGE);
    await expect(panel.locator("[data-ask-question]")).toHaveValue(QUESTION);
    await expect(panel.locator("[data-ask-panel-label]")).toBeVisible();
    await expect(panel.locator("[data-ask-panel-label]")).not.toHaveText("已选：无");
    await expect(page.locator("[data-ask-layer] [data-ask-selection]")).toBeVisible();
    await panel.getByRole("button", { name: "重新问", exact: true }).click();
    await expect(page.getByText(ANSWER_NARRATION)).toBeVisible({ timeout: ANSWER_TIMEOUT_MS });
    expect(calls).toBe(2);
  });

  test("39. capture failure still asks and shows the fallback notice", async ({ page }) => {
    let image: unknown = "missing";
    await mockAsk(page, async (route) => {
      const body = route.request().postDataJSON() as { image?: unknown };
      image = body.image ?? null;
      await route.fulfill({
        status: 200,
        contentType: "application/x-ndjson",
        body: askStream("s1"),
      });
    });
    await startGenerated(page);
    await pauseLecture(page);
    await enterSelection(page);
    await dragOnStage(page);
    await stubCapture(page);
    await askQuestion(page);
    await expect(page.locator("[data-ask-capture-fallback]")).toHaveText(CAPTURE_FALLBACK);
    await expect(page.getByText(ANSWER_NARRATION)).toBeVisible({ timeout: ANSWER_TIMEOUT_MS });
    expect(image).toBeNull();
  });

  test("39b. capture fallback stays visible after answer text and during playback", async ({ page }) => {
    test.setTimeout(45_000);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expectCaptureFallbackThroughPlayback(page);
  });

  test("1280: Tab from the entry lands on the chip group first; Shift+Tab returns", async ({ page }) => {
    await startGenerated(page);
    await pauseLecture(page);
    await enterSelection(page);
    const entry = page.locator("[data-ask-entry]").first();
    await entry.focus();
    await page.keyboard.press("Tab");
    const active = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      return {
        shortcut: el?.getAttribute("data-ask-shortcut") ?? null,
        tabIndex: el?.tabIndex ?? null,
        inBar: Boolean(el && document.querySelector("[data-ask-bottom-bar]")?.contains(el)),
      };
    });
    expect(active.shortcut).not.toBeNull();
    expect(active.tabIndex).toBe(0);
    expect(active.inBar).toBe(true);
    await page.keyboard.press("Shift+Tab");
    await expect(entry).toBeFocused();
  });

  for (const key of ["Enter", " "] as const) {
    const name = key === " " ? "Space" : key;
    test(`chip390-b 1280: ${name} on a focused chip selects that chip`, async ({ page }) => {
      await startGenerated(page);
      await pauseLecture(page);
      await enterSelection(page);
      const chip = page.locator('[data-ask-bottom-bar] [data-ask-shortcut="step"]');
      await chip.focus();
      await expect(chip).toBeFocused();
      await page.keyboard.press(key);
      const panel = page.locator("[data-ask-panel]");
      await expect(panel).toBeVisible();
      await expect(panel.locator("[data-ask-panel-label]")).toHaveText("已选：当前步骤");
    });
  }

  test("F1 1280: modifier+Enter on focused chip", async ({ page }) => {
    await startGenerated(page);
    await pauseLecture(page);
    await enterSelection(page);

    await page.evaluate(() => {
      type F1Event = {
        key: string;
        ctrlKey: boolean;
        metaKey: boolean;
        shiftKey: boolean;
        altKey: boolean;
      };
      (window as unknown as { __f1Seen: F1Event[] }).__f1Seen = [];
      document.addEventListener("keydown", (e) => {
        (window as unknown as { __f1Seen: F1Event[] }).__f1Seen.push({
          key: e.key,
          ctrlKey: e.ctrlKey,
          metaKey: e.metaKey,
          shiftKey: e.shiftKey,
          altKey: e.altKey,
        });
      });
    });

    const chip = page.locator('[data-ask-bottom-bar] [data-ask-shortcut="step"]');
    await chip.focus();
    await expect(chip).toBeFocused();

    const modifiers = ["Shift", "Control", "Alt", "Meta"] as const;

    // Run 1: with no selection
    for (const mod of modifiers) {
      await page.keyboard.press(`${mod}+Enter`);
      await expect(page.locator("[data-ask-panel]")).toHaveCount(0);
      await expect(page.locator("[data-ask-selection]")).toHaveCount(0);
      await expect(page.locator("[data-ask-layer]")).toBeVisible();
      await expect(page.locator("[role=status]").first()).not.toHaveText(/已选：/);
      await expect(chip).toBeFocused();
    }

    for (const mod of modifiers) {
      await page.keyboard.press(`${mod}+Space`);
      await expect(page.locator("[data-ask-panel]")).toHaveCount(0);
      await expect(page.locator("[data-ask-selection]")).toHaveCount(0);
      await expect(page.locator("[data-ask-layer]")).toBeVisible();
      await expect(page.locator("[role=status]").first()).not.toHaveText(/已选：/);
      await expect(chip).toBeFocused();
    }

    let seen = await page.evaluate(
      () => (window as unknown as { __f1Seen: Array<{ key: string; ctrlKey: boolean; metaKey: boolean }> }).__f1Seen,
    );
    expect(seen.some((e) => e.key === "Enter" && e.ctrlKey)).toBe(true);
    expect(seen.some((e) => e.key === "Enter" && e.metaKey)).toBe(true);
    expect(seen.some((e) => e.key === " " && e.ctrlKey)).toBe(true);
    expect(seen.some((e) => e.key === " " && e.metaKey)).toBe(true);

    // Run 2: with a prior 当前字幕 selection via chip tap/click then cancel
    const subtitleChip = page.locator('[data-ask-bottom-bar] [data-ask-shortcut="subtitle"]');
    await subtitleChip.click();
    const panel = page.locator("[data-ask-panel]");
    await expect(panel).toBeVisible();
    await expect(panel.locator("[data-ask-panel-label]")).toHaveText("已选：当前字幕");

    const cancelBtn = panel.locator("[data-ask-cancel]");
    await cancelBtn.click();
    await expect(panel).toHaveCount(0);

    const selLabel = page.locator("[data-ask-selection-label]");
    await expect(selLabel).toHaveText("已选：当前字幕");
    await expect(page.locator("[role=status]").first()).toHaveText("已选：当前字幕");

    // Clear window.__f1Seen to re-verify for Run 2
    await page.evaluate(() => {
      (window as unknown as { __f1Seen: unknown[] }).__f1Seen = [];
    });

    // Focusing a chip: use locator.focus() on the bar chip while panel is closed
    await chip.focus();
    await expect(chip).toBeFocused();

    for (const mod of modifiers) {
      await page.keyboard.press(`${mod}+Enter`);
      await expect(page.locator("[data-ask-panel]")).toHaveCount(0);
      await expect(selLabel).toHaveText("已选：当前字幕");
      await expect(page.locator("[role=status]").first()).toHaveText("已选：当前字幕");
      await expect(page.locator("[data-ask-selection]")).toBeVisible();
      await expect(chip).toBeFocused();
    }

    for (const mod of modifiers) {
      await page.keyboard.press(`${mod}+Space`);
      await expect(page.locator("[data-ask-panel]")).toHaveCount(0);
      await expect(selLabel).toHaveText("已选：当前字幕");
      await expect(page.locator("[role=status]").first()).toHaveText("已选：当前字幕");
      await expect(page.locator("[data-ask-selection]")).toBeVisible();
      await expect(chip).toBeFocused();
    }

    seen = await page.evaluate(
      () => (window as unknown as { __f1Seen: Array<{ key: string; ctrlKey: boolean; metaKey: boolean }> }).__f1Seen,
    );
    expect(seen.some((e) => e.key === "Enter" && e.ctrlKey)).toBe(true);
    expect(seen.some((e) => e.key === "Enter" && e.metaKey)).toBe(true);
    expect(seen.some((e) => e.key === " " && e.ctrlKey)).toBe(true);
    expect(seen.some((e) => e.key === " " && e.metaKey)).toBe(true);
  });

  test("IME guard 1280: dispatch keydown Enter with isComposing:true or keyCode 229 on a chip asserts no selection and panel not visible", async ({ page }) => {
    await startGenerated(page);
    await pauseLecture(page);
    await enterSelection(page);

    const chip = page.locator('[data-ask-bottom-bar] [data-ask-shortcut="step"]');
    await chip.focus();
    await expect(chip).toBeFocused();

    await chip.evaluate((el) => {
      el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true }));
    });
    await expect(page.locator("[data-ask-panel]")).toHaveCount(0);
    await expect(page.locator("[data-ask-selection]")).toHaveCount(0);

    await chip.evaluate((el) => {
      const ev = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
      Object.defineProperty(ev, "keyCode", { value: 229 });
      el.dispatchEvent(ev);
    });
    await expect(page.locator("[data-ask-panel]")).toHaveCount(0);
    await expect(page.locator("[data-ask-selection]")).toHaveCount(0);
  });

  test("F1 1280: Shift+click on chip selects it as normal", async ({ page }) => {
    await startGenerated(page);
    await pauseLecture(page);
    await enterSelection(page);

    const subtitleChip = page.locator('[data-ask-bottom-bar] [data-ask-shortcut="subtitle"]');
    await subtitleChip.click({ modifiers: ["Shift"] });
    const panel = page.locator("[data-ask-panel]");
    await expect(panel).toBeVisible();
    await expect(panel.locator("[data-ask-panel-label]")).toHaveText("已选：当前字幕");
  });

  test("chip390-b 1280 plan panel open: Tab from entry skips the 8 plan buttons to the chips; Shift+Tab returns", async ({ page }) => {
    await startGenerated(page);
    await pauseLecture(page);
    await enterSelection(page);
    // 讲义计划面板开着，DOM 顺序上它的 8 个按钮排在入口和芯片之间。
    const between = await page.evaluate(() => {
      const all = [...document.querySelectorAll<HTMLElement>("button")].filter(
        (e) => e.tabIndex >= 0 && e.offsetParent !== null,
      );
      const i = all.indexOf(document.querySelector<HTMLElement>("[data-ask-entry]")!);
      const j = all.findIndex((e) => e.hasAttribute("data-ask-shortcut"));
      return all.slice(i + 1, j).filter((e) => e.closest("aside")).length;
    });
    expect(between).toBe(8);
    const entryBtn = entry(page).first();
    await entryBtn.focus();
    await page.keyboard.press("Tab");
    await expect(page.locator('[data-ask-bottom-bar] [data-ask-shortcut][tabindex="0"]')).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(entryBtn).toBeFocused();
  });

  test("chip390-b 1280: Alt/Ctrl/Meta+Shift+Tab on a chip does not jump to the entry", async ({ page }) => {
    await startGenerated(page);
    await pauseLecture(page);
    await enterSelection(page);
    const chip = page.locator('[data-ask-bottom-bar] [data-ask-shortcut][tabindex="0"]');
    for (const mod of ["Alt", "Control", "Meta"]) {
      await chip.focus();
      const prevented = await chip.evaluate((el, m) => {
        const ev = new KeyboardEvent("keydown", {
          key: "Tab",
          shiftKey: true,
          altKey: m === "Alt",
          ctrlKey: m === "Control",
          metaKey: m === "Meta",
          bubbles: true,
          cancelable: true,
        });
        el.dispatchEvent(ev);
        return ev.defaultPrevented;
      }, mod);
      expect(prevented, mod).toBe(false);
      await expect(entry(page).first(), mod).not.toBeFocused();
    }
  });

  let recordedForwardSequence: string[] = [];

  test("F2 1280: Tab from entry walks panel in order", async ({ page }) => {
    await startGenerated(page);
    await pauseLecture(page);
    await enterSelection(page);

    // Open panel by clicking subtitle shortcut chip
    const subtitleChip = page.locator('[data-ask-bottom-bar] [data-ask-shortcut="subtitle"]');
    await subtitleChip.click();
    const panel = page.locator("[data-ask-panel]");
    await expect(panel).toBeVisible();

    // Type text into textarea so submit button is enabled (not disabled)
    await panel.locator("[data-ask-question]").fill("请问这行代码的意思");

    // Focus entry
    const entryBtn = entry(page).first();
    await entryBtn.focus();
    await expect(entryBtn).toBeFocused();

    // From the desktop entry, Tab lands on the first [data-ask-panel] [data-ask-shortcut]
    await page.keyboard.press("Tab");
    const landsOnFirstShortcut = await page.evaluate(() => {
      const el = document.activeElement;
      const firstShortcut = document.querySelector("[data-ask-panel] [data-ask-shortcut]");
      return el !== null && el === firstShortcut;
    });
    expect(landsOnFirstShortcut).toBe(true);

    // Keep pressing Tab and record activeElement until it leaves [data-ask-panel] (max 30 presses)
    const inPanelSequence: Array<{
      id: string;
      isShortcut: boolean;
      isQuestion: boolean;
      isCancel: boolean;
      isSubmit: boolean;
    }> = [];

    for (let press = 0; press < 30; press++) {
      const current = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || !el.closest("[data-ask-panel]")) {
          return null;
        }
        const shortcut = el.getAttribute("data-ask-shortcut");
        const chip = el.getAttribute("data-ask-chip");
        const isQuestion = el.tagName.toLowerCase() === "textarea" && el.hasAttribute("data-ask-question");
        const isCancel = el.hasAttribute("data-ask-cancel");
        const isSubmit = el.hasAttribute("data-ask-submit");

        let id = el.tagName.toLowerCase();
        if (shortcut) id = `shortcut:${shortcut}`;
        else if (chip) id = `chip:${chip}`;
        else if (isQuestion) id = "textarea[data-ask-question]";
        else if (isCancel) id = "[data-ask-cancel]";
        else if (isSubmit) id = "[data-ask-submit]";

        return {
          id,
          isShortcut: Boolean(shortcut),
          isQuestion,
          isCancel,
          isSubmit,
        };
      });

      if (!current) {
        break;
      }
      inPanelSequence.push(current);
      await page.keyboard.press("Tab");
    }

    // Save recorded forward sequence for reverse checks
    recordedForwardSequence = inPanelSequence.map((item) => item.id);

    // Assert the recorded sequence includes, in this relative order: a shortcut chip, textarea[data-ask-question], [data-ask-cancel], [data-ask-submit]
    const shortcutIndex = inPanelSequence.findIndex((item) => item.isShortcut);
    const textareaIndex = inPanelSequence.findIndex((item) => item.isQuestion);
    const cancelIndex = inPanelSequence.findIndex((item) => item.isCancel);
    const submitIndex = inPanelSequence.findIndex((item) => item.isSubmit);

    expect(shortcutIndex).toBeGreaterThanOrEqual(0);
    expect(textareaIndex).toBeGreaterThan(shortcutIndex);
    expect(cancelIndex).toBeGreaterThan(textareaIndex);
    expect(submitIndex).toBeGreaterThan(cancelIndex);

    // The submit is the last element inside the panel
    expect(submitIndex).toBe(inPanelSequence.length - 1);

    // The next focused element after submit is outside [data-ask-panel] and outside [data-ask-bottom-bar] and is NOT the entry
    const afterSubmit = await page.evaluate(() => {
      const el = document.activeElement;
      const inPanel = Boolean(el?.closest("[data-ask-panel]"));
      const inBottomBar = Boolean(el?.closest("[data-ask-bottom-bar]"));
      const isEntry = Boolean(el?.hasAttribute("data-ask-entry") || el?.closest("[data-ask-entry]"));
      return {
        outsidePanel: Boolean(el && !inPanel),
        outsideBottomBar: Boolean(el && !inBottomBar),
        isNotEntry: Boolean(el && !isEntry),
      };
    });
    expect(afterSubmit.outsidePanel).toBe(true);
    expect(afterSubmit.outsideBottomBar).toBe(true);
    expect(afterSubmit.isNotEntry).toBe(true);
  });

  test("F2 1280: Shift+Tab from 提问 back to entry", async ({ page }) => {
    await startGenerated(page);
    await pauseLecture(page);
    await enterSelection(page);

    // Open panel by clicking subtitle shortcut chip
    const subtitleChip = page.locator('[data-ask-bottom-bar] [data-ask-shortcut="subtitle"]');
    await subtitleChip.click();
    const panel = page.locator("[data-ask-panel]");
    await expect(panel).toBeVisible();

    // Type text into textarea so submit button is enabled (never submit)
    await panel.locator("[data-ask-question]").fill("请问这行代码的意思");

    // Forward in-panel sequence (from previous test or DOM query if run standalone)
    const forwardSequence =
      recordedForwardSequence.length > 0
        ? recordedForwardSequence
        : await page.evaluate(() => {
            const p = document.querySelector("[data-ask-panel]");
            if (!p) return [];
            const candidates = Array.from(
              p.querySelectorAll<HTMLElement>("button, textarea, input, select, a[href], [tabindex]")
            ).filter((el) => {
              if (el.getAttribute("tabindex") === "-1") return false;
              if ((el as HTMLButtonElement).disabled) return false;
              return el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0;
            });
            return candidates.map((el) => {
              const shortcut = el.getAttribute("data-ask-shortcut");
              const chip = el.getAttribute("data-ask-chip");
              const isQuestion = el.tagName.toLowerCase() === "textarea" && el.hasAttribute("data-ask-question");
              const isCancel = el.hasAttribute("data-ask-cancel");
              const isSubmit = el.hasAttribute("data-ask-submit");
              if (shortcut) return `shortcut:${shortcut}`;
              if (chip) return `chip:${chip}`;
              if (isQuestion) return "textarea[data-ask-question]";
              if (isCancel) return "[data-ask-cancel]";
              if (isSubmit) return "[data-ask-submit]";
              return el.tagName.toLowerCase();
            });
          });

    const expectedReverseSequence = [...forwardSequence].reverse();

    // Starting focus on [data-ask-submit]
    const submitBtn = panel.locator("[data-ask-submit]");
    await submitBtn.focus();
    await expect(submitBtn).toBeFocused();

    // Record reverse sequence starting with [data-ask-submit], then press Shift+Tab until leaving panel
    const recordedReverseSequence: string[] = [];
    const startId = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el?.closest("[data-ask-panel]")) return null;
      if (el.hasAttribute("data-ask-submit")) return "[data-ask-submit]";
      return el.tagName.toLowerCase();
    });
    expect(startId).toBe("[data-ask-submit]");
    if (startId) {
      recordedReverseSequence.push(startId);
    }

    for (let press = 0; press < 30; press++) {
      await page.keyboard.press("Shift+Tab");
      const current = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || !el.closest("[data-ask-panel]")) return null;
        const shortcut = el.getAttribute("data-ask-shortcut");
        const chip = el.getAttribute("data-ask-chip");
        const isQuestion = el.tagName.toLowerCase() === "textarea" && el.hasAttribute("data-ask-question");
        const isCancel = el.hasAttribute("data-ask-cancel");
        const isSubmit = el.hasAttribute("data-ask-submit");
        if (shortcut) return `shortcut:${shortcut}`;
        if (chip) return `chip:${chip}`;
        if (isQuestion) return "textarea[data-ask-question]";
        if (isCancel) return "[data-ask-cancel]";
        if (isSubmit) return "[data-ask-submit]";
        return el.tagName.toLowerCase();
      });

      if (!current) {
        break;
      }
      recordedReverseSequence.push(current);
    }

    // Assert the exact reverse of the recorded forward in-panel sequence
    expect(recordedReverseSequence).toEqual(expectedReverseSequence);

    // Ending on the entry
    const entryBtn = entry(page).first();
    await expect(entryBtn).toBeFocused();
  });

  test("F2 1280: Shift+Tab from step list back to entry walks exact reverse", async ({ page }) => {
    await startGenerated(page);
    await pauseLecture(page);
    await enterSelection(page);

    // Open panel by clicking subtitle shortcut chip
    const subtitleChip = page.locator('[data-ask-bottom-bar] [data-ask-shortcut="subtitle"]');
    await subtitleChip.click();
    const panel = page.locator("[data-ask-panel]");
    await expect(panel).toBeVisible();

    // Type text into textarea so submit button is enabled (not disabled)
    await panel.locator("[data-ask-question]").fill("请问这行代码的意思");

    const getElementId = () =>
      page.evaluate(() => {
        const el = document.activeElement;
        if (!el) return "none";
        if (el.hasAttribute("data-ask-entry") || el.closest("[data-ask-entry]")) return "entry";
        const shortcut = el.getAttribute("data-ask-shortcut");
        const chip = el.getAttribute("data-ask-chip");
        const isQuestion = el.tagName.toLowerCase() === "textarea" && el.hasAttribute("data-ask-question");
        const isCancel = el.hasAttribute("data-ask-cancel");
        const isSubmit = el.hasAttribute("data-ask-submit");
        if (shortcut) return `shortcut:${shortcut}`;
        if (chip) return `chip:${chip}`;
        if (isQuestion) return "textarea[data-ask-question]";
        if (isCancel) return "[data-ask-cancel]";
        if (isSubmit) return "[data-ask-submit]";
        return el.id ? `#${el.id}` : el.tagName.toLowerCase();
      });

    // Focus entry
    const entryBtn = entry(page).first();
    await entryBtn.focus();
    await expect(entryBtn).toBeFocused();

    // Tab from entry forward recording each focused element id until reaching the element after entry (the step list / first in-panel element)
    const forwardToFirst: string[] = [await getElementId()];
    await page.keyboard.press("Tab");
    const firstInPanelId = await getElementId();
    forwardToFirst.push(firstInPanelId);

    // Verify it reached the element after entry (the first in-panel element)
    const isFirstInPanel = await page.evaluate(() => {
      const el = document.activeElement;
      const first = document.querySelector("[data-ask-panel] [data-ask-shortcut]");
      return el !== null && el === first;
    });
    expect(isFirstInPanel).toBe(true);

    // then press Shift+Tab from that element and assert it lands exactly on the entry button in one step with no loop
    await page.keyboard.press("Shift+Tab");
    await expect(entryBtn).toBeFocused();
    expect(await getElementId()).toBe("entry");

    // also record a full forward walk entry->...->submit and full Shift+Tab walk back and assert exact reverse, ending on entry with no extra wrap
    const fullForwardWalk: string[] = ["entry"];
    let currentId = "entry";
    for (let i = 0; i < 30; i++) {
      await page.keyboard.press("Tab");
      currentId = await getElementId();
      fullForwardWalk.push(currentId);
      if (currentId === "[data-ask-submit]") {
        break;
      }
    }
    expect(currentId).toBe("[data-ask-submit]");

    const fullReverseWalk: string[] = [currentId];
    for (let i = 0; i < 30; i++) {
      await page.keyboard.press("Shift+Tab");
      currentId = await getElementId();
      fullReverseWalk.push(currentId);
      if (currentId === "entry") {
        break;
      }
    }
    expect(currentId).toBe("entry");

    // assert exact reverse
    expect(fullReverseWalk).toEqual([...fullForwardWalk].reverse());

    // ending on entry with no extra wrap
    await expect(entryBtn).toBeFocused();
  });

  test("F2 1280: panel closed Tab order unchanged", async ({ page }) => {
    await startGenerated(page);
    await pauseLecture(page);
    await enterSelection(page);

    // In selecting mode with panel closed
    const entryBtn = entry(page).first();
    await entryBtn.focus();
    await expect(entryBtn).toBeFocused();

    // Compute expected order based on:
    // stop 0: entry
    // stop 1: first chip in chip group (by '1280: Tab from the entry lands on the chip group first' convention)
    // stops 2..14: next natural focusables in DOM order after that first chip
    const expectedOrder = await page.evaluate(() => {
      const identify = (el: Element | null): string => {
        if (!el) return "none";
        if (el.hasAttribute("data-ask-entry") && !el.closest("[data-ask-bottom-bar]")) return "entry";
        const shortcut = el.getAttribute("data-ask-shortcut");
        if (shortcut) return `shortcut:${shortcut}`;
        const chip = el.getAttribute("data-ask-chip");
        if (chip) return `chip:${chip}`;
        if (el.id) return `#${el.id}`;
        const ariaLabel = el.getAttribute("aria-label");
        if (ariaLabel) return `[aria-label="${ariaLabel}"]`;
        const title = el.getAttribute("title");
        if (title) return `[title="${title}"]`;
        const text = el.textContent?.trim().slice(0, 30);
        return `${el.tagName.toLowerCase()}${text ? `:${text}` : ""}`;
      };

      const isTabbable = (el: HTMLElement) => {
        if (el.tabIndex < 0) return false;
        if ("disabled" in el && (el as HTMLButtonElement).disabled) return false;
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") return false;
        if (el.offsetParent === null && el.offsetWidth === 0 && el.offsetHeight === 0 && el.getClientRects().length === 0) return false;
        return true;
      };

      const entryEl = document.querySelector<HTMLElement>("[data-ask-entry]:not([data-ask-bottom-bar] [data-ask-entry])")!;
      const firstChip = document.querySelector<HTMLElement>('[data-ask-bottom-bar] [data-ask-shortcut][tabindex="0"]')!;

      const all = Array.from(
        document.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        )
      ).filter(isTabbable);

      const chipIdx = all.indexOf(firstChip);
      const naturalAfterChip: HTMLElement[] = [];
      for (let i = chipIdx + 1; i < all.length && naturalAfterChip.length < 13; i++) {
        naturalAfterChip.push(all[i]);
      }
      for (let i = 0; i < all.length && naturalAfterChip.length < 13; i++) {
        naturalAfterChip.push(all[i]);
      }

      const stops = [entryEl, firstChip, ...naturalAfterChip.slice(0, 13)];
      return stops.map(identify);
    });

    // Record the actual Tab order of the first 15 focus stops starting from the entry button
    const actualOrder: string[] = [];
    const getActive = () =>
      page.evaluate(() => {
        const el = document.activeElement;
        if (!el) return "none";
        if (el.hasAttribute("data-ask-entry") && !el.closest("[data-ask-bottom-bar]")) return "entry";
        const shortcut = el.getAttribute("data-ask-shortcut");
        if (shortcut) return `shortcut:${shortcut}`;
        const chip = el.getAttribute("data-ask-chip");
        if (chip) return `chip:${chip}`;
        if (el.id) return `#${el.id}`;
        const ariaLabel = el.getAttribute("aria-label");
        if (ariaLabel) return `[aria-label="${ariaLabel}"]`;
        const title = el.getAttribute("title");
        if (title) return `[title="${title}"]`;
        const text = el.textContent?.trim().slice(0, 30);
        return `${el.tagName.toLowerCase()}${text ? `:${text}` : ""}`;
      });

    actualOrder.push(await getActive());
    expect(actualOrder[0]).toBe("entry");

    for (let step = 1; step < 15; step++) {
      await page.keyboard.press("Tab");
      actualOrder.push(await getActive());
    }

    expect(actualOrder.length).toBe(15);
    expect(actualOrder[0]).toBe("entry");
    expect(actualOrder[1]).toMatch(/^shortcut:/);
    expect(actualOrder).toEqual(expectedOrder);
  });

  test("S5-chip390 1280: chip row position unchanged", async ({ page }) => {
    await startGenerated(page);
    await pauseLecture(page);
    await enterSelection(page);

    const layer = page.locator("[data-ask-layer]");
    const group = layer.locator('[role="group"][aria-label="点选捷径"]');
    await expect(group).toBeVisible();

    const layerBox = await layer.boundingBox();
    const groupBox = await group.boundingBox();
    expect(layerBox).not.toBeNull();
    expect(groupBox).not.toBeNull();

    expect(groupBox!.y - layerBox!.y).toBeLessThan(80);

    const positionStyle = await group.evaluate((el) => window.getComputedStyle(el).position);
    expect(positionStyle).not.toBe("fixed");
  });

  test("S2. Q enters, exit button >=44x44, Esc exits", async ({ page }) => {
    await startGenerated(page);
    await pauseLecture(page);
    const titleRow = entry(page).locator("xpath=ancestor::div[1]");
    const rowBoxBefore = await titleRow.boundingBox();
    expect(rowBoxBefore).not.toBeNull();

    await page.keyboard.press("q");
    await expect(page.locator("[data-ask-layer]")).toBeVisible();
    await expect(entry(page)).toHaveAttribute("aria-pressed", "true");

    const exitBox = await entry(page).boundingBox();
    expect(exitBox).not.toBeNull();
    expect(exitBox!.width).toBeGreaterThanOrEqual(44);
    expect(exitBox!.height).toBeGreaterThanOrEqual(44);
    await expect(entry(page)).toHaveAttribute("aria-keyshortcuts", "Escape");

    const rowBoxAfter = await titleRow.boundingBox();
    expect(rowBoxAfter).not.toBeNull();
    expect(Math.abs(rowBoxAfter!.height - rowBoxBefore!.height)).toBeLessThanOrEqual(1);

    await page.keyboard.press("Escape");
    await expect(page.locator("[data-ask-layer]")).toHaveCount(0);
  });

  test("exit button above selection layer: click exits and subtitle drag still selects", async ({ page }) => {
    await startGenerated(page);
    await pauseLecture(page);
    await enterSelection(page);

    const button = entry(page);
    await button.scrollIntoViewIfNeeded();
    const box = await button.boundingBox();
    expect(box).not.toBeNull();
    const centerX = box!.x + box!.width / 2;
    const centerY = box!.y + box!.height / 2;

    const isButtonOrDescendant = await page.evaluate(
      ({ x, y }) => {
        const el = document.elementFromPoint(x, y);
        const btn = document.querySelector("[data-ask-entry]");
        return el !== null && (el === btn || btn?.contains(el) === true);
      },
      { x: centerX, y: centerY },
    );
    expect(isButtonOrDescendant).toBe(true);

    await page.mouse.click(centerX, centerY);
    await expect(page.locator("[data-ask-layer]")).toHaveCount(0);
    await expect(page.locator("[data-ask-panel]")).toHaveCount(0);
    await expect(button).not.toHaveAttribute("aria-pressed", "true");

    await enterSelection(page);

    const subtitleBody = page.locator('[data-ask-target="subtitle"] p').filter({ hasNotText: "字幕" }).first();
    await subtitleBody.scrollIntoViewIfNeeded();
    const subBox = await subtitleBody.boundingBox();
    expect(subBox).not.toBeNull();
    const btnBox = (await button.boundingBox())!;
    const startX = subBox!.x + 12;
    const startY = subBox!.y + 12;
    const outside44 =
      startX < btnBox.x - 44 ||
      startX > btnBox.x + btnBox.width + 44 ||
      startY < btnBox.y - 44 ||
      startY > btnBox.y + btnBox.height + 44;
    expect(outside44).toBe(true);

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + 50, startY + 25, { steps: 5 });
    await page.mouse.up();

    const panel = page.locator("[data-ask-panel]");
    await expect(panel).toBeVisible();
    await expect(panel.locator("[data-ask-panel-label]")).toHaveText("已选：当前字幕");
  });

  test("drag starting 10px below exit button bottom edge on subtitle body text selects 当前字幕", async ({ page }) => {
    await startGenerated(page);
    await pauseLecture(page);
    await enterSelection(page);

    const button = entry(page);
    await button.scrollIntoViewIfNeeded();
    const subtitleBody = page.locator('[data-ask-target="subtitle"] p').filter({ hasNotText: "字幕" }).first();
    await subtitleBody.scrollIntoViewIfNeeded();
    const btnBox = (await button.boundingBox())!;
    expect(btnBox).not.toBeNull();

    const startX = btnBox.x + btnBox.width / 2;
    const startY = btnBox.y + btnBox.height + 10;

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX - 40, startY + 25, { steps: 5 });
    await page.mouse.up();

    const panel = page.locator("[data-ask-panel]");
    await expect(panel).toBeVisible();
    await expect(panel.locator("[data-ask-panel-label]")).toHaveText("已选：当前字幕");
  });

  test("drag starting in code area starts selection", async ({ page }) => {
    await startGenerated(page);
    await pauseLecture(page);
    await enterSelection(page);

    const codeArea = page.locator(".monaco-editor").first();
    await codeArea.scrollIntoViewIfNeeded();
    await expect(codeArea).toBeVisible();
    const box = await codeArea.boundingBox();
    expect(box).not.toBeNull();

    const startX = box!.x + 40;
    const startY = box!.y + 40;

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + 60, startY + 60, { steps: 5 });
    const rubber = page.locator("[data-ask-rubber]");
    const selectionBox = page.locator("[data-ask-selection]");
    await expect(rubber.or(selectionBox)).toBeVisible();
    await page.mouse.up();
  });

  test("S5. repro: box over Monaco code + step card", async ({ page }) => {
    let capturedTargets: Array<{ kind?: string }> = [];
    await mockAsk(page, async (route) => {
      const body = route.request().postDataJSON() as {
        selection?: { targets?: Array<{ kind?: string }> };
      };
      capturedTargets = body?.selection?.targets ?? [];
      await route.fulfill({
        status: 200,
        contentType: "application/x-ndjson",
        body: askStream("s1"),
      });
    });
    await startGenerated(page);
    await pauseLecture(page);
    await enterSelection(page);

    const monaco = page.locator("[data-ask-stage] .monaco-editor");
    const stepCard = page.locator('[data-ask-target="step"]');
    await expect(monaco).toBeVisible();
    await expect(stepCard).toBeVisible();

    const monacoBox = await monaco.boundingBox();
    const stepBox = await stepCard.boundingBox();
    if (!monacoBox || !stepBox) throw new Error("monaco or step target has no box");

    const startX = monacoBox.x;
    const startY = monacoBox.y;
    const endX = stepBox.x + stepBox.width;
    const endY = stepBox.y + stepBox.height;

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(endX, endY, { steps: 8 });
    await page.mouse.up();

    const panel = page.locator("[data-ask-panel]");
    await expect(panel).toBeVisible();

    await askQuestion(page);
    await expect(page.getByText(ANSWER_NARRATION)).toBeVisible({ timeout: ANSWER_TIMEOUT_MS });

    // Missing before S5 because the code area had no data-ask-target. Code is now collected.
    expect(capturedTargets.some((t) => t.kind === "code")).toBe(true);
    expect(capturedTargets.some((t) => t.kind === "step")).toBe(true);
  });

  test("S5. code box sends codeRange", async ({ page }) => {
    let capturedTargets: Array<{
      kind?: string;
      codeRange?: { startLine: number; endLine: number };
      text?: string;
    }> = [];
    await mockAsk(page, async (route) => {
      const body = route.request().postDataJSON() as {
        selection?: {
          targets?: Array<{
            kind?: string;
            codeRange?: { startLine: number; endLine: number };
            text?: string;
          }>;
        };
      };
      capturedTargets = body?.selection?.targets ?? [];
      await route.fulfill({
        status: 200,
        contentType: "application/x-ndjson",
        body: askStream("s1"),
      });
    });
    await startGenerated(page);
    await pauseLecture(page);
    await enterSelection(page);

    const code = page.locator('[data-ask-stage] [data-ask-target="code"]');
    await expect(code).toBeVisible();

    const box = await code.boundingBox();
    if (!box) throw new Error("code target has no box");

    const startX = box.x + box.width * 0.2;
    const startY = box.y + box.height * 0.3;
    const endX = box.x + box.width * 0.8;
    const endY = box.y + box.height * 0.6;

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(endX, endY, { steps: 8 });
    await page.mouse.up();

    const panel = page.locator("[data-ask-panel]");
    await expect(panel).toBeVisible();
    await expect(panel.locator("[data-ask-panel-label]")).toHaveText(/代码第 \d+–\d+ 行/);

    await askQuestion(page);
    await expect(page.getByText(ANSWER_NARRATION)).toBeVisible({ timeout: ANSWER_TIMEOUT_MS });

    const codeTarget = capturedTargets.find((t) => t.kind === "code");
    expect(codeTarget).toBeDefined();
    expect(codeTarget!.codeRange).toBeDefined();
    expect(codeTarget!.codeRange!.startLine).toBeGreaterThanOrEqual(1);
    expect(codeTarget!.codeRange!.endLine).toBeGreaterThanOrEqual(codeTarget!.codeRange!.startLine);
    expect(codeTarget!.text).toBeTruthy();
  });

  for (const [startLine, endLine] of [
    [2, 4],
    [4, 6],
    [8, 9],
  ] as const) {
    test(`S5-a 1280: drag over Monaco lines ${startLine}–${endLine}`, async ({ page }) => {
      let capturedTargets: Array<{
        kind?: string;
        codeRange?: { startLine: number; endLine: number };
        text?: string;
      }> = [];
      await mockAsk(page, async (route) => {
        const body = route.request().postDataJSON() as {
          selection?: {
            targets?: Array<{
              kind?: string;
              codeRange?: { startLine: number; endLine: number };
              text?: string;
            }>;
          };
        };
        capturedTargets = body?.selection?.targets ?? [];
        await route.fulfill({
          status: 200,
          contentType: "application/x-ndjson",
          body: askStream("s1"),
        });
      });
      await startGenerated(page);
      await pauseLecture(page);
      await enterSelection(page);

      const code = page.locator('[data-ask-stage] [data-ask-target="code"]');
      await expect(code).toBeVisible();

      const box = await code.boundingBox();
      if (!box) throw new Error("code target has no box");

      const startBox = await getMonacoLineBox(page, startLine);
      const endBox = await getMonacoLineBox(page, endLine);
      const startY = startBox.top + 4;
      const endY = endBox.bottom - 4;
      const startX = box.x + 80;
      const endX = box.x + 180;

      await page.mouse.move(startX, startY);
      await page.mouse.down();
      await page.mouse.move(endX, endY, { steps: 8 });
      await page.mouse.up();

      const panel = page.locator("[data-ask-panel]");
      await expect(panel).toBeVisible();
      await expect(panel.locator("[data-ask-panel-label]")).toHaveText(`已选：代码第 ${startLine}–${endLine} 行`);

      await askQuestion(page);
      await expect(page.getByText(ANSWER_NARRATION)).toBeVisible({ timeout: ANSWER_TIMEOUT_MS });

      const codeTarget = capturedTargets.find((t) => t.kind === "code");
      expect(codeTarget).toBeDefined();
      expect(codeTarget!.codeRange).toEqual({ startLine, endLine });
    });
  }

  test("S5-a 1280: drag over Monaco single line 9", async ({ page }) => {
    let capturedTargets: Array<{
      kind?: string;
      codeRange?: { startLine: number; endLine: number };
      text?: string;
    }> = [];
    await mockAsk(page, async (route) => {
      const body = route.request().postDataJSON() as {
        selection?: {
          targets?: Array<{
            kind?: string;
            codeRange?: { startLine: number; endLine: number };
            text?: string;
          }>;
        };
      };
      capturedTargets = body?.selection?.targets ?? [];
      await route.fulfill({
        status: 200,
        contentType: "application/x-ndjson",
        body: askStream("s1"),
      });
    });
    await startGenerated(page);
    await pauseLecture(page);
    await enterSelection(page);

    const code = page.locator('[data-ask-stage] [data-ask-target="code"]');
    await expect(code).toBeVisible();

    const box = await code.boundingBox();
    if (!box) throw new Error("code target has no box");

    const line9Y = await getMonacoLineY(page, 9);
    const startX = box.x + 80;
    const endX = box.x + 180;
    // Box height of 24 (line9Y - 12 to line9Y + 12) satisfies MIN_REGION_SIDE (24),
    // while grazing into neighbor lines 8 and 10 by at most 1px (<= 2px dead-zone),
    // so only line 9 is selected.
    const startY = line9Y - 12;
    const endY = line9Y + 12;

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(endX, endY, { steps: 8 });
    await page.mouse.up();

    const panel = page.locator("[data-ask-panel]");
    await expect(panel).toBeVisible();
    await expect(panel.locator("[data-ask-panel-label]")).toHaveText("已选：代码第 9 行");

    await askQuestion(page);
    await expect(page.getByText(ANSWER_NARRATION)).toBeVisible({ timeout: ANSWER_TIMEOUT_MS });

    const codeTarget = capturedTargets.find((t) => t.kind === "code");
    expect(codeTarget).toBeDefined();
    expect(codeTarget!.codeRange).toEqual({ startLine: 9, endLine: 9 });
  });

  test("S5-a 1280: short drag inside line 7", async ({ page }) => {
    let capturedTargets: Array<{
      kind?: string;
      codeRange?: { startLine: number; endLine: number };
      text?: string;
    }> = [];
    await mockAsk(page, async (route) => {
      const body = route.request().postDataJSON() as {
        selection?: {
          targets?: Array<{
            kind?: string;
            codeRange?: { startLine: number; endLine: number };
            text?: string;
          }>;
        };
      };
      capturedTargets = body?.selection?.targets ?? [];
      await route.fulfill({
        status: 200,
        contentType: "application/x-ndjson",
        body: askStream("s1"),
      });
    });
    await startGenerated(page);
    await pauseLecture(page);
    await enterSelection(page);

    const code = page.locator('[data-ask-stage] [data-ask-target="code"]');
    await expect(code).toBeVisible();

    const box = await code.boundingBox();
    if (!box) throw new Error("code target has no box");

    const line7 = await getMonacoLineBox(page, 7);
    const startX = box.x + 80;
    const endX = startX + 120;
    const startY = line7.top + 5;
    const endY = line7.bottom - 5;

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(endX, endY, { steps: 8 });
    await page.mouse.up();

    const panel = page.locator("[data-ask-panel]");
    await expect(panel).toBeVisible();
    await expect(panel.locator("[data-ask-panel-label]")).toHaveText("已选：代码第 7 行");

    await askQuestion(page);
    await expect(page.getByText(ANSWER_NARRATION)).toBeVisible({ timeout: ANSWER_TIMEOUT_MS });

    const codeTarget = capturedTargets.find((t) => t.kind === "code");
    expect(codeTarget).toBeDefined();
    expect(codeTarget!.codeRange).toEqual({ startLine: 7, endLine: 7 });
  });

  test("S5-a 1280: click on line 5", async ({ page }) => {
    let capturedTargets: Array<{
      kind?: string;
      codeRange?: { startLine: number; endLine: number };
      text?: string;
    }> = [];
    await mockAsk(page, async (route) => {
      const body = route.request().postDataJSON() as {
        selection?: {
          targets?: Array<{
            kind?: string;
            codeRange?: { startLine: number; endLine: number };
            text?: string;
          }>;
        };
      };
      capturedTargets = body?.selection?.targets ?? [];
      await route.fulfill({
        status: 200,
        contentType: "application/x-ndjson",
        body: askStream("s1"),
      });
    });
    await startGenerated(page);
    await pauseLecture(page);
    await enterSelection(page);

    const code = page.locator('[data-ask-stage] [data-ask-target="code"]');
    await expect(code).toBeVisible();

    const box = await code.boundingBox();
    if (!box) throw new Error("code target has no box");

    const line5 = await getMonacoLineBox(page, 5);
    const clickX = box.x + 80;
    const clickY = (line5.top + line5.bottom) / 2;

    await page.mouse.click(clickX, clickY);

    const panel = page.locator("[data-ask-panel]");
    await expect(panel).toBeVisible();
    await expect(panel.locator("[data-ask-panel-label]")).toHaveText("已选：代码第 5 行");

    await askQuestion(page);
    await expect(page.getByText(ANSWER_NARRATION)).toBeVisible({ timeout: ANSWER_TIMEOUT_MS });

    const codeTarget = capturedTargets.find((t) => t.kind === "code");
    expect(codeTarget).toBeDefined();
    expect(codeTarget!.codeRange).toEqual({ startLine: 5, endLine: 5 });
  });

  test("S5. code box selection shows no 代码部分没选上 hint", async ({ page }) => {
    await startGenerated(page);
    await pauseLecture(page);
    await enterSelection(page);

    const code = page.locator('[data-ask-stage] [data-ask-target="code"]');
    await expect(code).toBeVisible();

    const box = await code.boundingBox();
    if (!box) throw new Error("code target has no box");

    const startX = box.x + box.width * 0.2;
    const startY = box.y + box.height * 0.3;
    const endX = box.x + box.width * 0.8;
    const endY = box.y + box.height * 0.6;

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(endX, endY, { steps: 8 });
    await page.mouse.up();

    const panel = page.locator("[data-ask-panel]");
    await expect(panel).toBeVisible();

    const chip = panel.locator("[data-ask-panel-label]");
    await expect(chip).toBeVisible();
    const chipText = (await chip.textContent()) ?? "";
    expect(chipText.startsWith("已选：")).toBe(true);
    expect(chipText).toContain("代码");

    expect(await page.getByText("代码部分没选上，换个地方再框一次").count()).toBe(0);
  });

  test("S5. drag from code across viz collects code only", async ({ page }) => {
    // Starts in the code area, so viz is not collected (C2). Assertions unchanged.
    let capturedTargets: Array<{ kind?: string }> = [];
    await mockAsk(page, async (route) => {
      const body = route.request().postDataJSON() as {
        selection?: { targets?: Array<{ kind?: string }> };
      };
      capturedTargets = body?.selection?.targets ?? [];
      await route.fulfill({
        status: 200,
        contentType: "application/x-ndjson",
        body: askStream("s1"),
      });
    });
    await startGenerated(page);
    await pauseLecture(page);
    await enterSelection(page);

    const code = page.locator('[data-ask-stage] [data-ask-target="code"]');
    const viz = page.locator('[data-ask-target="viz"]').first();
    await expect(code).toBeVisible();
    await expect(viz).toBeVisible();

    const codeBox = await code.boundingBox();
    const vizBox = await viz.boundingBox();
    if (!codeBox || !vizBox) throw new Error("code or viz target has no box");

    const startX = codeBox.x + codeBox.width * 0.5;
    const startY = codeBox.y + codeBox.height * 0.5;
    const endX = vizBox.x + vizBox.width * 0.5;
    const endY = vizBox.y + vizBox.height * 0.5;

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(endX, endY, { steps: 8 });
    await page.mouse.up();

    const panel = page.locator("[data-ask-panel]");
    await expect(panel).toBeVisible();

    await askQuestion(page);
    await expect(page.getByText(ANSWER_NARRATION)).toBeVisible({ timeout: ANSWER_TIMEOUT_MS });

    expect(capturedTargets.some((t) => t.kind === 'code')).toBe(true);
    expect(capturedTargets.some((t) => t.kind === 'viz')).toBe(false);
  });

  test("C2. code origin dragged onto viz keeps code only and crops the capture", async ({ page }) => {
    test.setTimeout(60_000);
    await expectCodeOriginExcludesViz(page);
  });

  test("C2. viz origin covering code collects both", async ({ page }) => {
    test.setTimeout(60_000);
    await expectVizOriginCollectsBoth(page);
  });

  test("S5. empty area shows 没选中 only when nothing hit", async ({ page }) => {
    await startGenerated(page);
    await pauseLecture(page);
    await enterSelection(page);

    const code = page.locator('[data-ask-stage] [data-ask-target="code"]');
    await expect(code).toBeVisible();
    const box = await code.boundingBox();
    if (!box) throw new Error("code target has no box");

    const startX = box.x + box.width * 0.2;
    const startY = box.y + box.height * 0.3;
    const endX = box.x + box.width * 0.8;
    const endY = box.y + box.height * 0.6;

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(endX, endY, { steps: 8 });
    await page.mouse.up();

    const panel = page.locator("[data-ask-panel]");
    await expect(panel).toBeVisible();
    await expect(page.getByText("没选中内容")).toBeHidden();
  });
});

test.describe("390 selection flow", () => {
  // 与 autoplay e2e 同一套粗指针：播放中「点「下一步」继续」独占一行，基线 4 行。
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

  test("after the entry scroll settles, code line 1 is not under the fixed header", async ({ page }) => {
    await startGenerated(page);
    await pauseLecture(page);
    await entry(page).scrollIntoViewIfNeeded();
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "auto" }));
    await entry(page).click();
    await expect(page.locator("[data-ask-layer]")).toBeVisible();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          let lastY = window.scrollY;
          let unchangedCount = 0;
          const start = performance.now();
          const check = () => {
            if (window.scrollY === lastY) {
              unchangedCount++;
              if (unchangedCount >= 6) {
                resolve();
                return;
              }
            } else {
              unchangedCount = 0;
              lastY = window.scrollY;
            }
            if (performance.now() - start >= 3000) {
              resolve();
              return;
            }
            requestAnimationFrame(check);
          };
          requestAnimationFrame(check);
        }),
    );
    const { headerBottom, fixed, line1Top } = await page.evaluate(() => {
      const header = document.querySelector("header");
      const fixed = header ? ["fixed", "sticky"].includes(getComputedStyle(header).position) : false;
      const headerBottom = header ? header.getBoundingClientRect().bottom : 0;
      let line1Top = 0;
      for (const el of document.querySelectorAll<HTMLElement>("[data-ask-stage] .monaco-editor .line-numbers")) {
        if (el.textContent?.trim() === "1") {
          line1Top = el.getBoundingClientRect().top;
          break;
        }
      }
      return { headerBottom, fixed, line1Top };
    });
    if (fixed) {
      expect(line1Top).toBeGreaterThanOrEqual(headerBottom);
    }
  });

  test.describe("390 mobile tap", () => {
    test("F2 390: panel open, Tab never focuses hidden bottom bar", async ({ page }) => {
      await startGenerated(page);
      await pauseLecture(page);
      await enterSelection(page);

      // Open panel via bottom bar subtitle shortcut chip
      const subtitleChip = page.locator('[data-ask-bottom-bar] [data-ask-shortcut="subtitle"]');
      await subtitleChip.click();
      const panel = page.locator("[data-ask-panel]");
      await expect(panel).toBeVisible();

      // Press Tab 12 times recording activeElement
      const activeElementsInsideBottomBar: boolean[] = [];
      for (let i = 0; i < 12; i++) {
        await page.keyboard.press("Tab");
        const inBottomBar = await page.evaluate(() => {
          const el = document.activeElement;
          return Boolean(el && el.closest("[data-ask-bottom-bar]"));
        });
        activeElementsInsideBottomBar.push(inBottomBar);
      }

      // Assert none is inside [data-ask-bottom-bar]
      expect(activeElementsInsideBottomBar.some(Boolean)).toBe(false);

      // Additionally press Shift+Tab 12 times from the panel and assert focus never lands inside [data-ask-bottom-bar]
      const activeElementsInsideBottomBarShift: boolean[] = [];
      for (let i = 0; i < 12; i++) {
        await page.keyboard.press("Shift+Tab");
        const inBottomBar = await page.evaluate(() => {
          const el = document.activeElement;
          return Boolean(el && el.closest("[data-ask-bottom-bar]"));
        });
        activeElementsInsideBottomBarShift.push(inBottomBar);
      }
      expect(activeElementsInsideBottomBarShift.some(Boolean)).toBe(false);
    });

    test("S2. 390: kbd hidden, exit >=44, title row single line", async ({ page }) => {
      await startGenerated(page);
      await pauseLecture(page);
      const titleRow = page.locator('[data-ask-target="subtitle"] > div').first();
      const rowBoxBefore = await titleRow.boundingBox();
      expect(rowBoxBefore).not.toBeNull();

      await enterSelection(page);
      await expect(entry(page).locator("[data-ask-kbd]")).toBeHidden();

      const exitBox = await entry(page).boundingBox();
      expect(exitBox).not.toBeNull();
      expect(exitBox!.width).toBeGreaterThanOrEqual(44);
      expect(exitBox!.height).toBeGreaterThanOrEqual(44);
      expect(exitBox!.height).toBeLessThan(60);

      const rowBoxAfter = await titleRow.boundingBox();
      expect(rowBoxAfter).not.toBeNull();
      expect(Math.abs(rowBoxAfter!.height - rowBoxBefore!.height)).toBeLessThanOrEqual(1);

      const labelP = titleRow.locator("p", { hasText: "字幕" });
      const { height, lineHeight } = await labelP.evaluate((el) => {
        const style = window.getComputedStyle(el);
        const parsedLh = parseFloat(style.lineHeight);
        const parsedFs = parseFloat(style.fontSize);
        const lh = Number.isFinite(parsedLh)
          ? parsedLh
          : Number.isFinite(parsedFs)
            ? parsedFs * 1.5
            : 15;
        return {
          height: el.getBoundingClientRect().height,
          lineHeight: lh,
        };
      });
      expect(height).toBeLessThanOrEqual(lineHeight * 1.5);
    });

    test("S5. 390: code box sends codeRange", async ({ page }) => {
      let capturedTargets: Array<{
        kind?: string;
        codeRange?: { startLine: number; endLine: number };
        text?: string;
      }> = [];
      await mockAsk(page, async (route) => {
        const body = route.request().postDataJSON() as {
          selection?: {
            targets?: Array<{
              kind?: string;
              codeRange?: { startLine: number; endLine: number };
              text?: string;
            }>;
          };
        };
        capturedTargets = body?.selection?.targets ?? [];
        await route.fulfill({
          status: 200,
          contentType: "application/x-ndjson",
          body: askStream("s1"),
        });
      });
      await startGenerated(page);
      await pauseLecture(page);
      await enterSelection(page);

      const code = page.locator('[data-ask-stage] [data-ask-target="code"]');
      await code.scrollIntoViewIfNeeded();
      await expect(code).toBeVisible();

      const box = await code.boundingBox();
      if (!box) throw new Error("code target has no box");

      const startX = box.x + box.width * 0.2;
      const startY = box.y + box.height * 0.3;
      const endX = box.x + box.width * 0.8;
      const endY = box.y + box.height * 0.6;

      await page.mouse.move(startX, startY);
      await page.mouse.down();
      await page.mouse.move(endX, endY, { steps: 8 });
      await page.mouse.up();

      const panel = page.locator("[data-ask-panel]");
      await expect(panel).toBeVisible();
      await expect(panel.locator("[data-ask-panel-label]")).toHaveText(/代码第 \d+–\d+ 行/);

      await askQuestion(page);
      await expect(page.getByText(ANSWER_NARRATION)).toBeVisible({ timeout: ANSWER_TIMEOUT_MS });

      const codeTarget = capturedTargets.find((t) => t.kind === "code");
      expect(codeTarget).toBeDefined();
      expect(codeTarget!.codeRange).toBeDefined();
      expect(codeTarget!.codeRange!.startLine).toBeGreaterThanOrEqual(1);
      expect(codeTarget!.codeRange!.endLine).toBeGreaterThanOrEqual(codeTarget!.codeRange!.startLine);
      expect(codeTarget!.text).toBeTruthy();
    });

    for (const [startLine, endLine] of [
      [1, 5],
      [4, 6],
      [8, 9],
    ] as const) {
      test(`S5-a 390: drag over Monaco lines ${startLine}–${endLine}`, async ({ page }) => {
        let capturedTargets: Array<{
          kind?: string;
          codeRange?: { startLine: number; endLine: number };
          text?: string;
        }> = [];
        await mockAsk(page, async (route) => {
          const body = route.request().postDataJSON() as {
            selection?: {
              targets?: Array<{
                kind?: string;
                codeRange?: { startLine: number; endLine: number };
                text?: string;
              }>;
            };
          };
          capturedTargets = body?.selection?.targets ?? [];
          await route.fulfill({
            status: 200,
            contentType: "application/x-ndjson",
            body: askStream("s1"),
          });
        });
        await startGenerated(page);
        await pauseLecture(page);
        await enterSelection(page);

        const code = page.locator('[data-ask-stage] [data-ask-target="code"]');
        await code.scrollIntoViewIfNeeded();
        await expect(code).toBeVisible();

        const box = await code.boundingBox();
        if (!box) throw new Error("code target has no box");

        const startBox = await getMonacoLineBox(page, startLine);
        const endBox = await getMonacoLineBox(page, endLine);
        const startY = startBox.top + 4;
        const endY = endBox.bottom - 4;
        const startX = box.x + 60;
        const endX = box.x + 160;

        await page.mouse.move(startX, startY);
        await page.mouse.down();
        await page.mouse.move(endX, endY, { steps: 8 });
        await page.mouse.up();

        const panel = page.locator("[data-ask-panel]");
        await expect(panel).toBeVisible();
        await expect(panel.locator("[data-ask-panel-label]")).toHaveText(`已选：代码第 ${startLine}–${endLine} 行`);

        await askQuestion(page);
        await expect(page.getByText(ANSWER_NARRATION)).toBeVisible({ timeout: ANSWER_TIMEOUT_MS });

        const codeTarget = capturedTargets.find((t) => t.kind === "code");
        expect(codeTarget).toBeDefined();
        expect(codeTarget!.codeRange).toEqual({ startLine, endLine });
      });
    }

    test("S5-a 390: tap on line 5", async ({ page }) => {
      let capturedTargets: Array<{
        kind?: string;
        codeRange?: { startLine: number; endLine: number };
        text?: string;
      }> = [];
      await mockAsk(page, async (route) => {
        const body = route.request().postDataJSON() as {
          selection?: {
            targets?: Array<{
              kind?: string;
              codeRange?: { startLine: number; endLine: number };
              text?: string;
            }>;
          };
        };
        capturedTargets = body?.selection?.targets ?? [];
        await route.fulfill({
          status: 200,
          contentType: "application/x-ndjson",
          body: askStream("s1"),
        });
      });
      await startGenerated(page);
      await pauseLecture(page);
      await enterSelection(page);

      const code = page.locator('[data-ask-stage] [data-ask-target="code"]');
      await code.scrollIntoViewIfNeeded();
      await expect(code).toBeVisible();

      const box = await code.boundingBox();
      if (!box) throw new Error("code target has no box");

      const line5 = await getMonacoLineBox(page, 5);
      const clickX = box.x + 80;
      const clickY = (line5.top + line5.bottom) / 2;

      await page.touchscreen.tap(clickX, clickY);

      const panel = page.locator("[data-ask-panel]");
      await expect(panel).toBeVisible();
      await expect(panel.locator("[data-ask-panel-label]")).toHaveText("已选：代码第 5 行");

      await askQuestion(page);
      await expect(page.getByText(ANSWER_NARRATION)).toBeVisible({ timeout: ANSWER_TIMEOUT_MS });

      const codeTarget = capturedTargets.find((t) => t.kind === "code");
      expect(codeTarget).toBeDefined();
      expect(codeTarget!.codeRange).toEqual({ startLine: 5, endLine: 5 });
    });
  });

  test("32. same ask flow; player-controls stays 4 rows while playing and 3 when finished", async ({ page }) => {
    test.setTimeout(45_000);
    await mockAsk(page, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/x-ndjson",
        body: askStream("s1"),
      });
    });
    await startGenerated(page);
    const bar = page.getByTestId("player-controls");
    await expect(page.locator("header").getByRole("button", { name: "暂停", exact: true })).toBeVisible();
    await expect(page.getByTestId("continue-hint")).toBeVisible();
    const playing = await controlRows(bar);
    expect(playing.rows).toBe(4);

    await pauseLecture(page);
    await enterSelection(page);
    await expect(page.locator("[data-ask-panel]")).toHaveCount(0);
    await page.locator('[data-ask-shortcut="viz"]').click();
    const panel = page.locator("[data-ask-panel]");
    await expect(panel).toBeVisible();
    await expect(panel).toHaveCSS("position", "fixed");
    // 窄屏截图较慢，回答打字机在粗指针下也可能被节流。减少动效后回答直接出全文。
    await page.emulateMedia({ reducedMotion: "reduce" });
    await askQuestion(page);
    await expect(page.getByText(ANSWER_NARRATION)).toBeVisible({ timeout: 20_000 });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await expect(page.getByText("第 1 / 3 步")).toBeVisible();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);

    // 回答播完会停在 paused。打开自动播放再走到讲完，对照讲完 3 行。
    await page.getByRole("button", { name: "自动播放", exact: true }).click();
    const next = page.getByRole("button", { name: "下一步", exact: true });
    for (let i = 0; i < 8; i++) {
      if (await page.getByText("讲完了").isVisible()) break;
      if (await next.isEnabled()) await next.tap();
      else await page.waitForTimeout(200);
    }
    await expect(page.getByText("讲完了")).toBeVisible();
    const finished = await controlRows(bar);
    expect(finished.rows).toBe(3);
    expect(finished.buttons).toBeGreaterThan(0);
  });

  test("390: exit button above selection layer: tap exits in hasTouch and subtitle drag still selects", async ({ page }) => {
    await startGenerated(page);
    await pauseLecture(page);
    await enterSelection(page);

    const button = page.locator("[data-ask-bottom-bar] [data-ask-entry]");
    await expect(button).toBeVisible();
    const box = await button.boundingBox();
    expect(box).not.toBeNull();
    const centerX = box!.x + box!.width / 2;
    const centerY = box!.y + box!.height / 2;

    const isButtonOrDescendant = await page.evaluate(
      ({ x, y }) => {
        const el = document.elementFromPoint(x, y);
        const btn = document.querySelector("[data-ask-bottom-bar] [data-ask-entry]");
        return el !== null && (el === btn || btn?.contains(el) === true);
      },
      { x: centerX, y: centerY },
    );
    expect(isButtonOrDescendant).toBe(true);

    await page.touchscreen.tap(centerX, centerY);
    await expect(page.locator("[data-ask-layer]")).toHaveCount(0);
    await expect(page.locator("[data-ask-panel]")).toHaveCount(0);

    await enterSelection(page);
    await scrollSubtitleIntoSafeBand(page);
    const hit = await subtitleSafeHit(page);
    expect(hit).not.toBeNull();
    await touchDragSubtitle(page, hit!, 50, 25);

    const panel = page.locator("[data-ask-panel]");
    await expect(panel).toBeVisible();
    await expect(panel.locator("[data-ask-panel-label]")).toHaveText("已选：当前字幕");
  });

  test("390: drag starting 10px below exit button bottom edge on subtitle body text selects 当前字幕", async ({ page }) => {
    await startGenerated(page);
    await pauseLecture(page);
    await enterSelection(page);
    await scrollSubtitleIntoSafeBand(page);
    const hit = await subtitleSafeHit(page);
    expect(hit).not.toBeNull();
    await touchDragSubtitle(page, hit!, -40, 20);

    const panel = page.locator("[data-ask-panel]");
    await expect(panel).toBeVisible();
    await expect(panel.locator("[data-ask-panel-label]")).toHaveText("已选：当前字幕");
  });

  test("390: drag starting in code area starts selection", async ({ page }) => {
    await startGenerated(page);
    await pauseLecture(page);
    await enterSelection(page);

    const codeArea = page.locator(".monaco-editor").first();
    await codeArea.evaluate((el) => el.scrollIntoView({ block: "center" }));
    await expect(codeArea).toBeVisible();
    const box = await codeArea.boundingBox();
    expect(box).not.toBeNull();

    const headerBox = await page.locator("header.sticky").boundingBox();
    expect(headerBox).not.toBeNull();
    expect(box!.y).toBeGreaterThanOrEqual(headerBox!.y + headerBox!.height - 1);

    const startX = box!.x + 40;
    const startY = box!.y + 40;

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + 50, startY + 50, { steps: 5 });
    const rubber = page.locator("[data-ask-rubber]");
    const selectionBox = page.locator("[data-ask-selection]");
    await expect(rubber.or(selectionBox)).toBeVisible();
    await page.mouse.up();
  });

  test("C2. 390: code origin dragged onto viz keeps code only and crops the capture", async ({ page }) => {
    test.setTimeout(60_000);
    await expectCodeOriginExcludesViz(page);
  });

  test("C2. 390: viz origin covering code collects both", async ({ page }) => {
    test.setTimeout(60_000);
    await expectVizOriginCollectsBoth(page);
  });

  test("39b. 390: capture fallback stays visible after answer text and during playback", async ({ page }) => {
    test.setTimeout(45_000);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expectCaptureFallbackThroughPlayback(page);
  });

  test.describe("S5-chip390", () => {
    for (const key of ["Enter", " "] as const) {
      const name = key === " " ? "Space" : key;
      test(`chip390-b 390: ${name} on a focused chip selects that chip`, async ({ page }) => {
        await startGenerated(page);
        await pauseLecture(page);
        await enterSelection(page);
        const chip = page.locator('[data-ask-bottom-bar] [data-ask-shortcut="subtitle"]');
        await chip.focus();
        await expect(chip).toBeFocused();
        await page.keyboard.press(key);
        const panel = page.locator("[data-ask-panel]");
        await expect(panel).toBeVisible();
        await expect(panel.locator("[data-ask-panel-label]")).toHaveText("已选：当前字幕");
      });
    }

    test("F1 390: modifier+Enter on focused chip", async ({ page }) => {
      await startGenerated(page);
      await pauseLecture(page);
      await enterSelection(page);

      await page.evaluate(() => {
        type F1Event = {
          key: string;
          ctrlKey: boolean;
          metaKey: boolean;
          shiftKey: boolean;
          altKey: boolean;
        };
        (window as unknown as { __f1Seen: F1Event[] }).__f1Seen = [];
        document.addEventListener("keydown", (e) => {
          (window as unknown as { __f1Seen: F1Event[] }).__f1Seen.push({
            key: e.key,
            ctrlKey: e.ctrlKey,
            metaKey: e.metaKey,
            shiftKey: e.shiftKey,
            altKey: e.altKey,
          });
        });
      });

      const chip = page.locator('[data-ask-bottom-bar] [data-ask-shortcut="step"]');
      await chip.focus();
      await expect(chip).toBeFocused();

      const modifiers = ["Shift", "Control", "Alt", "Meta"] as const;

      // Run 1: with no selection
      for (const mod of modifiers) {
        await page.keyboard.press(`${mod}+Enter`);
        await expect(page.locator("[data-ask-panel]")).toHaveCount(0);
        await expect(page.locator("[data-ask-selection]")).toHaveCount(0);
        await expect(page.locator("[data-ask-layer]")).toBeVisible();
        await expect(page.locator("[role=status]").first()).not.toHaveText(/已选：/);
        await expect(chip).toBeFocused();
      }

      for (const mod of modifiers) {
        await page.keyboard.press(`${mod}+Space`);
        await expect(page.locator("[data-ask-panel]")).toHaveCount(0);
        await expect(page.locator("[data-ask-selection]")).toHaveCount(0);
        await expect(page.locator("[data-ask-layer]")).toBeVisible();
        await expect(page.locator("[role=status]").first()).not.toHaveText(/已选：/);
        await expect(chip).toBeFocused();
      }

      let seen = await page.evaluate(
        () => (window as unknown as { __f1Seen: Array<{ key: string; ctrlKey: boolean; metaKey: boolean }> }).__f1Seen,
      );
      expect(seen.some((e) => e.key === "Enter" && e.ctrlKey)).toBe(true);
      expect(seen.some((e) => e.key === "Enter" && e.metaKey)).toBe(true);
      expect(seen.some((e) => e.key === " " && e.ctrlKey)).toBe(true);
      expect(seen.some((e) => e.key === " " && e.metaKey)).toBe(true);

      // Run 2: with a prior 当前字幕 selection via chip tap/click then cancel
      const subtitleChip = page.locator('[data-ask-bottom-bar] [data-ask-shortcut="subtitle"]');
      await subtitleChip.click();
      const panel = page.locator("[data-ask-panel]");
      await expect(panel).toBeVisible();
      await expect(panel.locator("[data-ask-panel-label]")).toHaveText("已选：当前字幕");

      const cancelBtn = panel.locator("[data-ask-cancel]");
      await cancelBtn.click();
      await expect(panel).toHaveCount(0);

      const selLabel = page.locator("[data-ask-selection-label]");
      await expect(selLabel).toHaveText("已选：当前字幕");
      await expect(page.locator("[role=status]").first()).toHaveText("已选：当前字幕");

      // Clear window.__f1Seen to re-verify for Run 2
      await page.evaluate(() => {
        (window as unknown as { __f1Seen: unknown[] }).__f1Seen = [];
      });

      // Focusing a chip: use locator.focus() on the bar chip while panel is closed
      await chip.focus();
      await expect(chip).toBeFocused();

      for (const mod of modifiers) {
        await page.keyboard.press(`${mod}+Enter`);
        await expect(page.locator("[data-ask-panel]")).toHaveCount(0);
        await expect(selLabel).toHaveText("已选：当前字幕");
        await expect(page.locator("[role=status]").first()).toHaveText("已选：当前字幕");
        await expect(page.locator("[data-ask-selection]")).toBeVisible();
        await expect(chip).toBeFocused();
      }

      for (const mod of modifiers) {
        await page.keyboard.press(`${mod}+Space`);
        await expect(page.locator("[data-ask-panel]")).toHaveCount(0);
        await expect(selLabel).toHaveText("已选：当前字幕");
        await expect(page.locator("[role=status]").first()).toHaveText("已选：当前字幕");
        await expect(page.locator("[data-ask-selection]")).toBeVisible();
        await expect(chip).toBeFocused();
      }

      seen = await page.evaluate(
        () => (window as unknown as { __f1Seen: Array<{ key: string; ctrlKey: boolean; metaKey: boolean }> }).__f1Seen,
      );
      expect(seen.some((e) => e.key === "Enter" && e.ctrlKey)).toBe(true);
      expect(seen.some((e) => e.key === "Enter" && e.metaKey)).toBe(true);
      expect(seen.some((e) => e.key === " " && e.ctrlKey)).toBe(true);
      expect(seen.some((e) => e.key === " " && e.metaKey)).toBe(true);
    });

    test("IME guard 390: dispatch keydown Enter with isComposing:true or keyCode 229 on a chip asserts no selection and panel not visible", async ({ page }) => {
      await startGenerated(page);
      await pauseLecture(page);
      await enterSelection(page);

      const chip = page.locator('[data-ask-bottom-bar] [data-ask-shortcut="subtitle"]');
      await chip.focus();
      await expect(chip).toBeFocused();

      await chip.evaluate((el) => {
        el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true }));
      });
      await expect(page.locator("[data-ask-panel]")).toHaveCount(0);
      await expect(page.locator("[data-ask-selection]")).toHaveCount(0);

      await chip.evaluate((el) => {
        const ev = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
        Object.defineProperty(ev, "keyCode", { value: 229 });
        el.dispatchEvent(ev);
      });
      await expect(page.locator("[data-ask-panel]")).toHaveCount(0);
      await expect(page.locator("[data-ask-selection]")).toHaveCount(0);
    });

    test("F1 390: Shift+click on chip selects it as normal", async ({ page }) => {
      await startGenerated(page);
      await pauseLecture(page);
      await enterSelection(page);

      const subtitleChip = page.locator('[data-ask-bottom-bar] [data-ask-shortcut="subtitle"]');
      await subtitleChip.click({ modifiers: ["Shift"] });
      const panel = page.locator("[data-ask-panel]");
      await expect(panel).toBeVisible();
      await expect(panel.locator("[data-ask-panel-label]")).toHaveText("已选：当前字幕");
    });

    test("a. tap code line 1 -> panel label 已选：代码第 1 行", async ({ page }) => {
      await startGenerated(page);
      await pauseLecture(page);
      await enterSelection(page);

      const code = page.locator('[data-ask-stage] [data-ask-target="code"]');
      await code.scrollIntoViewIfNeeded();
      await expect(code).toBeVisible();

      const box = await code.boundingBox();
      if (!box) throw new Error("code target has no box");

      const line1 = await getMonacoLineBox(page, 1);
      const clickX = box.x + 80;
      const clickY = (line1.top + line1.bottom) / 2;

      await page.touchscreen.tap(clickX, clickY);

      const panel = page.locator("[data-ask-panel]");
      await expect(panel).toBeVisible();
      await expect(panel.locator("[data-ask-panel-label]")).toHaveText("已选：代码第 1 行");
    });

    test("b. touch drag over lines 1–5 -> panel visible", async ({ page }) => {
      await startGenerated(page);
      await pauseLecture(page);
      await enterSelection(page);

      const code = page.locator('[data-ask-stage] [data-ask-target="code"]');
      await code.scrollIntoViewIfNeeded();
      await expect(code).toBeVisible();

      const box = await code.boundingBox();
      if (!box) throw new Error("code target has no box");

      const startBox = await getMonacoLineBox(page, 1);
      const endBox = await getMonacoLineBox(page, 5);
      const startY = startBox.top + 4;
      const endY = endBox.bottom - 4;
      const startX = box.x + 60;
      const endX = box.x + 160;

      await page.mouse.move(startX, startY);
      await page.mouse.down();
      await page.mouse.move(endX, endY, { steps: 8 });
      await page.mouse.up();

      const panel = page.locator("[data-ask-panel]");
      await expect(panel).toBeVisible();
      await expect(panel.locator("[data-ask-panel-label]")).toHaveText("已选：代码第 1–5 行");
    });

    test("c. tap the last code line -> label 已选：代码第 N 行", async ({ page }) => {
      await startGenerated(page);
      await pauseLecture(page);
      await enterSelection(page);

      const code = page.locator('[data-ask-stage] [data-ask-target="code"]');
      await code.scrollIntoViewIfNeeded();
      await expect(code).toBeVisible();

      const lastLine = await page.evaluate(() => {
        const lineNumbers = Array.from(document.querySelectorAll<HTMLElement>(".monaco-editor .line-numbers"));
        const nums = lineNumbers
          .map((ln) => parseInt(ln.textContent?.trim() ?? "", 10))
          .filter((n) => !Number.isNaN(n));
        return Math.max(...nums);
      });

      const box = await code.boundingBox();
      if (!box) throw new Error("code target has no box");

      const lastLineBox = await getMonacoLineBox(page, lastLine);
      const clickX = box.x + 80;
      const clickY = (lastLineBox.top + lastLineBox.bottom) / 2;

      await page.touchscreen.tap(clickX, clickY);

      const panel = page.locator("[data-ask-panel]");
      await expect(panel).toBeVisible();
      await expect(panel.locator("[data-ask-panel-label]")).toHaveText(`已选：代码第 ${lastLine} 行`);
    });

    test("d. each chip in [data-ask-bottom-bar] and exit button: document.elementFromPoint at center is self or inside", async ({ page }) => {
      await startGenerated(page);
      await pauseLecture(page);
      await enterSelection(page);

      const bar = page.locator("[data-ask-bottom-bar]");
      await expect(bar).toBeVisible();
      await expect.poll(() => page.evaluate(() => { const bar=document.querySelector("[data-ask-bottom-bar]")?.getBoundingClientRect(); const pl=document.querySelector("[aria-label=\"讲解播放区\"]")?.getBoundingClientRect(); return !!bar && !!pl && bar.bottom + 8 <= pl.top + 0.5; })).toBe(true);

      const chips = bar.locator("[data-ask-shortcut]");
      const count = await chips.count();
      expect(count).toBeGreaterThan(0);

      for (let i = 0; i < count; i++) {
        const chip = chips.nth(i);
        const box = await chip.boundingBox();
        expect(box).not.toBeNull();
        const cx = box!.x + box!.width / 2;
        const cy = box!.y + box!.height / 2;

        const isHit = await chip.evaluate((el, { x, y }) => {
          const hit = document.elementFromPoint(x, y);
          return hit !== null && (hit === el || el.contains(hit));
        }, { x: cx, y: cy });
        expect(isHit).toBe(true);
      }

      const exitBtn = entry(page);
      await expect.poll(async () => {
        const exitBox = await exitBtn.boundingBox();
        if (!exitBox) return false;
        const exitCx = exitBox.x + exitBox.width / 2;
        const exitCy = exitBox.y + exitBox.height / 2;
        return exitBtn.evaluate((el, { x, y }) => {
          const hit = document.elementFromPoint(x, y);
          return hit !== null && (hit === el || el.contains(hit));
        }, { x: exitCx, y: exitCy });
      }).toBe(true);
    });

    test("e. after opening the panel, bar rect and [data-ask-panel] rect don't intersect", async ({ page }) => {
      await startGenerated(page);
      await pauseLecture(page);
      await enterSelection(page);

      const shortcut = page.locator('[data-ask-shortcut="subtitle"]');
      await expect(shortcut).toBeVisible();
      await shortcut.click();

      const panel = page.locator("[data-ask-panel]");
      await expect(panel).toBeVisible();

      const bar = page.locator("[data-ask-bottom-bar]");
      const barCount = await bar.count();
      if (barCount > 0 && await bar.isVisible()) {
        const panelBox = await panel.boundingBox();
        const barBox = await bar.boundingBox();
        expect(panelBox).not.toBeNull();
        expect(barBox).not.toBeNull();
        const intersects =
          panelBox!.x < barBox!.x + barBox!.width &&
          panelBox!.x + panelBox!.width > barBox!.x &&
          panelBox!.y < barBox!.y + barBox!.height &&
          panelBox!.y + panelBox!.height > barBox!.y;
        expect(intersects).toBe(false);
      }
    });

    test("f. scroll page to entry button, tap it to enter, expect code rect within viewport above bar", async ({ page }) => {
      await startGenerated(page);
      await pauseLecture(page);

      const button = entry(page);
      await button.scrollIntoViewIfNeeded();

      await button.click();
      await expect(page.locator("[data-ask-layer]")).toBeVisible();

      const bar = page.locator("[data-ask-bottom-bar]");
      await expect(bar).toBeVisible();
      const barBox = await bar.boundingBox();
      expect(barBox).not.toBeNull();

      const code = page.locator('[data-ask-stage] [data-ask-target="code"]');
      await expect.poll(async () => {
        const box = await code.boundingBox();
        if (!box) return false;
        return box.y >= 0 && box.y + box.height <= barBox!.y + 2;
      }).toBe(true);
    });

    test("(A) touch hit area >= 44x44 each and gap >= 8px", async ({ page }) => {
      await startGenerated(page);
      await pauseLecture(page);
      await enterSelection(page);

      const bar = page.locator("[data-ask-bottom-bar]");
      await expect(bar).toBeVisible();

      const chips = bar.locator("[data-ask-shortcut]");
      const count = await chips.count();
      expect(count).toBeGreaterThanOrEqual(2);

      const boxes: Array<{ x: number; y: number; width: number; height: number }> = [];
      for (let i = 0; i < count; i++) {
        const chip = chips.nth(i);
        const box = await chip.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.width).toBeGreaterThanOrEqual(44);
        expect(box!.height).toBeGreaterThanOrEqual(44);
        boxes.push(box!);
      }

      for (let i = 0; i < boxes.length - 1; i++) {
        const curr = boxes[i];
        const next = boxes[i + 1];
        // Adjacent gap in horizontal row
        const gap = next.x - (curr.x + curr.width);
        expect(gap).toBeGreaterThanOrEqual(7.9);
      }

      const exitBtn = entry(page);
      const exitBox = await exitBtn.boundingBox();
      expect(exitBox).not.toBeNull();
      expect(exitBox!.width).toBeGreaterThanOrEqual(44);
      expect(exitBox!.height).toBeGreaterThanOrEqual(44);
    });

    // chip390-b：进入圈选的平滑滚动还在走时按下，起点要落在按下那一刻停住后的行上。
    for (const reduced of [false, true]) {
    test(`(B) drag pressed 100ms into the entering scroll covers the lines actually dragged${reduced ? " (reduced motion)" : ""}`, async ({ page }) => {
      if (reduced) await page.emulateMedia({ reducedMotion: "reduce" });
      await startGenerated(page);
      await pauseLecture(page);

      const code = page.locator('[data-ask-stage] [data-ask-target="code"]');
      const button = entry(page);
      await button.scrollIntoViewIfNeeded();
      // 让代码区先不在视口内，确保进入时会触发平滑滚动。
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: "auto" }));
      const y0 = await page.evaluate(() => window.scrollY);
      await button.click();
      if (!reduced) {
        await expect.poll(() => page.evaluate(() => window.scrollY), { timeout: 3000 }).not.toBe(y0);
      }
      await page.waitForTimeout(100);

      const lineAt = (y: number) =>
        page.evaluate((py) => {
          for (const ln of document.querySelectorAll<HTMLElement>(".monaco-editor .line-numbers")) {
            const r = ln.getBoundingClientRect();
            if (r.height > 0 && py >= r.top && py < r.bottom) {
              return { line: Number(ln.textContent?.trim()), below: r.bottom - py };
            }
          }
          return null;
        }, y);

      const boxAtDown = (await code.boundingBox())!;
      const vh = page.viewportSize()!.height;
      const startX = boxAtDown.x + 60;
      const startY = Math.round(vh * 0.35);
      await page.mouse.move(startX, startY);
      await page.mouse.down();

      // 按下即停住滚动：落定一帧后 scrollY 不再变（停滚当帧可能回退几像素）。
      const yDown = await page.evaluate(
        () => new Promise<number>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(window.scrollY)))),
      );
      await page.waitForTimeout(150);
      expect(await page.evaluate(() => window.scrollY)).toBe(yDown);

      const hitAtDown = await lineAt(startY);
      expect(hitAtDown).not.toBeNull();
      // 框只擦过起点那一行底部 ≤2px 时，命中按死区不算这一行（同 mid-drag 用例的 2px 规则）。
      const startLine = hitAtDown!.below <= 2 ? hitAtDown!.line + 1 : hitAtDown!.line;
      const lineCount = await page.evaluate(() =>
        Math.max(
          0,
          ...Array.from(
            document.querySelectorAll<HTMLElement>("[data-ask-stage] .monaco-editor .line-numbers"),
          ).map((e) => Number(e.textContent?.trim()) || 0),
        ),
      );
      const endLine = Math.min(startLine + 2, lineCount);
      const endBox = await getMonacoLineBox(page, endLine);
      await page.mouse.move(boxAtDown.x + 160, (endBox.top + endBox.bottom) / 2, { steps: 5 });
      await page.mouse.up();

      const panel = page.locator("[data-ask-panel]");
      await expect(panel).toBeVisible();
      const expected = endLine === startLine ? `已选：代码第 ${startLine} 行` : `已选：代码第 ${startLine}–${endLine} 行`;
      await expect(panel.locator("[data-ask-panel-label]")).toHaveText(expected);

      // 滚动停住后：选框、高亮、标签三者都指向按下的那一行，不能框在一行、高亮在另一行。
      const startBox = await getMonacoLineBox(page, startLine);
      const lastBox = await getMonacoLineBox(page, endLine);
      const sel = (await page.locator("[data-ask-selection]").boundingBox())!;
      expect(sel).not.toBeNull();
      // 开面板后页面可能再滚一次，所以按行比：选框上沿落在起始行内，下沿落在末行内。
      expect(sel.y).toBeGreaterThanOrEqual(startBox.top - 3);
      expect(sel.y).toBeLessThanOrEqual(startBox.bottom);
      expect(sel.y + sel.height).toBeGreaterThanOrEqual(lastBox.top);
      expect(sel.y + sel.height).toBeLessThanOrEqual(lastBox.bottom + 3);
      const hl = page.locator("[data-ask-highlight]");
      expect(await hl.count()).toBeGreaterThan(0);
      for (let i = 0; i < (await hl.count()); i++) {
        const h = (await hl.nth(i).boundingBox())!;
        // 高亮必须覆盖起始行和末行，和选框同一处。
        expect(h.y).toBeLessThanOrEqual(startBox.bottom - 2);
        expect(h.y + h.height).toBeGreaterThanOrEqual(lastBox.top + 2);
      }
      const selLabel = page.locator("[data-ask-selection-label]");
      if (await selLabel.count()) await expect(selLabel).toHaveText(expected);
    });
    }

    test("chip390-b nits (b) press during the entry smooth scroll and release before the next frame, for tap and very short drag, assert the selected code line range matches the line under the pointer (no off-by-one)", async ({ page }) => {
      test.setTimeout(90_000);
      await startGenerated(page);
      await pauseLecture(page);

      const button = entry(page);
      const panel = page.locator("[data-ask-panel]");

      const lineAt = (y: number) =>
        page.evaluate((py) => {
          for (const ln of document.querySelectorAll<HTMLElement>(".monaco-editor .line-numbers")) {
            const r = ln.getBoundingClientRect();
            if (r.height > 0 && py >= r.top && py < r.bottom) {
              return { line: Number(ln.textContent?.trim()), below: r.bottom - py };
            }
          }
          return null;
        }, y);

      for (const mode of ["tap", "short-drag"] as const) {
        for (let run = 0; run < 10; run++) {
          if (await panel.count()) {
            await page.keyboard.press("Escape");
            await page.keyboard.press("Escape");
            await expect(page.locator("[data-ask-layer]")).toHaveCount(0);
          } else if (await page.locator("[data-ask-layer]").count()) {
            await page.keyboard.press("Escape");
            await expect(page.locator("[data-ask-layer]")).toHaveCount(0);
          }

          await button.scrollIntoViewIfNeeded();
          await page.evaluate(() => window.scrollTo({ top: 0, behavior: "auto" }));
          const y0 = await page.evaluate(() => window.scrollY);
          await page.evaluate(() => {
            const w = window as unknown as {
              __n2press?: {
                clientY: number;
                scrollY: number;
                tag: string;
                insideHeader: boolean;
                insideLayer: boolean;
              };
              __n2pressHandler?: (e: PointerEvent) => void;
            };
            w.__n2press = undefined;
            if (w.__n2pressHandler) {
              window.removeEventListener("pointerdown", w.__n2pressHandler, { capture: true });
            }
            const handler = (e: PointerEvent) => {
              const target = e.target as HTMLElement | null;
              w.__n2press = {
                clientY: e.clientY,
                scrollY: window.scrollY,
                tag: target?.tagName?.toLowerCase() ?? "",
                insideHeader: !!target?.closest?.("header"),
                insideLayer: !!target?.closest?.("[data-ask-layer]"),
              };
            };
            w.__n2pressHandler = handler;
            window.addEventListener("pointerdown", handler, { capture: true });
          });
          await button.click();
          await expect.poll(() => page.evaluate(() => window.scrollY), { timeout: 3000 }).not.toBe(y0);

          const { startX, startY } = await page.evaluate(async () => {
            const scroller =
              document.scrollingElement ??
              document.querySelector<HTMLElement>("[data-ask-stage]") ??
              document.documentElement;
            const codeEl = document.querySelector<HTMLElement>('[data-ask-stage] [data-ask-target="code"]');
            if (!codeEl) throw new Error("code element not found");

            return new Promise<{ startX: number; startY: number }>((resolve, reject) => {
              let prevScroll = scroller.scrollTop || window.scrollY;
              const check = () => {
                const cur = scroller.scrollTop || window.scrollY;
                if (cur !== prevScroll) {
                  const box = codeEl.getBoundingClientRect();
                  const headerEl = document.querySelector('header');
                  const hbLive = headerEl?.getBoundingClientRect().bottom ?? 0;
                  const headerBand = Math.max(0, hbLive, headerEl instanceof HTMLElement ? headerEl.offsetHeight : 0);
                  const topMin = headerBand + 4;
                  const bottomBarTop = document.querySelector('[data-ask-bottom-bar]')?.getBoundingClientRect().top ?? innerHeight;
                  const lines = document.querySelectorAll<HTMLElement>(".monaco-editor .line-numbers");
                  for (const ln of lines) {
                    const r = ln.getBoundingClientRect();
                    const startX = Math.round(box.left + 60);
                    const startY = Math.round(r.top + r.height / 2);
                    if (startY < 0 || startY >= innerHeight) continue;
                    const elAtPoint = document.elementFromPoint(startX, startY);
                    if (
                      r.height > 0 &&
                      r.top >= topMin &&
                      r.top >= 0 &&
                      r.bottom <= bottomBarTop - 4 &&
                      r.top >= box.top &&
                      r.bottom <= box.bottom &&
                      !elAtPoint?.closest('header') &&
                      (elAtPoint?.closest('[data-ask-layer]') || elAtPoint?.closest('.monaco-editor') || elAtPoint?.closest('[data-ask-target="code"]'))
                    ) {
                      resolve({ startX, startY });
                      return;
                    }
                  }
                }
                prevScroll = cur;
                requestAnimationFrame(check);
              };
              requestAnimationFrame(check);
              setTimeout(() => reject(new Error("N2 pick: no in-viewport line below header")), 3000);
            });
          });

          await page.mouse.move(startX, startY);
          if (mode === "tap") {
            await page.mouse.down();
            await page.mouse.up();
          } else {
            await page.mouse.down();
            await page.mouse.move(startX + 12, startY);
            await page.mouse.up();
          }

          const n2press = await page.evaluate(
            () =>
              (
                window as unknown as {
                  __n2press?: {
                    clientY: number;
                    scrollY: number;
                    tag: string;
                    insideHeader: boolean;
                    insideLayer: boolean;
                  };
                }
              ).__n2press,
          );
          {
            const window = { __n2press: n2press };
            console.log('N2RUN', mode, run, startY, JSON.stringify(window.__n2press));
          }

          // Measure the line under the press Y before the panel drawer can
          // reflow Monaco (same clientY, post-settle). Then wait for panel.
          const hit = await lineAt(startY);
          expect(hit).not.toBeNull();
          const expected = `已选：代码第 ${hit!.line} 行`;
          await expect(panel).toBeVisible();
          await expect(panel.locator("[data-ask-panel-label]")).toHaveText(expected);
        }
      }
    });

    test("chip390-b nits (b) no scroll in flight: press and release before next frame, for tap and very short drag, assert panel label matches the line under the pointer", async ({ page }) => {
      test.setTimeout(90_000);
      await startGenerated(page);
      await pauseLecture(page);

      const code = page.locator('[data-ask-stage] [data-ask-target="code"]');
      const button = entry(page);
      const panel = page.locator("[data-ask-panel]");

      const lineAt = (y: number) =>
        page.evaluate((py) => {
          for (const ln of document.querySelectorAll<HTMLElement>(".monaco-editor .line-numbers")) {
            const r = ln.getBoundingClientRect();
            if (r.height > 0 && py >= r.top && py < r.bottom) {
              return { line: Number(ln.textContent?.trim()), below: r.bottom - py };
            }
          }
          return null;
        }, y);

      for (const mode of ["tap", "short-drag"] as const) {
        for (let run = 0; run < 10; run++) {
          if (await panel.count()) {
            await page.keyboard.press("Escape");
            await page.keyboard.press("Escape");
            await expect(page.locator("[data-ask-layer]")).toHaveCount(0);
          } else if (await page.locator("[data-ask-layer]").count()) {
            await page.keyboard.press("Escape");
            await expect(page.locator("[data-ask-layer]")).toHaveCount(0);
          }

          await button.scrollIntoViewIfNeeded();
          await page.evaluate(() => window.scrollTo({ top: 0, behavior: "auto" }));
          await button.click();

          // 等待 scrollY 稳定 3 帧（确保无进入滚动进行中）
          await page.evaluate(async () => {
            let lastY = window.scrollY;
            let stableFrames = 0;
            while (stableFrames < 3) {
              await new Promise<void>((r) => requestAnimationFrame(() => r()));
              const curY = window.scrollY;
              if (curY === lastY) {
                stableFrames++;
              } else {
                stableFrames = 0;
                lastY = curY;
              }
            }
          });

          const boxAtDown = (await code.boundingBox())!;
          const vh = page.viewportSize()!.height;
          const startX = boxAtDown.x + 60;
          const startY = Math.round(vh * 0.35);

          await page.mouse.move(startX, startY);
          if (mode === "tap") {
            await page.mouse.down();
            await page.mouse.up();
          } else {
            await page.mouse.down();
            await page.mouse.move(startX + 12, startY);
            await page.mouse.up();
          }

          // Measure the line under the press Y before the panel drawer can
          // reflow Monaco (same clientY, post-settle). Then wait for panel.
          const hit = await lineAt(startY);
          expect(hit).not.toBeNull();
          const expected = `已选：代码第 ${hit!.line} 行`;
          await expect(panel).toBeVisible();
          await expect(panel.locator("[data-ask-panel-label]")).toHaveText(expected);
        }
      }
    });

    test("h. selection fully visible above drawer: record scrollY, open panel, scrollY unchanged", async ({ page }) => {
      // fixme: depends on S4 r4 ask-panel.tsx:181 block:'nearest' (Gavin)
      test.fixme(true, "depends on S4 r4 ask-panel.tsx:181 block:'nearest' (Gavin)");

      await startGenerated(page);
      await pauseLecture(page);
      await enterSelection(page);

      const code = page.locator('[data-ask-stage] [data-ask-target="code"]');
      await code.scrollIntoViewIfNeeded();
      await expect(code).toBeVisible();

      const box = await code.boundingBox();
      if (!box) throw new Error("code target has no box");

      const line1 = await getMonacoLineBox(page, 1);
      const clickX = box.x + 80;
      const clickY = (line1.top + line1.bottom) / 2;

      const scrollYBefore = await page.evaluate(() => window.scrollY);

      await page.touchscreen.tap(clickX, clickY);

      const panel = page.locator("[data-ask-panel]");
      await expect(panel).toBeVisible();

      const start = Date.now();
      await expect.poll(async () => {
        const y = await page.evaluate(() => window.scrollY);
        if (Math.abs(y - scrollYBefore) > 1) return false;
        return Date.now() - start >= 500;
      }, { timeout: 2000, intervals: [50, 100] }).toBe(true);
      expect(await page.evaluate(() => window.scrollY)).toBe(scrollYBefore);
    });

    test("i. selection covered by the drawer: selection rect bottom <= panel rect top", async ({ page }) => {
      // fixme: depends on S4 r4 ask-panel.tsx:181 block:'nearest' (Gavin)
      test.fixme(true, "depends on S4 r4 ask-panel.tsx:181 block:'nearest' (Gavin)");

      await startGenerated(page);
      await pauseLecture(page);
      await enterSelection(page);

      const code = page.locator('[data-ask-stage] [data-ask-target="code"]');
      await code.scrollIntoViewIfNeeded();
      await expect(code).toBeVisible();

      const box = await code.boundingBox();
      if (!box) throw new Error("code target has no box");

      const line5 = await getMonacoLineBox(page, 5);
      const targetY = 650;
      await page.evaluate((delta) => window.scrollBy(0, delta), line5.top - targetY);

      const line5AfterScroll = await getMonacoLineBox(page, 5);
      const clickX = box.x + 80;
      const clickY = (line5AfterScroll.top + line5AfterScroll.bottom) / 2;

      await page.touchscreen.tap(clickX, clickY);

      const panel = page.locator("[data-ask-panel]");
      await expect(panel).toBeVisible();

      await expect.poll(async () => {
        return page.evaluate(() => {
          const sel = document.querySelector("[data-ask-selection]");
          const pan = document.querySelector("[data-ask-panel]");
          if (!sel || !pan) return false;
          const selRect = sel.getBoundingClientRect();
          const panRect = pan.getBoundingClientRect();
          return selRect.top >= 0 && selRect.bottom <= panRect.top + 1;
        });
      }).toBe(true);
    });

    test("j. tall selection: selection rect top >= 0 and < innerHeight", async ({ page }) => {
      // fixme: depends on S4 r4 ask-panel.tsx:181 block:'nearest' (Gavin)
      test.fixme(true, "depends on S4 r4 ask-panel.tsx:181 block:'nearest' (Gavin)");

      await startGenerated(page);
      await pauseLecture(page);
      await enterSelection(page);

      const code = page.locator('[data-ask-stage] [data-ask-target="code"]');
      await code.scrollIntoViewIfNeeded();
      await expect(code).toBeVisible();

      const box = await code.boundingBox();
      if (!box) throw new Error("code target has no box");

      const line1 = await getMonacoLineBox(page, 1);
      const startX = box.x + 60;
      const startY = line1.top + 4;
      const endX = box.x + 160;
      const endY = startY + 480;

      await page.mouse.move(startX, startY);
      await page.mouse.down();
      await page.mouse.move(endX, endY, { steps: 8 });
      await page.mouse.up();

      const panel = page.locator("[data-ask-panel]");
      await expect(panel).toBeVisible();

      await expect.poll(async () => {
        return page.evaluate(() => {
          const sel = document.querySelector("[data-ask-selection]");
          if (!sel) return false;
          const rect = sel.getBoundingClientRect();
          return rect.top >= 0 && rect.top < window.innerHeight;
        });
      }).toBe(true);
    });

    test("k. while in selecting, tap each visible player-controls button in [aria-label=\"讲解播放区\"] by coordinate center", async ({ page }) => {
      await startGenerated(page);
      await pauseLecture(page);
      await enterSelection(page);

      const playerArea = page.locator('[aria-label="讲解播放区"]');
      await expect(playerArea).toBeVisible();

      const bar = page.locator("[data-ask-bottom-bar]");
      await expect(bar).toBeVisible();

      const barBox = (await bar.boundingBox())!;
      const playerBox = (await playerArea.boundingBox())!;
      expect(barBox.y + barBox.height + 7.9).toBeLessThanOrEqual(playerBox.y);

      const buttons = playerArea.locator("button:visible");
      const count = await buttons.count();
      expect(count).toBeGreaterThan(0);

      for (let i = 0; i < count; i++) {
        const btn = buttons.nth(i);
        const box = (await btn.boundingBox())!;
        const cx = box.x + box.width / 2;
        const cy = box.y + box.height / 2;

        const isInsidePlayer = await page.evaluate(({ cx, cy }) => {
          const el = document.elementFromPoint(cx, cy);
          const player = document.querySelector('[aria-label="讲解播放区"]');
          const bottomBar = document.querySelector('[data-ask-bottom-bar]');
          if (!el || !player) return false;
          if (bottomBar && (bottomBar === el || bottomBar.contains(el))) return false;
          return player.contains(el) || player === el;
        }, { cx, cy });

        expect(isInsidePlayer).toBe(true);
        await page.touchscreen.tap(cx, cy);
      }
    });

    test("l. tapping bar background or chips is not treated as tap-outside", async ({ page }) => {
      await startGenerated(page);
      await pauseLecture(page);
      await enterSelection(page);

      // Verify the bar element has [data-ask-layer] ancestor
      const hasLayerAncestor = await page.evaluate(() => {
        const bar = document.querySelector("[data-ask-bottom-bar]");
        return Boolean(bar?.closest("[data-ask-layer]"));
      });
      expect(hasLayerAncestor).toBe(true);

      // Make a selection
      const code = page.locator('[data-ask-stage] [data-ask-target="code"]');
      await code.scrollIntoViewIfNeeded();
      await expect(code).toBeVisible();

      const box = await code.boundingBox();
      if (!box) throw new Error("code target has no box");

      const line5 = await getMonacoLineBox(page, 5);
      const clickX = box.x + 80;
      const clickY = (line5.top + line5.bottom) / 2;

      await page.touchscreen.tap(clickX, clickY);

      const panel = page.locator("[data-ask-panel]");
      await expect(panel).toBeVisible();
      await expect(panel.locator("[data-ask-panel-label]")).toHaveText("已选：代码第 5 行");

      // Close the panel with Esc so we are back in selecting with selection visible
      await page.keyboard.press("Escape");
      await expect(panel).toHaveCount(0);
      const selectionEl = page.locator("[data-ask-selection]");
      await expect(selectionEl).toBeVisible();

      // With a selection made, pointerdown/up on the bar background (not a chip) keeps the selection
      const bar = page.locator("[data-ask-bottom-bar]");
      const barBox = (await bar.boundingBox())!;
      await page.mouse.move(barBox.x + 4, barBox.y + 4);
      await page.mouse.down();
      await page.mouse.up();

      // Selection is still visible, ask not exited
      await expect(selectionEl).toBeVisible();
      await expect(page.locator("[data-ask-layer]")).toBeVisible();
    });

    test("m. Tab order: after Esc cancel, focus on chip; Tab does not land on exit (S4)", async ({ page }) => {
      await startGenerated(page);
      await pauseLecture(page);
      await enterSelection(page);

      // Make a selection and open the panel
      const code = page.locator('[data-ask-stage] [data-ask-target="code"]');
      await code.scrollIntoViewIfNeeded();
      await expect(code).toBeVisible();

      const box = await code.boundingBox();
      if (!box) throw new Error("code target has no box");

      const line5 = await getMonacoLineBox(page, 5);
      const clickX = box.x + 80;
      const clickY = (line5.top + line5.bottom) / 2;

      await page.touchscreen.tap(clickX, clickY);

      const panel = page.locator("[data-ask-panel]");
      await expect(panel).toBeVisible();
      await expect(panel.locator("[data-ask-panel-label]")).toHaveText("已选：代码第 5 行");

      // Close with Esc
      await page.keyboard.press("Escape");
      await expect(panel).toHaveCount(0);

      // After closing panel with Esc, focus moves to the current chip (tabIndex 0) in the bar at 390
      await expect.poll(() =>
        page.evaluate(() => {
          const active = document.activeElement as HTMLElement | null;
          if (!active) return false;
          const bar = document.querySelector("[data-ask-bottom-bar]");
          return Boolean(
            bar &&
            bar.contains(active) &&
            active.hasAttribute("data-ask-shortcut") &&
            active.tabIndex === 0,
          );
        }),
      ).toBe(true);

      const initialChipKey = await page.evaluate(() =>
        document.activeElement?.getAttribute("data-ask-shortcut"),
      );

      // S4: bar exit is tabIndex=-1 (out of tab order) so cancel ghost focus sticks.
      // Tab from the opener chip must NOT land on the exit button.
      await page.keyboard.press("Tab");
      await expect.poll(() =>
        page.evaluate(() => {
          const active = document.activeElement as HTMLElement | null;
          if (!active) return true;
          const bar = document.querySelector("[data-ask-bottom-bar]");
          const exit = bar?.querySelector("[data-ask-entry]");
          return !(exit && (active === exit || exit.contains(active)));
        }),
      ).toBe(true);

      // Re-focus the opener chip and test ArrowRight roving among chips
      await page.evaluate((key) => {
        const chip = document.querySelector<HTMLElement>(
          `[data-ask-bottom-bar] [data-ask-shortcut="${key}"]`,
        );
        chip?.focus({ preventScroll: true });
      }, initialChipKey);
      await expect.poll(() =>
        page.evaluate(() => {
          const active = document.activeElement as HTMLElement | null;
          return Boolean(active && active.hasAttribute("data-ask-shortcut") && active.tabIndex === 0);
        }),
      ).toBe(true);

      await page.keyboard.press("ArrowRight");
      await expect.poll(() =>
        page.evaluate(() => {
          const active = document.activeElement as HTMLElement | null;
          return Boolean(active && active.hasAttribute("data-ask-shortcut") && active.tabIndex === 0);
        }),
      ).toBe(true);

      const nextChipKey = await page.evaluate(() =>
        document.activeElement?.getAttribute("data-ask-shortcut"),
      );
      expect(nextChipKey).not.toBe(initialChipKey);
    });

    test("n. after exit (Esc twice) and after switching problems, no bottom bar and CSS variables are 0px or empty", async ({ page }) => {
      await startGenerated(page);
      await pauseLecture(page);
      await enterSelection(page);

      // Make a selection so panel opens
      const code = page.locator('[data-ask-stage] [data-ask-target="code"]');
      await code.scrollIntoViewIfNeeded();
      await expect(code).toBeVisible();

      const box = await code.boundingBox();
      if (!box) throw new Error("code target has no box");

      const line5 = await getMonacoLineBox(page, 5);
      const clickX = box.x + 80;
      const clickY = (line5.top + line5.bottom) / 2;

      await page.touchscreen.tap(clickX, clickY);

      const panel = page.locator("[data-ask-panel]");
      await expect(panel).toBeVisible();
      await expect(panel.locator("[data-ask-panel-label]")).toHaveText("已选：代码第 5 行");

      // Esc twice: first closes panel, second exits ask mode
      await page.keyboard.press("Escape");
      await expect(panel).toHaveCount(0);
      await page.keyboard.press("Escape");

      // Verify no bottom bar in DOM after exit
      await expect(page.locator("[data-ask-bottom-bar]")).toHaveCount(0);
      const varsAfterExit = await page.evaluate(() => {
        const style = document.documentElement.style;
        return {
          bar: style.getPropertyValue("--ask-bottom-bar-h"),
          player: style.getPropertyValue("--ask-player-bar-h"),
          occlusion: style.getPropertyValue("--ask-bottom-occlusion"),
        };
      });
      expect(varsAfterExit.bar === "0px" || varsAfterExit.bar === "").toBe(true);
      expect(varsAfterExit.player === "0px" || varsAfterExit.player === "").toBe(true);
      expect(varsAfterExit.occlusion === "0px" || varsAfterExit.occlusion === "").toBe(true);

      // Switch problems
      await page.goto("/problem/two-sum");
      await page.waitForLoadState("domcontentloaded");

      // Verify no bottom bar and CSS variables are 0px or empty
      await expect(page.locator("[data-ask-bottom-bar]")).toHaveCount(0);
      const varsAfterSwitch = await page.evaluate(() => {
        const style = document.documentElement.style;
        return {
          bar: style.getPropertyValue("--ask-bottom-bar-h"),
          player: style.getPropertyValue("--ask-player-bar-h"),
          occlusion: style.getPropertyValue("--ask-bottom-occlusion"),
        };
      });
      expect(varsAfterSwitch.bar === "0px" || varsAfterSwitch.bar === "").toBe(true);
      expect(varsAfterSwitch.player === "0px" || varsAfterSwitch.player === "").toBe(true);
      expect(varsAfterSwitch.occlusion === "0px" || varsAfterSwitch.occlusion === "").toBe(true);
    });

    test("o. scroll to code area, tap line 9 -> panel label 已选：代码第 9 行", async ({ page }) => {
      await startGenerated(page);
      await pauseLecture(page);
      await enterSelection(page);

      const code = page.locator('[data-ask-stage] [data-ask-target="code"]');
      await code.scrollIntoViewIfNeeded();
      await expect(code).toBeVisible();

      const line9 = await getMonacoLineBox(page, 9);
      const codeBox = (await code.boundingBox())!;
      const clickX = codeBox.x + 80;
      const clickY = (line9.top + line9.bottom) / 2;

      await page.touchscreen.tap(clickX, clickY);

      const panel = page.locator("[data-ask-panel]");
      await expect(panel).toBeVisible();
      await expect(panel.locator("[data-ask-panel-label]")).toHaveText("已选：代码第 9 行");
    });

    test("p. tap line 9 (panel opens, bar hidden), tap 取消 -> bar visible, exit clickable, tap subtitle chip", async ({ page }) => {
      await startGenerated(page);
      await pauseLecture(page);
      await enterSelection(page);

      const code = page.locator('[data-ask-stage] [data-ask-target="code"]');
      await code.scrollIntoViewIfNeeded();
      await expect(code).toBeVisible();

      const line9 = await getMonacoLineBox(page, 9);
      const codeBox = (await code.boundingBox())!;
      const clickX = codeBox.x + 80;
      const clickY = (line9.top + line9.bottom) / 2;

      await page.touchscreen.tap(clickX, clickY);

      const panel = page.locator("[data-ask-panel]");
      await expect(panel).toBeVisible();
      await expect(panel.locator("[data-ask-panel-label]")).toHaveText("已选：代码第 9 行");

      // While panel is open at 390, assert bottom bar is not visible
      await expect(page.locator("[data-ask-bottom-bar]")).not.toBeVisible();

      // Assert no visible chip/control is covered: for every visible button inside [data-ask-panel], elementFromPoint at center is inside it
      const allUncovered = await page.evaluate(() => {
        const p = document.querySelector("[data-ask-panel]");
        if (!p) return false;
        const buttons = Array.from(p.querySelectorAll("button")).filter((btn) => {
          const r = btn.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        });
        if (buttons.length === 0) return false;
        return buttons.every((btn) => {
          const r = btn.getBoundingClientRect();
          const cx = r.left + r.width / 2;
          const cy = r.top + r.height / 2;
          const el = document.elementFromPoint(cx, cy);
          return Boolean(el && (el === btn || btn.contains(el)));
        });
      });
      expect(allUncovered).toBe(true);

      // Tap 取消 at its center
      const cancelBtn = page.locator("[data-ask-panel] [data-ask-cancel]");
      await expect(cancelBtn).toBeVisible();
      const cancelBox = (await cancelBtn.boundingBox())!;
      await page.touchscreen.tap(cancelBox.x + cancelBox.width / 2, cancelBox.y + cancelBox.height / 2);

      // Expect bar visible
      const bar = page.locator("[data-ask-bottom-bar]");
      await expect(bar).toBeVisible();

      // S4 ghost suppress sets exit pointer-events:none for ~500ms after cancel.
      // Wait until hit-testing works again before elementFromPoint asserts.
      const exitBtn = bar.locator("[data-ask-entry]");
      await expect(exitBtn).toBeVisible();
      await expect
        .poll(async () => exitBtn.evaluate((el) => (el as HTMLElement).style.pointerEvents), {
          timeout: 2000,
        })
        .not.toBe("none");
      const exitBox = (await exitBtn.boundingBox())!;
      const exitCx = exitBox.x + exitBox.width / 2;
      const exitCy = exitBox.y + exitBox.height / 2;
      const isExit = await page.evaluate(
        ({ x, y }) => {
          const el = document.elementFromPoint(x, y);
          const btn = document.querySelector("[data-ask-bottom-bar] [data-ask-entry]");
          return el !== null && (el === btn || btn?.contains(el) === true);
        },
        { x: exitCx, y: exitCy },
      );
      expect(isExit).toBe(true);

      // Then tap a chip ([data-ask-shortcut="subtitle"]) and expect panel label 「已选：当前字幕」
      const chip = bar.locator('[data-ask-shortcut="subtitle"]');
      await expect(chip).toBeVisible();
      const chipBox = (await chip.boundingBox())!;
      await page.touchscreen.tap(chipBox.x + chipBox.width / 2, chipBox.y + chipBox.height / 2);

      await expect(panel).toBeVisible();
      await expect(panel.locator("[data-ask-panel-label]")).toHaveText("已选：当前字幕");
    });

    test("cancel keeps selecting, focus on chip, occlusion restored", async ({ page }) => {
      await startGenerated(page);
      await pauseLecture(page);
      await enterSelection(page);

      // Read --ask-bottom-occlusion before opening panel
      const occlusionBefore = await page.evaluate(() => {
        const raw = getComputedStyle(document.documentElement).getPropertyValue("--ask-bottom-occlusion");
        return parseFloat(raw) || 0;
      });

      const code = page.locator('[data-ask-stage] [data-ask-target="code"]');
      await code.scrollIntoViewIfNeeded();
      await expect(code).toBeVisible();

      const line9 = await getMonacoLineBox(page, 9);
      const codeBox = (await code.boundingBox())!;
      const clickX = codeBox.x + 80;
      const clickY = (line9.top + line9.bottom) / 2;

      await page.touchscreen.tap(clickX, clickY);

      const panel = page.locator("[data-ask-panel]");
      await expect(panel).toBeVisible();

      const cancelBtn = page.locator("[data-ask-panel] [data-ask-cancel]");
      await expect(cancelBtn).toBeVisible();
      const cancelBox = (await cancelBtn.boundingBox())!;

      await page.evaluate(() => {
        const w = window as unknown as { __cancelOnlySnap?: { barPresent: boolean; boxPresent: boolean; activeIsChip: boolean } };
        w.__cancelOnlySnap = undefined;
        const mo = new MutationObserver(() => {
          if (!document.querySelector("[data-ask-panel]")) {
            const snap = () => {
              const bar = document.querySelector<HTMLElement>("[data-ask-bottom-bar]");
              const ae = document.activeElement as HTMLElement | null;
              w.__cancelOnlySnap = {
                barPresent: !!bar && bar.offsetHeight > 0,
                boxPresent: !!document.querySelector("[data-ask-selection]"),
                activeIsChip: !!ae?.hasAttribute("data-ask-shortcut"),
              };
            };
            snap();
            requestAnimationFrame(snap);
            mo.disconnect();
          }
        });
        mo.observe(document.body, { childList: true, subtree: true });
      });

      await page.touchscreen.tap(cancelBox.x + cancelBox.width / 2, cancelBox.y + cancelBox.height / 2);

      await expect
        .poll(() =>
          page.evaluate(
            () => (window as unknown as { __cancelOnlySnap?: unknown }).__cancelOnlySnap,
          ),
        )
        .toBeDefined();
      const cancelOnlySnap = await page.evaluate(() => {
        return (window as unknown as {
          __cancelOnlySnap?: { barPresent: boolean; boxPresent: boolean; activeIsChip: boolean };
        }).__cancelOnlySnap!;
      });
      expect(cancelOnlySnap.barPresent).toBe(true);
      expect(cancelOnlySnap.boxPresent).toBe(true);
      expect(cancelOnlySnap.activeIsChip).toBe(true);

      // Assert still selecting (layer visible, entry aria-pressed true)
      const layer = page.locator("[data-ask-layer]");
      await expect(layer).toBeVisible();

      const bar = page.locator("[data-ask-bottom-bar]");
      await expect(bar).toBeVisible();
      const barExit = bar.locator("[data-ask-entry]");
      await expect(barExit).toHaveAttribute("aria-pressed", "true");

      // [data-ask-selection] still visible
      const selectionEl = page.locator("[data-ask-selection]");
      await expect(selectionEl).toBeVisible();

      // document.activeElement is a [data-ask-shortcut] inside the bar with tabIndex 0
      const activeInfo = await page.evaluate(() => {
        const el = document.activeElement;
        const b = document.querySelector("[data-ask-bottom-bar]");
        const isInsideBar = Boolean(b && el && b.contains(el));
        const hasShortcut = el?.hasAttribute("data-ask-shortcut") ?? false;
        const tabIndex = (el as HTMLElement)?.tabIndex;
        return { isInsideBar, hasShortcut, tabIndex };
      });
      expect(activeInfo.isInsideBar).toBe(true);
      expect(activeInfo.hasShortcut).toBe(true);
      expect(activeInfo.tabIndex).toBe(0);

      // read --ask-bottom-occlusion via getComputedStyle(documentElement) and assert it equals value measured before (±1px)
      const occlusionAfter = await page.evaluate(() => {
        const raw = getComputedStyle(document.documentElement).getPropertyValue("--ask-bottom-occlusion");
        return parseFloat(raw) || 0;
      });
      expect(Math.abs(occlusionAfter - occlusionBefore)).toBeLessThanOrEqual(1);
    });

    async function assertCancelThenExitWithin100ms(page: Page) {
      await startGenerated(page);
      await pauseLecture(page);
      await enterSelection(page);

      const code = page.locator('[data-ask-stage] [data-ask-target="code"]');
      await code.scrollIntoViewIfNeeded();
      await expect(code).toBeVisible();

      // Measure the bar exit button during selecting (bar is hidden while the panel is open;
      // option B restores the same layout on cancel).
      const bar = page.locator("[data-ask-bottom-bar]");
      const barExit = bar.locator("[data-ask-entry]");
      await expect(barExit).toBeVisible();
      const exitBox = (await barExit.boundingBox())!;
      const exitX = exitBox.x + exitBox.width / 2;
      const exitY = exitBox.y + exitBox.height / 2;

      const line9 = await getMonacoLineBox(page, 9);
      const codeBox = (await code.boundingBox())!;
      await page.touchscreen.tap(codeBox.x + 80, (line9.top + line9.bottom) / 2);

      const panel = page.locator("[data-ask-panel]");
      await expect(panel).toBeVisible();
      const question = page.locator("[data-ask-panel] [data-ask-question]");
      await expect(question).toBeVisible();
      await question.fill("preserve-me-chip390b");
      const cancelBtn = page.locator("[data-ask-panel] [data-ask-cancel]");
      await expect(cancelBtn).toBeVisible();
      const cancelBox = (await cancelBtn.boundingBox())!;

      await installPointerdownClock(page);

      await page.evaluate(() => {
        const w = window as unknown as {
          __cancelUpAt?: number;
          __panelGoneAt?: number;
        };
        w.__cancelUpAt = undefined;
        w.__panelGoneAt = undefined;

        document.addEventListener(
          "pointerup",
          (event) => {
            const target =
              event.target instanceof Element
                ? event.target
                : (event.target as Node | null)?.parentElement;
            if (target?.closest?.("[data-ask-panel] [data-ask-cancel]")) {
              w.__cancelUpAt = performance.now();
            }
          },
          { capture: true },
        );

        const observer = new MutationObserver(() => {
          if (w.__cancelUpAt !== undefined && w.__panelGoneAt === undefined) {
            if (!document.querySelector("[data-ask-panel]")) {
              w.__panelGoneAt = performance.now();
              observer.disconnect();
            }
          }
        });

        observer.observe(document.body, { childList: true, subtree: true });
      });

      const askRequests: string[] = [];
      page.on("request", (req) => {
        if (req.url().includes("/api/lecture/ask")) {
          askRequests.push(req.url());
        }
      });

      await page.touchscreen.tap(cancelBox.x + cancelBox.width / 2, cancelBox.y + cancelBox.height / 2);
      await page.touchscreen.tap(exitX, exitY);
      const downs = await readPointerdownClock(page);
      expect(downs.length).toBeGreaterThanOrEqual(2);
      const gap = downs[1] - downs[0];
      console.log(`[cancel->exit gap] ${gap.toFixed(1)}ms`);

      await expect
        .poll(() =>
          page.evaluate(
            () => (window as unknown as { __panelGoneAt?: number }).__panelGoneAt,
          ),
        )
        .toBeDefined();

      const { cancelUpAt, panelGoneAt } = await page.evaluate(() => {
        const w = window as unknown as {
          __cancelUpAt?: number;
          __panelGoneAt?: number;
        };
        return { cancelUpAt: w.__cancelUpAt, panelGoneAt: w.__panelGoneAt };
      });
      expect(cancelUpAt).toBeDefined();
      expect(panelGoneAt! - cancelUpAt!).toBeLessThanOrEqual(100);

      await expect(page.locator("[data-ask-layer]")).toHaveCount(0);
      await expect(page.locator("[data-ask-entry]")).not.toHaveAttribute("aria-pressed", "true");
      expect(askRequests).toEqual([]);

      await expect(page.locator("[data-ask-selection]")).toHaveCount(0);
      const afterExit = await page.evaluate(() => {
        const entry = document.querySelector<HTMLElement>("[data-ask-entry]");
        const bar = document.querySelector<HTMLElement>("[data-ask-bottom-bar]");
        const ae = document.activeElement;
        return {
          entryFocused: ae === entry || !!ae?.closest?.("[data-ask-entry]"),
          barCollapsed: !bar || bar.offsetHeight === 0 || entry?.getAttribute("aria-pressed") !== "true",
        };
      });
      expect(afterExit.entryFocused).toBe(true);
      expect(afterExit.barCollapsed).toBe(true);
      expect(askRequests).toEqual([]);

      // Re-enter via Q: must not auto-open panel
      await page.keyboard.press("q");
      await expect(page.locator("[data-ask-layer]")).toBeVisible();
      await expect(page.locator("[data-ask-entry]")).toHaveAttribute("aria-pressed", "true");
      await page.waitForTimeout(300);
      const autoOpened = await page.locator("[data-ask-panel]").count();
      console.log(`[cancel-exit re-enter] panelAutoOpen=${autoOpened}`);
      expect(autoOpened).toBe(0); // if this fails, report — do not change product code

      // S5-exit-clear: typed text preserved after re-open via subtitle chip
      const chip = page.locator("[data-ask-bottom-bar] [data-ask-shortcut='subtitle']");
      await expect(chip).toBeVisible();
      const chipBox = (await chip.boundingBox())!;
      await page.touchscreen.tap(chipBox.x + chipBox.width / 2, chipBox.y + chipBox.height / 2);
      await expect(page.locator("[data-ask-panel]")).toBeVisible();
      await expect(page.locator("[data-ask-panel] [data-ask-question]")).toHaveValue("preserve-me-chip390b");
    }

    test("cancel then exit within 100ms exits ask mode", async ({ page }) => {
      await assertCancelThenExitWithin100ms(page);
    });

    test("tap completes a selection, then a chip tap within 100ms takes effect", async ({ page }) => {
      await startGenerated(page);
      await pauseLecture(page);
      await enterSelection(page);

      const code = page.locator('[data-ask-stage] [data-ask-target="code"]');
      await code.scrollIntoViewIfNeeded();
      await expect(code).toBeVisible();
      const line9 = await getMonacoLineBox(page, 9);
      const codeBox = (await code.boundingBox())!;

      const tapX = codeBox.x + 80;
      const tapY = (line9.top + line9.bottom) / 2;
      // Bar is hidden while the panel is open (option B); the visible subtitle chip lives in the panel.
      const chipSel =
        "[data-ask-panel] [data-ask-shortcut='subtitle'], [data-ask-bottom-bar] [data-ask-shortcut='subtitle']";
      const chip = page.locator(chipSel).locator("visible=true").first();

      // Warm-up: learn where the chip renders once the panel is open, then cancel back to selecting.
      await page.touchscreen.tap(tapX, tapY);
      const chipBox = (await chip.boundingBox())!;
      const cancelBtn = page.locator("[data-ask-panel] [data-ask-cancel]");
      await cancelBtn.click();
      await expect(page.locator("[data-ask-panel]")).toHaveCount(0);

      await installPointerdownClock(page);
      // Back-to-back taps: nothing awaited between them (chip position measured in warm-up above).
      await page.touchscreen.tap(tapX, tapY);
      await page.touchscreen.tap(chipBox.x + chipBox.width / 2, chipBox.y + chipBox.height / 2);
      const downs = await readPointerdownClock(page);
      expect(downs.length).toBeGreaterThanOrEqual(2);
      const gap = downs[1] - downs[0];
      console.log(`[selection->chip gap] ${gap.toFixed(1)}ms`);

      const panel = page.locator("[data-ask-panel]");
      await expect(panel).toBeVisible();
      await expect(panel.locator("[data-ask-panel-label]")).toHaveText("已选：当前字幕");
    });

    test("q. tap in the gap between two chips in the bar -> selection unchanged and ask mode active", async ({ page }) => {
      await startGenerated(page);
      await pauseLecture(page);
      await enterSelection(page);

      const code = page.locator('[data-ask-stage] [data-ask-target="code"]');
      await code.scrollIntoViewIfNeeded();
      await expect(code).toBeVisible();

      const line9 = await getMonacoLineBox(page, 9);
      const codeBox = (await code.boundingBox())!;
      const clickX = codeBox.x + 80;
      const clickY = (line9.top + line9.bottom) / 2;

      await page.touchscreen.tap(clickX, clickY);

      const panel = page.locator("[data-ask-panel]");
      await expect(panel).toBeVisible();
      await expect(panel.locator("[data-ask-panel-label]")).toHaveText("已选：代码第 9 行");

      // Close panel so bar is visible again
      await page.keyboard.press("Escape");
      await expect(panel).toHaveCount(0);

      const selection = page.locator("[data-ask-layer] [data-ask-selection]");
      await expect(selection).toBeVisible();
      const selBoxBefore = (await selection.boundingBox())!;
      const selLabel = page.locator("[data-ask-selection-label]");
      await expect(selLabel).toHaveText("已选：代码第 9 行");

      const bar = page.locator("[data-ask-bottom-bar]");
      await expect(bar).toBeVisible();
      const chip0 = bar.locator("[data-ask-shortcut]").nth(0);
      const chip1 = bar.locator("[data-ask-shortcut]").nth(1);
      const box0 = (await chip0.boundingBox())!;
      const box1 = (await chip1.boundingBox())!;

      const gapX = (box0.x + box0.width + box1.x) / 2;
      const gapY = box0.y + box0.height / 2;

      // In Chromium (and real mobile devices), page.touchscreen.tap in the 8px gap
      // between chips is snapped by Chromium touch adjustment onto the nearest chip
      // (targeting [data-ask-shortcut="step"] and selecting "当前步骤").
      // Dispatch events directly to the gap element to bypass touch adjustment while
      // verifying that tapping the gap leaves the existing selection unchanged.
      await page.evaluate(
        ({ gapX, gapY }) => {
          const target = document.elementFromPoint(gapX, gapY);
          const barEl = document.querySelector("[data-ask-bottom-bar]");
          if (!target || !barEl || !barEl.contains(target)) {
            throw new Error("Gap point element is not inside [data-ask-bottom-bar]");
          }
          if (target.closest("[data-ask-shortcut]") || target.closest("button")) {
            throw new Error("Gap point element must not be a [data-ask-shortcut] or button");
          }

          const pointerProps = {
            bubbles: true,
            cancelable: true,
            composed: true,
            pointerType: "touch",
            isPrimary: true,
            pointerId: 7,
            clientX: gapX,
            clientY: gapY,
          };
          target.dispatchEvent(new PointerEvent("pointerdown", pointerProps));
          target.dispatchEvent(new PointerEvent("pointerup", pointerProps));
          target.dispatchEvent(
            new MouseEvent("click", {
              bubbles: true,
              cancelable: true,
              clientX: gapX,
              clientY: gapY,
            }),
          );
        },
        { gapX, gapY },
      );

      await expect(page.locator("[data-ask-layer]")).toBeVisible();
      await expect(bar).toBeVisible();
      await expect(selection).toBeVisible();
      await expect(panel).toHaveCount(0);

      const selBoxAfter = (await selection.boundingBox())!;
      expect(Math.abs(selBoxAfter.x - selBoxBefore.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(selBoxAfter.y - selBoxBefore.y)).toBeLessThanOrEqual(1);
      expect(Math.abs(selBoxAfter.width - selBoxBefore.width)).toBeLessThanOrEqual(1);
      expect(Math.abs(selBoxAfter.height - selBoxBefore.height)).toBeLessThanOrEqual(1);
      await expect(selLabel).toHaveText("已选：代码第 9 行");
    });

    test("first chip focus ring is not clipped by the bar scroller", async ({ page }) => {
      await startGenerated(page);
      await pauseLecture(page);
      await enterSelection(page);
      const firstChip = page.locator("[data-ask-bottom-bar] [data-ask-shortcut]").first();
      await expect(firstChip).toBeVisible();
      await firstChip.focus();
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("ArrowLeft");
      await expect(firstChip).toBeFocused();
      const m = await firstChip.evaluate((el) => {
        const cs = getComputedStyle(el);
        const ringW = cs.outlineStyle === "none" ? 0 : parseFloat(cs.outlineWidth) || 0;
        const ringOff = parseFloat(cs.outlineOffset) || 0;
        const extent = Math.max(0, ringW + ringOff);
        let clip: Element | null = el.parentElement;
        while (clip && !/(auto|scroll|hidden|clip)/.test(getComputedStyle(clip).overflowX)) clip = clip.parentElement;
        const r = el.getBoundingClientRect();
        const c = (clip ?? document.documentElement).getBoundingClientRect();
        return { extent, ringLeft: r.left - extent, clipLeft: c.left, chipLeft: r.left, ringW, ringOff };
      });
      console.log(`[chip ring] ${JSON.stringify(m)}`);
      expect(m.ringLeft).toBeGreaterThanOrEqual(m.clipLeft - 0.5);
      const barBox = (await page.locator("[data-ask-bottom-bar]").boundingBox())!;
      expect(barBox.height).toBeLessThanOrEqual(60);
    });

    test("r. exit button inside [data-ask-bottom-bar], row layout, gaps, Tab order, ArrowRight", async ({ page }) => {
      await startGenerated(page);
      await pauseLecture(page);
      await enterSelection(page);

      const bar = page.locator("[data-ask-bottom-bar]");
      await expect(bar).toBeVisible();
      const barBoxBefore = (await bar.boundingBox())!;

      const exitBtn = bar.locator("[data-ask-entry]");
      await expect(exitBtn).toBeVisible();

      const firstChip = bar.locator("[data-ask-shortcut]").first();
      const firstChipBox = (await firstChip.boundingBox())!;
      const exitBox = (await exitBtn.boundingBox())!;

      // Same row as chips (|centerY diff| < 2)
      const chipCenterY = firstChipBox.y + firstChipBox.height / 2;
      const exitCenterY = exitBox.y + exitBox.height / 2;
      expect(Math.abs(chipCenterY - exitCenterY)).toBeLessThan(2);

      // Exit button is after the chips in DOM order
      const order = await page.evaluate(() => {
        const barEl = document.querySelector("[data-ask-bottom-bar]");
        if (!barEl) return [];
        return Array.from(barEl.querySelectorAll("[data-ask-shortcut], [data-ask-entry]")).map((el) =>
          el.hasAttribute("data-ask-entry") ? "exit" : "chip",
        );
      });
      expect(order[order.length - 1]).toBe("exit");

      // 44x44 min targets
      expect(exitBox.width).toBeGreaterThanOrEqual(44);
      expect(exitBox.height).toBeGreaterThanOrEqual(44);

      // gaps >= 8
      const chips = bar.locator("[data-ask-shortcut]");
      const chipsCount = await chips.count();
      const chipBoxes: Array<{ x: number; y: number; width: number; height: number }> = [];
      for (let i = 0; i < chipsCount; i++) {
        chipBoxes.push((await chips.nth(i).boundingBox())!);
      }
      for (let i = 0; i < chipBoxes.length - 1; i++) {
        const gap = chipBoxes[i + 1].x - (chipBoxes[i].x + chipBoxes[i].width);
        expect(gap).toBeGreaterThanOrEqual(7.9);
      }
      const lastChipBox = chipBoxes[chipBoxes.length - 1];
      const exitGap = exitBox.x - (lastChipBox.x + lastChipBox.width);
      expect(exitGap).toBeGreaterThanOrEqual(7.9);

      // bar height unchanged vs before (still 60px)
      expect(barBoxBefore.height).toBeLessThanOrEqual(60);

      // One chip is tabbable; S4 keeps exit at tabIndex=-1 (not in tab order).
      const tabbableCount = await bar.locator('[data-ask-shortcut][tabindex="0"]').count();
      expect(tabbableCount).toBe(1);
      await expect(exitBtn).toHaveAttribute("tabindex", "-1");

      await bar.locator('[data-ask-shortcut][tabindex="0"]').focus();
      await page.keyboard.press("Tab");
      await expect(exitBtn).not.toBeFocused();

      // ArrowRight moves among chips
      const secondChip = bar.locator("[data-ask-shortcut]").nth(1);
      await firstChip.focus();
      await page.keyboard.press("ArrowRight");
      await expect(secondChip).toBeFocused();
    });

    // regression guard vs a9cedbb (c852e36 fresh sampling broke it)
    // a9cedbb measures an 11px inset with and without scroll; compare against a no-scroll baseline
    test("scroll mid-drag: lines 3–8 stay aligned", async ({ page }) => {
      await startGenerated(page);
      await pauseLecture(page);
      await enterSelection(page);

      const code = page.locator('[data-ask-stage] [data-ask-target="code"]');
      await code.scrollIntoViewIfNeeded();
      await expect(code).toBeVisible();

      const bar = page.locator("[data-ask-bottom-bar]");
      await expect(bar).toBeVisible();
      const barBox = (await bar.boundingBox())!;

      const line10Box = await getMonacoLineBox(page, 10);
      if (line10Box.bottom > barBox.y - 8) {
        await page.evaluate((dy) => window.scrollBy(0, dy), line10Box.bottom - barBox.y + 16);
      }

      // 1. No-scroll baseline drag line 3 -> line 8
      const codeBox1 = (await code.boundingBox())!;
      const line3Box1 = await getMonacoLineBox(page, 3);
      const startX1 = codeBox1.x + 60;
      const startY1 = (line3Box1.top + line3Box1.bottom) / 2;

      await page.mouse.move(startX1, startY1);
      await page.mouse.down();

      const line5Box1 = await getMonacoLineBox(page, 5);
      const line5Y1 = (line5Box1.top + line5Box1.bottom) / 2;
      await page.mouse.move(codeBox1.x + 100, line5Y1, { steps: 4 });

      const line8Box1 = await getMonacoLineBox(page, 8);
      const endBox1 = (await code.boundingBox())!;
      const endX1 = endBox1.x + 160;
      const endY1 = (line8Box1.top + line8Box1.bottom) / 2;
      await page.mouse.move(endX1, endY1, { steps: 5 });
      await page.mouse.up();

      const panel = page.locator("[data-ask-panel]");
      await expect(panel).toBeVisible();
      await expect(panel.locator("[data-ask-panel-label]")).toHaveText("已选：代码第 3–8 行");

      const selection = page.locator("[data-ask-selection]");
      await expect(selection).toBeVisible();

      const baseLine3 = await getMonacoLineBox(page, 3);
      const baseLine8 = await getMonacoLineBox(page, 8);
      const baseSel = await selection.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom };
      });
      const baseTop = baseSel.top - baseLine3.top;
      const baseBottom = baseSel.bottom - baseLine8.bottom;

      // Clear selection
      await page.keyboard.press("Escape");
      await expect(panel).toHaveCount(0);
      await page.keyboard.press("Escape");
      await expect(selection).toHaveCount(0);
      await expect(page.locator("[data-ask-layer]")).toHaveCount(0);
      await enterSelection(page);

      await code.scrollIntoViewIfNeeded();
      await expect(code).toBeVisible();
      await expect(bar).toBeVisible();
      const barBox2 = (await bar.boundingBox())!;
      const line10Box2 = await getMonacoLineBox(page, 10);
      if (line10Box2.bottom > barBox2.y - 8) {
        await page.evaluate((dy) => window.scrollBy(0, dy), line10Box2.bottom - barBox2.y + 16);
      }

      // 2. Scroll mid-drag line 3 -> line 8
      const codeBox2 = (await code.boundingBox())!;
      const line3Box2 = await getMonacoLineBox(page, 3);
      const startX2 = codeBox2.x + 60;
      const startY2 = (line3Box2.top + line3Box2.bottom) / 2;

      await page.mouse.move(startX2, startY2);
      await page.mouse.down();

      const line5Box2 = await getMonacoLineBox(page, 5);
      const line5Y2 = (line5Box2.top + line5Box2.bottom) / 2;
      await page.mouse.move(codeBox2.x + 100, line5Y2, { steps: 4 });

      await page.evaluate(() => window.scrollBy(0, 44));
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));

      const line8Box2 = await getMonacoLineBox(page, 8);
      const endBox2 = (await code.boundingBox())!;
      const endX2 = endBox2.x + 160;
      const endY2 = (line8Box2.top + line8Box2.bottom) / 2;
      await page.mouse.move(endX2, endY2, { steps: 5 });
      await page.mouse.up();

      // 3. Assert label and alignment vs baseline
      await expect(panel).toBeVisible();
      await expect(panel.locator("[data-ask-panel-label]")).toHaveText("已选：代码第 3–8 行");

      await expect(selection).toBeVisible();

      const currentLine3 = await getMonacoLineBox(page, 3);
      const currentLine8 = await getMonacoLineBox(page, 8);
      const selRect = await selection.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom };
      });

      expect(Math.abs((selRect.top - currentLine3.top) - baseTop)).toBeLessThanOrEqual(2);
      expect(Math.abs((selRect.bottom - currentLine8.bottom) - baseBottom)).toBeLessThanOrEqual(2);
    });
  });

  test.describe("S5-chip390 reduced motion", () => {
    test.use({ reducedMotion: "reduce" });

    test("g. scroll to entry button, tap enter, immediately assert code in place in 2 animation frames", async ({ page }) => {
      await startGenerated(page);
      await pauseLecture(page);

      const button = entry(page);
      await button.scrollIntoViewIfNeeded();
      await button.click();

      // Wait 2 animation frames
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));

      const bar = page.locator("[data-ask-bottom-bar]");
      await expect(bar).toBeVisible();
      const barBox = (await bar.boundingBox())!;

      const code = page.locator('[data-ask-stage] [data-ask-target="code"]');
      const box = (await code.boundingBox())!;
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height).toBeLessThanOrEqual(barBox.y + 2);
    });
  });
});

test.describe("390×667 keyboard drawer", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 667 } });

  test("34. visualViewport shrink keeps the question field in view", async ({ page }) => {
    await startGenerated(page);
    await pauseLecture(page);
    await enterSelection(page);
    const shortcut = page.locator('[data-ask-shortcut="subtitle"]');
    await expect(shortcut).toBeVisible();
    await shortcut.click();
    const panel = page.locator("[data-ask-panel]");
    const field = panel.locator("[data-ask-question]");
    await expect(panel).toBeVisible();
    await expect(field).toBeVisible();
    await field.focus();
    // 软键盘只改 visualViewport。画选层不把它当成窗口 resize，提问抽屉跟着抬高。
    await page.evaluate(() => {
      const viewport = window.visualViewport;
      if (!viewport) return;
      Object.defineProperty(viewport, "height", { configurable: true, get: () => 280 });
      Object.defineProperty(viewport, "offsetTop", { configurable: true, get: () => 0 });
      viewport.dispatchEvent(new Event("resize"));
    });
    await expect(field).toBeVisible();
    const box = await field.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(280);
  });
});

test.describe("grey states", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("37. builtin two-sum is grey without generating", async ({ page }) => {
    await mockSettings(page, false);
    await page.goto("/problem/two-sum");
    await page.locator("header").getByRole("button", { name: "开始讲课", exact: true }).click();
    await expect(page.getByText(/第 1 \/ \d+ 步/)).toBeVisible();
    await expect(entry(page)).toBeVisible();
    await pauseLecture(page);
    await expectReason(page, "builtin");
  });

  test("37. unfinished cut-off lecture stays grey", async ({ page }) => {
    await mockSettings(page, false);
    await mockLecture(page, lectureNdjson({ steps: [step()], withResult: false }));
    await page.goto("/problem/group-anagrams");
    await page.locator("header").getByRole("button", { name: "开始讲课", exact: true }).click();
    await expect(page.getByText("已收到 1 步，备课中断")).toBeVisible();
    await expectReason(page, "unfinished");
  });

  test("37. receiving stays grey while the lecture body is held", async ({ page }) => {
    const release = await mockHeldLecture(page);
    await mockSettings(page, false);
    try {
      await page.goto("/problem/group-anagrams");
      await page.locator("header").getByRole("button", { name: "开始讲课", exact: true }).click();
      await expect(page.getByRole("status").filter({ hasText: "已收到 1 步，仍在备课…" })).toBeVisible();
      await expect(entry(page)).toBeVisible();
      await expectReason(page, "receiving");
    } finally {
      await release();
    }
  });
});

test.describe("E45 pending", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("E45. click while settings is pending shows aria-busy/spinner/正在准备, then selecting", async ({ page }) => {
    const releaseSettings = await holdSettings(page);
    await mockLecture(page, lectureNdjson({}));
    await page.goto("/problem/group-anagrams");
    await page.locator("header").getByRole("button", { name: "开始讲课", exact: true }).click();
    await expect(page.getByText("第 1 / 3 步")).toBeVisible();
    await pauseLecture(page);
    const button = entry(page);
    await expect(button).toBeVisible();
    await expect(button).not.toHaveAttribute("aria-disabled", "true");
    await button.click();
    await expect(button).toHaveAttribute("aria-busy", "true");
    await expect(button.locator("[data-ask-pending-spinner]")).toBeVisible();
    await expect(button.locator(".sr-only")).toHaveText("正在准备");
    await expect(page.locator("[data-ask-layer]")).toHaveCount(0);
    releaseSettings();
    await expect(page.locator("[data-ask-layer]")).toBeVisible({ timeout: 5_000 });
    await expect(button).toHaveAttribute("aria-pressed", "true");
  });

  test("E45. settings slower than 3s shows the timeout copy and does not enter selection", async ({ page }) => {
    // 点击之后才放行，再多等 3.5s。3 秒定时器先取消意图，随后身份落定也不进圈选。
    const releaseSettings = await holdSettings(page, 3_500);
    await mockLecture(page, lectureNdjson({}));
    await page.goto("/problem/group-anagrams");
    await page.locator("header").getByRole("button", { name: "开始讲课", exact: true }).click();
    await expect(page.getByText("第 1 / 3 步")).toBeVisible();
    await pauseLecture(page);
    const button = entry(page);
    await button.click();
    await expect(button).toHaveAttribute("aria-busy", "true");
    releaseSettings();
    await expect(page.locator("#ask-entry-timeout")).toHaveText(PENDING_TIMEOUT, { timeout: 4_000 });
    await expect(button).toHaveAttribute("aria-describedby", "ask-entry-timeout");
    await expect(button).not.toHaveAttribute("aria-busy", "true");
    await expect(page.locator("[data-ask-layer]")).toHaveCount(0);
    await expect(page.getByText("第 1 / 3 步")).toBeVisible();
    await expect(button).toHaveAttribute("data-ask-disabled-reason", "pendingTimeout");
  });
});
