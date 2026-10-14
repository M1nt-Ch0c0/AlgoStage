import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * M7 ask 主流程 e2e（QA-CASES-v0.3-ask：S1/S2、A1/A2、E1/E2/E3）。
 * 不用墙钟断言：只等 aria-busy / data-ask-* / Playwright 自动等待。
 * 上游全部用 page.route 假的 /api/lecture/ask（NDJSON 或 JSON 错误码），不调真实 AI。
 * NO_BYOK 只断言前端白名单文案，不绑定服务端 message。
 * replay / regenerate 不在本文件。
 */

const CACHE_KEY = "a".repeat(40);
const SCRIPT_VERSION = "b".repeat(40);
const QUESTION = "这一步在做什么？";
const ANSWER_NARRATION = "把相同字母的词放进同一组。";

const COPY = {
  upstream: "AI 服务暂时连不上，请稍后再试。",
  rateLimited: "问得有点快，请稍后再问。",
  noByok: "老师还没接上 AI，先去设置里填自己的 Key。",
} as const;

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
      script: { problemSlug: "group-anagrams", mode: "lecture", language: "zh", solutionLanguage: "typescript", steps },
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
    id: "ans-e2e-main",
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
  `${JSON.stringify({ type: "start", answerId: "ans-e2e-main", stepId, imageUsed: false })}\n`;
const segmentLine = () => `${JSON.stringify({ type: "segment", segment: SEGMENT })}\n`;
const resultLine = (stepId: string) => `${JSON.stringify({ type: "result", answer: answerFor(stepId) })}\n`;
const askStream = (stepId: string) => startLine(stepId) + segmentLine() + resultLine(stepId);

async function fulfillAskOk(route: Route) {
  await route.fulfill({ status: 200, contentType: "application/x-ndjson", body: askStream("s1") });
}

async function fulfillAskError(route: Route, status: number, code: string) {
  // message 故意填上游原文，UI 必须只显示白名单文案。
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify({ error: code, code, message: `upstream raw ${code}` }),
  });
}

