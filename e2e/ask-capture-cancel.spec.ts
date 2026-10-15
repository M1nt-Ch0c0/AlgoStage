import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * 提问提交时「正在准备截图…」不把取消按钮顶下去；截图卡住时取消不发出提问请求。
 * 帮手从 e2e/ask-selection.spec.ts 原样复制，不 import（同 e2e/s4-capture-perf.spec.ts）。
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

async function openAskPanel(page: Page) {
  await startGenerated(page);
  await pauseLecture(page);
  await enterSelection(page);
  await dragOnStage(page);
  await page.locator("[data-ask-panel] [data-ask-question]").fill(QUESTION);
}

test.describe("ask capture layout and late cancel", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("preparing status does not move 取消", async ({ page }) => {
    await openAskPanel(page);
    const cancel = page.locator("[data-ask-cancel]");
    const before = await cancel.boundingBox();
    if (!before) throw new Error("取消 has no box");

    await page.locator("[data-ask-submit]").click();
    await expect(page.locator("[data-ask-capture-preparing]")).toBeVisible();
    await expect(page.locator("[data-ask-capture-preparing]")).toHaveText("正在准备截图…");

    const during = await cancel.boundingBox();
    if (!during) throw new Error("取消 has no box while preparing");
    expect(Math.abs(during.y - before.y)).toBeLessThanOrEqual(0.5);
  });

  test("取消 during capture sends no ask request", async ({ page }) => {
    let askRequests = 0;
    await page.route("**/api/lecture/ask", async (route) => {
      askRequests += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/x-ndjson",
        body: askStream("s1"),
      });
    });
    await openAskPanel(page);

    const client = await page.context().newCDPSession(page);
    await client.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    try {
      await page.locator("[data-ask-submit]").click();
      await page.locator("[data-ask-cancel]").click({ force: true });
      await page.waitForTimeout(3000);
      expect(askRequests).toBe(0);
    } finally {
      await client.send("Emulation.setCPUThrottlingRate", { rate: 1 }).catch(() => {});
    }
  });
});
