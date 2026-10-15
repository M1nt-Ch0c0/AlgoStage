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

test.describe("1280 selection flow", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

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
    await expect(page.getByText(ANSWER_NARRATION)).toBeVisible();
    await expect(page.getByText(/第 \d+ \/ 3 步/)).toHaveText(indexBefore!);
    await expect(page.locator("[data-ask-layer]")).toHaveCount(0);
  });

  test("drag starting on a shortcut chip draws a box and does not select the chip", async ({ page }) => {
    await startGenerated(page);
    await pauseLecture(page);
    await enterSelection(page);

    const chip = page.locator('[data-ask-shortcut="subtitle"]');
    await expect(chip).toBeVisible();
    const box = await chip.boundingBox();
    expect(box).not.toBeNull();
    const startX = box!.x + box!.width / 2;
    const startY = box!.y + box!.height / 2;

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + 80, startY + 60, { steps: 6 });
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
    await expect(page.getByText(ANSWER_NARRATION)).toBeVisible();
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
    await expect(page.getByText(ANSWER_NARRATION)).toBeVisible();
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
    await expect(page.getByText(ANSWER_NARRATION)).toBeVisible();
    expect(image).toBeNull();
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
});

test.describe("390 selection flow", () => {
  // 与 autoplay e2e 同一套粗指针：播放中「点「下一步」继续」独占一行，基线 4 行。
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

  test.describe("390 mobile tap", () => {
    test("S2. 390: kbd hidden, exit >=44, title row single line", async ({ page }) => {
      await startGenerated(page);
      await pauseLecture(page);
      const titleRow = entry(page).locator("xpath=ancestor::div[1]");
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

    await page.touchscreen.tap(centerX, centerY);
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

  test("390: drag starting 10px below exit button bottom edge on subtitle body text selects 当前字幕", async ({ page }) => {
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
