import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { expect, test, type Locator, type Page, type Route } from "@playwright/test";

/**
 * S1 全局 Esc 逐步退出圈选。
 * 假按键只走 Playwright keyboard / locator.press。上游用 page.route，不用墙钟断言。
 * 发送中的回答用本机分块服务挂住，Esc 之后再放行，断言回答仍落在步骤上。
 */

const CACHE_KEY = "a".repeat(40);
const SCRIPT_VERSION = "b".repeat(40);
const QUESTION = "这一步在做什么？";
const ANSWER_NARRATION = "把相同字母的词放进同一组。";

function step(id: string, narration: string) {
  return {
    id,
    narration,
    targets: [{ kind: "code-line", start: 1, end: 2 }],
    effects: [],
    dwellMs: 60_000,
    viz: { type: "array", state: { values: [1, 2, 3], highlight: [0] } },
  };
}

function lectureNdjson() {
  const steps = [step("s1", "开局把词按字母分组"), step("s2", "再写回结果"), step("s3", "返回分组")];
  const lines = steps.map((item) => JSON.stringify({ type: "step", step: item }));
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
      askDisabledStepIds: [],
    }),
  );
  return `${lines.join("\n")}\n`;
}

const SEGMENT = { id: "seg1", narration: ANSWER_NARRATION };

function answerFor(stepId: string) {
  return {
    v: 1,
    id: "ans-e2e-esc",
    stepId,
    question: QUESTION,
    selection: {
      mode: "region",
      bbox: { x: 0, y: 0, width: 40, height: 40 },
      targets: [{ kind: "viz", id: `viz:${stepId}`, stepId, text: "可视化" }],
    },
    segments: [SEGMENT],
    createdAt: "2026-10-14T00:00:00.000Z",
  };
}

const startLine = (stepId: string) =>
  `${JSON.stringify({ type: "start", answerId: "ans-e2e-esc", stepId, imageUsed: false })}\n`;
const segmentLine = () => `${JSON.stringify({ type: "segment", segment: SEGMENT })}\n`;
const resultLine = (stepId: string) => `${JSON.stringify({ type: "result", answer: answerFor(stepId) })}\n`;

async function startGenerated(page: Page) {
  await page.route("**/api/settings", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ serverKeyDisabled: false, keySource: "env" }),
    }),
  );
  await page.route("**/api/lecture", async (route) => {
    if (route.request().url().includes("/api/lecture/ask")) {
      await route.fallback();
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/x-ndjson", body: lectureNdjson() });
  });
  await page.goto("/problem/group-anagrams");
  await page.locator("header").getByRole("button", { name: "开始讲课", exact: true }).click();
  await expect(page.getByText("第 1 / 3 步")).toBeVisible();
  const pause = page.locator("header").getByRole("button", { name: "暂停", exact: true });
  const resume = page.locator("header").getByRole("button", { name: "继续", exact: true });
  await expect(pause.or(resume)).toBeVisible();
  if (await pause.isVisible()) await pause.click();
  await expect(resume).toBeVisible();
}

const entry = (page: Page) => page.locator("[data-ask-entry]");
const layer = (page: Page) => page.locator("[data-ask-layer]");
const panel = (page: Page) => page.locator("[data-ask-panel]");