async function startGenerated(page: Page) {
  await page.route("**/api/settings", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ serverKeyDisabled: false, keySource: "env" }),
    }),
  );
  await page.route("**/api/lecture", async (route) => {
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
const panel = (page: Page) => page.locator("[data-ask-panel]");

/** S1：进圈选；S2：在可视化上拖框带出面板；填问题并提交。 */
async function selectAndAsk(page: Page) {
  const button = entry(page);
  await expect(button).toBeEnabled();
  await expect(button).not.toHaveAttribute("aria-disabled", "true");
  await button.click();
  await expect(page.locator("[data-ask-layer]")).toBeVisible();
  await expect(button).toHaveAttribute("aria-pressed", "true");
  await expect(button).toHaveText(/退出圈选/);

  const viz = page.locator("[data-ask-stage]").locator('[data-ask-id="viz:s1"]').first();
  await expect(viz).toBeVisible();
  const box = await viz.boundingBox();
  if (!box) throw new Error("viz target has no box");
  await page.mouse.move(box.x + 8, box.y + 8);
  await page.mouse.down();
  await page.mouse.move(box.x + Math.max(box.width - 8, 40), box.y + Math.max(Math.min(box.height - 8, 80), 36), {
    steps: 8,
  });
  await page.mouse.up();
  await expect(panel(page)).toBeVisible();
  await expect(panel(page).locator("[data-ask-panel-label]")).not.toHaveText("已选：无");
  await expect(page.locator("[data-ask-layer] [data-ask-selection]")).toBeVisible();

  const submit = panel(page).locator("[data-ask-submit]");
  await expect(submit).toHaveAttribute("aria-disabled", "true"); // 空问题不可发
  await panel(page).locator("[data-ask-question]").fill(QUESTION);
  await expect(submit).not.toHaveAttribute("aria-disabled", "true");
  await submit.click();
}

/**
 * 分块 NDJSON：先写 start + segment，挂住，放行后再写 result 收尾。
 * route.fulfill 会等整个 body，所以续到本机分块服务（同 ask-selection 的 mockHeldLecture）。
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
    res.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-cache, no-transform" });
    res.write(startLine("s1"));
    res.write(segmentLine());
    void gate.then(() => {
      if (!res.writableEnded) res.end(resultLine("s1"));
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  await page.route("**/api/lecture/ask", async (route) => {
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

test.describe("M7 ask main flow 1280", () => {
  // 回答是打字机效果；减少动效后回答直接出全文，断言不依赖打字速度。
  test.use({ viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" });

  test("S1/S2/A2. selection ask posts the question and selection, answer attaches to the step", async ({ page }) => {
    let body: { question?: string; stepId?: string; selection?: { targets?: unknown[] } } | null = null;
    await page.route("**/api/lecture/ask", async (route) => {
      body = route.request().postDataJSON();
      await fulfillAskOk(route);
    });
    await startGenerated(page);
    await selectAndAsk(page);
    await expect(page.getByRole("button", { name: `你问的 ${QUESTION}` })).toBeVisible();
    await expect(page.getByText(ANSWER_NARRATION)).toBeVisible();
    await expect(page.getByText("第 1 / 3 步")).toBeVisible();
    await expect(page.locator("[data-ask-layer]")).toHaveCount(0);
    expect(body).not.toBeNull();
    expect(body!.question).toBe(QUESTION);
    expect(body!.stepId).toBe("s1");
    expect(body!.selection?.targets?.length ?? 0).toBeGreaterThan(0);
  });

  test("A1/G5. streamed NDJSON shows waiting + busy entry until result, then finishes", async ({ page }) => {
    const stream = await mockHeldAskStream(page);
    try {
      await startGenerated(page);
      await selectAndAsk(page);
      // 流挂在 start + segment：面板在等待态，取消可用；回答中入口置灰（busy），不是 pending。
      await expect(panel(page).locator("[data-ask-waiting]")).toBeVisible();
      await expect(panel(page).locator("[data-ask-waiting]")).toContainText("老师在想");
      // 面板发送按钮，防连点
      await expect(panel(page).locator("[data-ask-submit]")).toHaveAttribute("aria-disabled", "true");
      await expect(panel(page).getByRole("button", { name: "取消", exact: true })).toBeVisible();
      await expect(entry(page)).toHaveAttribute("data-ask-disabled-reason", "busy");
      await expect(entry(page)).toHaveAttribute("aria-disabled", "true");
      const describedBy = await entry(page).getAttribute("aria-describedby");
      expect(describedBy).toBeTruthy();
      await expect(page.locator(`[id="${describedBy}"]`)).toHaveText("上一个问题还在回答，答完再问");
      await expect(page.locator("[role=alert][data-ask-error]")).toHaveCount(0);
      stream.release();
      await expect(page.getByText(ANSWER_NARRATION)).toBeVisible();
      await expect(page.getByRole("button", { name: `你问的 ${QUESTION}` })).toBeVisible();
      await expect(panel(page)).toHaveCount(0);
      // 回答在播放仍算 busy（G5）；点「回到这一步」停播后入口恢复（A3）。
      await page.getByRole("button", { name: "回到这一步", exact: true }).click();
      await expect(page.getByText("第 1 / 3 步")).toBeVisible();
      await expect(entry(page)).not.toHaveAttribute("data-ask-disabled-reason", "busy");
      expect(stream.requests()).toBe(1);
    } finally {
      await stream.close();
    }
  });

  test("E3. UPSTREAM_ERROR shows whitelisted copy and 重新问 succeeds, draft and selection kept", async ({ page }) => {
    let calls = 0;
    await page.route("**/api/lecture/ask", async (route) => {
      calls += 1;
      if (calls === 1) return fulfillAskError(route, 502, "UPSTREAM_ERROR");
      return fulfillAskOk(route);
    });
    await startGenerated(page);
    await selectAndAsk(page);
    const error = panel(page).locator("[data-ask-error='UPSTREAM_ERROR']");
    await expect(error).toHaveText(COPY.upstream);
    await expect(error).toHaveAttribute("role", "alert");
    await expect(page.getByText("upstream raw UPSTREAM_ERROR")).toHaveCount(0);
    await expect(panel(page).locator("[data-ask-question]")).toHaveValue(QUESTION);
    await expect(page.locator("[data-ask-layer] [data-ask-selection]")).toBeVisible();
    await panel(page).getByRole("button", { name: "重新问", exact: true }).click();
    await expect(page.getByText(ANSWER_NARRATION)).toBeVisible();
    expect(calls).toBe(2);
  });

  test("E3. rapid 重新问 never runs two ask requests at once", async ({ page }) => {
    let calls = 0;
    let inflight = 0;
    let maxInflight = 0;
    let releaseRetry: (() => void) | null = null;
    await page.route("**/api/lecture/ask", async (route) => {
      calls += 1;
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
      try {
        if (calls === 1) return await fulfillAskError(route, 502, "UPSTREAM_ERROR");
        await new Promise<void>((resolve) => {
          releaseRetry = resolve;
        });
        return await fulfillAskOk(route);
      } finally {
        inflight -= 1;
      }
    });
    await startGenerated(page);
    await selectAndAsk(page);
    await expect(panel(page).locator("[data-ask-error='UPSTREAM_ERROR']")).toHaveText(COPY.upstream);
    const retry = panel(page).locator("[data-ask-submit]");
    await expect(retry).toHaveText("重新问");
    // 连点三下：第一下后按钮进入等待态（aria-disabled），后两下强制点也不能再发。
    await retry.click({ clickCount: 3 });
    await retry.click({ force: true });
    await expect(panel(page).locator("[data-ask-waiting]")).toBeVisible();
    await expect.poll(() => releaseRetry !== null).toBe(true);
    await retry.click({ force: true });
    releaseRetry!();
    await expect(page.getByText(ANSWER_NARRATION)).toBeVisible();
    await expect(page.getByRole("button", { name: `你问的 ${QUESTION}` })).toHaveCount(1);
    expect(calls).toBe(2);
    expect(maxInflight).toBe(1);
  });

  test("E1. RATE_LIMITED shows whitelisted copy with 重新问", async ({ page }) => {
    let calls = 0;
    await page.route("**/api/lecture/ask", async (route) => {
      calls += 1;
      if (calls === 1) return fulfillAskError(route, 429, "RATE_LIMITED");
      return fulfillAskOk(route);
    });
    await startGenerated(page);
    await selectAndAsk(page);
    await expect(panel(page).locator("[data-ask-error='RATE_LIMITED']")).toHaveText(COPY.rateLimited);
    await expect(page.getByText("upstream raw RATE_LIMITED")).toHaveCount(0);
    await panel(page).getByRole("button", { name: "重新问", exact: true }).click();
    await expect(page.getByText(ANSWER_NARRATION)).toBeVisible();
    expect(calls).toBe(2);
  });

  test("E2. NO_BYOK shows frontend copy with only 去设置, no retry", async ({ page }) => {
    let calls = 0;
    await page.route("**/api/lecture/ask", async (route) => {
      calls += 1;
      await fulfillAskError(route, 400, "NO_BYOK");
    });
    await startGenerated(page);
    await selectAndAsk(page);
    const error = panel(page).locator("[data-ask-error='NO_BYOK']");
    await expect(error).toHaveText(COPY.noByok);
    await expect(page.getByText("upstream raw NO_BYOK")).toHaveCount(0);
    const action = panel(page).locator("[data-ask-error-action]");
    await expect(action).toHaveCount(1);
    await expect(action).toHaveAttribute("data-ask-error-action", "settings");
    await expect(action).toHaveText("去设置");
    await expect(action).toHaveAttribute("href", "/settings");
    await expect(panel(page).getByRole("button", { name: "重新问", exact: true })).toHaveCount(0);
    await expect(panel(page).locator("[data-ask-submit]")).toHaveCount(0);
    expect(calls).toBe(1);
  });
});
