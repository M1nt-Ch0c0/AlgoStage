import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * M7 整节课重播 / 重新生成 × 提问组合（design-ask-v03-m7-replay §7 e2e 前半；QA-CASES R1 / A6）。
 * 只测已合入行为；不碰单条「重答 / 再答一次」（未批准）。
 * 不用墙钟断言；上游全部 page.route mock。
 */

const QUESTION = "这段代码为什么用哈希表？";
const ANSWER_TEXT = "因为要在常数时间查补数。";
const OLD_STEP = "开局建表";
const NEW_STEP = "新稿第一步";

const step = (id: string, narration: string) => ({
  id,
  narration,
  targets: [{ kind: "code-line", start: 1, end: 2 }],
  effects: [],
});

function answerFor(stepId: string) {
  return {
    v: 1 as const,
    id: "ans-e2e-regen",
    stepId,
    question: QUESTION,
    selection: {
      mode: "single" as const,
      bbox: { x: 0, y: 0, width: 10, height: 10 },
      targets: [{ kind: "code" as const, id: "c1", stepId }],
    },
    segments: [{ id: "seg1", narration: ANSWER_TEXT }],
    createdAt: "2026-10-14T00:00:00.000Z",
  };
}

function lectureBody(firstNarration: string, withAnswer: boolean, version: string) {
  const steps = [step("s1", firstNarration), step("s2", "边走边查"), step("s3", "返回答案")];
  const lines = [
    ...steps.map((item) => JSON.stringify({ type: "step", step: item })),
    JSON.stringify({
      type: "result",
      script: { problemSlug: "group-anagrams", mode: "lecture", language: "zh", solutionLanguage: "typescript", steps },
      cacheKey: "a".repeat(40),
      scriptVersion: version.repeat(40),
      answers: withAnswer ? { s1: [answerFor("s1")] } : {},
      askDisabledStepIds: [],
    }),
  ];
  return `${lines.join("\n")}\n`;
}

type RegenOutcome = "success" | "failure";

async function mockLecture(page: Page, regen: RegenOutcome = "success") {
  const posts: Array<{ regenerate?: boolean }> = [];
  await page.route("**/api/settings", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ serverKeyDisabled: false }) }),
  );
  await page.route("**/api/lecture", async (route: Route) => {
    const body = (route.request().postDataJSON() ?? {}) as { regenerate?: boolean };
    posts.push(body);
    if (!body.regenerate) {
      await route.fulfill({ status: 200, contentType: "application/x-ndjson", body: lectureBody(OLD_STEP, true, "b") });
      return;
    }
    if (regen === "failure") {
      await route.fulfill({
        status: 502,
        contentType: "application/json",
        body: JSON.stringify({ code: "UPSTREAM_ERROR", error: "UPSTREAM_ERROR", retryable: true, message: "raw" }),
      });
      return;
    }
    // 服务端在写新缓存的同一事务里清回答，所以新稿 answers 为空。
    await route.fulfill({ status: 200, contentType: "application/x-ndjson", body: lectureBody(NEW_STEP, false, "c") });
  });
  return posts;
}

async function settle(page: Page) {
  const pause = page.locator("header").getByRole("button", { name: "暂停", exact: true });
  const resume = page.locator("header").getByRole("button", { name: "继续", exact: true });
  await expect(pause.or(resume)).toBeVisible();
  if (await pause.isVisible()) await pause.click();
  await expect(resume).toBeVisible();
}

async function start(page: Page) {
  await page.goto("/problem/group-anagrams");
  await page.getByRole("button", { name: "开始讲课", exact: true }).click();
  await expect(page.getByText("第 1 / 3 步")).toBeVisible();
  await settle(page);
  await expect(page.getByRole("button", { name: `你问的 ${QUESTION}` })).toBeVisible();
}

async function openRegenDialog(page: Page) {
  await page.getByRole("button", { name: "更多", exact: true }).click();
  await page.getByRole("menuitem", { name: "重新生成" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  return dialog;
}

test.describe("M7 replay / regenerate with asked answers", () => {
  test.use({ viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" });

  test("A6/replay. expanded answer is kept but collapsed after 重播, marker stays", async ({ page }) => {
    await mockLecture(page);
    await start(page);
    const askBtn = page.getByRole("button", { name: `你问的 ${QUESTION}` });
    await askBtn.click();
    await expect(askBtn).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByText(ANSWER_TEXT)).toBeVisible();

    const replay = page.getByRole("button", { name: "重播", exact: true });
    for (let i = 0; i < 4 && (await replay.count()) === 0; i++) {
      const next = page.getByRole("button", { name: "下一步", exact: true });
      await expect(next).toBeEnabled();
      await next.click();
    }
    await expect(replay).toBeVisible();
    await replay.click();
    await expect(page.getByText("第 1 / 3 步")).toBeVisible();
    await settle(page);

    await expect(askBtn).toBeVisible();
    await expect(askBtn).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByText(ANSWER_TEXT)).toHaveCount(0);
    await expect(page.getByRole("button", { name: /跳到第 1 步，有 1 个提问/ })).toBeVisible();
    // 展开后正文仍在。
    await askBtn.click();
    await expect(page.getByText(ANSWER_TEXT)).toBeVisible();
  });

  test("R1. confirm copy counts asked questions; 取消 keeps answers", async ({ page }) => {
    const posts = await mockLecture(page);
    await start(page);
    const dialog = await openRegenDialog(page);
    await expect(dialog).toContainText("你问过的 1 个问题会被清掉");
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("button", { name: `你问的 ${QUESTION}` })).toBeVisible();
    await expect(page.getByText(OLD_STEP).first()).toBeVisible();
    expect(posts.filter((p) => p.regenerate).length).toBe(0);
  });

  test("R1. confirming regenerate clears asked answers on success", async ({ page }) => {
    const posts = await mockLecture(page, "success");
    await start(page);
    const dialog = await openRegenDialog(page);
    await dialog.getByRole("button", { name: "确定重新生成", exact: true }).click();
    await expect(page.getByText(NEW_STEP).first()).toBeVisible();
    await expect(page.getByText("第 1 / 3 步")).toBeVisible();
    await expect(page.getByRole("button", { name: /你问的/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /有 \d+ 个提问/ })).toHaveCount(0);
    expect(posts.filter((p) => p.regenerate).length).toBe(1);
  });

  test("R1. regenerate failure rolls back: old script and asked answers kept", async ({ page }) => {
    const posts = await mockLecture(page, "failure");
    await start(page);
    const dialog = await openRegenDialog(page);
    await dialog.getByRole("button", { name: "确定重新生成", exact: true }).click();
    await expect.poll(() => posts.filter((p) => p.regenerate).length).toBe(1);
    await expect(page.getByText("AI 服务暂时连不上，请稍后再试。").first()).toBeVisible();
    await expect(page.getByText("raw", { exact: true })).toHaveCount(0);
    await expect(page.getByText(OLD_STEP).first()).toBeVisible();
    await expect(page.getByText(NEW_STEP)).toHaveCount(0);
    const askBtn = page.getByRole("button", { name: `你问的 ${QUESTION}` });
    await expect(askBtn).toBeVisible();
    await expect(page.getByRole("button", { name: /跳到第 1 步，有 1 个提问/ })).toBeVisible();
    await askBtn.click();
    await expect(page.getByText(ANSWER_TEXT)).toBeVisible();
  });
});