/** 点在元素中心，让圈选层下的真实点击落到标题或 Monaco，而不是只挪焦点。 */
async function clickCenter(page: Page, target: Locator) {
  const box = await target.boundingBox();
  if (!box) throw new Error("element has no box");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

const BUSY_REASON = "上一个问题还在回答，答完再问";

/** 回答在飞时入口置灰：aria-disabled，aria-describedby 指向 busy 文案。 */
async function expectBusyEntry(page: Page) {
  const button = entry(page);
  await expect(button).toHaveAttribute("aria-disabled", "true");
  await expect(button).toHaveAttribute("data-ask-disabled-reason", "busy");
  const describedBy = await button.getAttribute("aria-describedby");
  expect(describedBy).toBeTruthy();
  await expect(page.locator(`#${describedBy}`)).toHaveText(BUSY_REASON);
}

async function enterSelection(page: Page) {
  const button = entry(page);
  await expect(button).toBeEnabled();
  await expect(button).not.toHaveAttribute("aria-disabled", "true");
  await button.click();
  await expect(layer(page)).toBeVisible();
  await expect(button).toHaveAttribute("aria-pressed", "true");
}

async function openPanel(page: Page) {
  const shortcut = page.locator('[data-ask-shortcut="step"]');
  await expect(shortcut).toBeVisible();
  await shortcut.click();
  await expect(panel(page)).toBeVisible();
  await expect(panel(page).locator("[data-ask-panel-label]")).toHaveText("已选：当前步骤");
}

/**
 * 分块 NDJSON：先写 start，挂住；放行后再写 segment + result。
 * 挂住期间面板处于 sending（还没收到 start 的话）或收到 start 后的 streaming。
 */
async function mockHeldAskStream(page: Page) {
  let release: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const sockets = new Set<Socket>();
  let requests = 0;
  const server: Server = createServer((req, res) => {
    requests += 1;
    req.resume();
    res.writeHead(200, {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-cache, no-transform",
    });
    res.write(startLine("s1"));
    void gate.then(() => {
      if (res.writableEnded) return;
      res.write(segmentLine());
      res.end(resultLine("s1"));
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  await page.route("**/api/lecture/ask", async (route: Route) => {
    await route.continue({ url: `http://127.0.0.1:${port}/api/lecture/ask` });
  });
  return {
    release: () => release?.(),
    requests: () => requests,
    close: async () => {
      release?.();
      for (const socket of sockets) socket.destroy();
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test.describe("ask Esc stepwise exit", () => {
  test.use({ viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" });

  test("Esc on body, code region, selection layer, and panel textarea steps out", async ({ page }) => {
    await startGenerated(page);
    await enterSelection(page);

    // 焦点在 body：selecting 下一次 Esc 退出圈选。圈选层会挡住点击，只移动焦点。
    await page.locator("body").focus();
    await page.keyboard.press("Escape");
    await expect(layer(page)).toHaveCount(0);
    await expect(entry(page)).not.toHaveAttribute("aria-pressed", "true");

    // 点在非 Monaco 的代码区标题（黑板文案，不是 .monaco-editor）：同样退出。
    await enterSelection(page);
    const title = page.getByText("黑板", { exact: true });
    await expect(title).toBeVisible();
    await clickCenter(page, title);
    await page.keyboard.press("Escape");
    await expect(layer(page)).toHaveCount(0);

    // 焦点在画选层：selecting 一次 Esc 退出。
    await enterSelection(page);
    await layer(page).focus();
    await expect(layer(page)).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(layer(page)).toHaveCount(0);

    // 面板 textarea：第一次 Esc 关面板回到 selecting 且焦点在画选层，第二次退出。
    await enterSelection(page);
    await openPanel(page);
    const question = panel(page).locator("[data-ask-question]");
    await question.fill(QUESTION);
    await question.press("Escape");
    await expect(panel(page)).toHaveCount(0);
    await expect(layer(page)).toBeVisible();
    await expect(layer(page)).toBeFocused();
    await expect(entry(page)).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("Escape");
    await expect(layer(page)).toHaveCount(0);
    await expect(entry(page)).not.toHaveAttribute("aria-pressed", "true");
  });

  test("Esc inside Monaco does not leave selection mode", async ({ page }) => {
    await startGenerated(page);
    const monaco = page.locator(".monaco-editor");
    await expect(monaco).toBeVisible();
    // 练习会换掉编辑器实例。Monaco 另有 aria-hidden 的 ime textarea，按键进可访问的那个。
    const textarea = () => page.getByRole("textbox", { name: "Editor content" });
    const lines = page.locator(".monaco-editor .view-lines");

    // 讲课中编辑器只读。先记下可提问的课，再切练习打字；切练习会停课，打完字再切回听课恢复同一节课。
    await page.getByRole("button", { name: "练习", exact: true }).click();
    await expect(page.getByRole("button", { name: "练习", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByText("练习中 · 可编辑")).toBeVisible();
    await expect(textarea()).toBeVisible();

    // 圈选外：在 Monaco 里打字（含 Q）、选中文本、按 Esc，都不进入圈选。
    await textarea().focus();
    await expect(textarea()).toBeFocused();
    await page.keyboard.press("Control+End");
    await page.keyboard.type("qQ");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Shift+ArrowLeft");
    await page.keyboard.press("Control+A");
    await expect(lines).toContainText("qQ");
    await expect(layer(page)).toHaveCount(0);
    await expect(entry(page)).not.toHaveAttribute("aria-pressed", "true");

    await page.getByRole("button", { name: "听课", exact: true }).click();
    await expect(page.getByText("第 1 / 3 步")).toBeVisible();
    const pause = page.locator("header").getByRole("button", { name: "暂停", exact: true });
    const resume = page.locator("header").getByRole("button", { name: "继续", exact: true });
    await expect(pause.or(resume)).toBeVisible();
    if (await pause.isVisible()) await pause.click();
    await expect(lines).toContainText("qQ");

    await enterSelection(page);
    // 画选层 absolute inset-0 z-30 盖住 Monaco，鼠标点不到编辑器；圈选中只能用键盘或程序把焦点送进 textarea。
    await textarea().focus();
    await expect(textarea()).toBeFocused();
    await page.keyboard.press("Control+End");
    await page.keyboard.type("qQ");
    await page.keyboard.press("Shift+ArrowLeft");
    await page.keyboard.press("Control+A");
    await page.keyboard.press("Escape");
    await expect(lines).toContainText("qQqQ");
    await expect(layer(page)).toBeVisible();
    await expect(entry(page)).toHaveAttribute("aria-pressed", "true");

    await openPanel(page);
    await textarea().focus();
    await expect(textarea()).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(panel(page)).toBeVisible();
    await expect(layer(page)).toBeVisible();
    await expect(entry(page)).toHaveAttribute("aria-pressed", "true");
  });

  test("Esc during sending closes the panel and the held answer still completes", async ({ page }) => {
    const stream = await mockHeldAskStream(page);
    try {
      await startGenerated(page);
      await enterSelection(page);
      await openPanel(page);
      await panel(page).locator("[data-ask-question]").fill(QUESTION);
      await panel(page).locator("[data-ask-submit]").click();

      await expect(panel(page).locator("[data-ask-waiting]")).toBeVisible();
      await expectBusyEntry(page);
      await expect.poll(() => stream.requests()).toBe(1);

      await panel(page).locator("[data-ask-question]").press("Escape");
      await expect(panel(page)).toHaveCount(0);
      await expect(layer(page)).toBeVisible();
      await expect(layer(page)).toBeFocused();
      // 请求仍在飞：入口保持 busy，圈选还在，回答还没出现。
      await expectBusyEntry(page);
      await expect(page.getByRole("button", { name: `你问的 ${QUESTION}` })).toHaveCount(0);

      stream.release();
      const saved = page.getByRole("button", { name: `你问的 ${QUESTION}` });
      await expect(saved).toBeVisible();
      // 关面板后 token 已摘掉，回答只追加、不展开、不进入播放。
      await expect(saved).toHaveAttribute("aria-expanded", "false");
      await expect(page.getByText(ANSWER_NARRATION)).toHaveCount(0);
      await expect(layer(page)).toBeVisible();
      await expect(entry(page)).toHaveAttribute("aria-pressed", "true");
      await expect(entry(page)).not.toHaveAttribute("aria-disabled", "true");
      expect(stream.requests()).toBe(1);
    } finally {
      await stream.close();
    }
  });
});
