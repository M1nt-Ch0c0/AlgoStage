import { expect, test, type Page } from "@playwright/test";
import { ASK_IMAGE_NOT_USED_NOTE } from "../lib/ask/ask-ui-text";

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

function answerFor(stepId: string, imageAttached?: boolean) {
  return {
    v: 1 as const,
    id: "ans-e2e-image",
    stepId,
    question: QUESTION,
    selection: {
      mode: "single" as const,
      bbox: { x: 0, y: 0, width: 10, height: 10 },
      targets: [{ kind: "code" as const, id: "c1", stepId }],
    },
    segments: [{ id: "seg1", narration: ANSWER_TEXT }],
    createdAt: "2026-10-14T00:00:00.000Z",
    ...(imageAttached !== undefined ? { imageAttached } : {}),
  };
}

function lectureBody(firstNarration: string, withAnswer: boolean, version: string, imageAttached?: boolean) {
  const steps = [step("s1", firstNarration), step("s2", "边走边查"), step("s3", "返回答案")];
  const lines = [
    ...steps.map((item) => JSON.stringify({ type: "step", step: item })),
    JSON.stringify({
      type: "result",
      script: { problemSlug: "group-anagrams", mode: "lecture", language: "zh", solutionLanguage: "typescript", steps },
      cacheKey: "a".repeat(40),
      scriptVersion: version.repeat(40),
      answers: withAnswer ? { s1: [answerFor("s1", imageAttached)] } : {},
      askDisabledStepIds: [],
    }),
  ];
  return `${lines.join("\n")}\n`;
}

async function mockLectureWithAnswer(page: Page, imageAttached?: boolean) {
  await page.route("**/api/settings", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ serverKeyDisabled: false }),
    });
  });
  await page.route("**/api/lecture", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/x-ndjson",
      body: lectureBody(OLD_STEP, true, "b", imageAttached),
    });
  });
}

async function mockLectureRegenerate(page: Page, regen: "success" | "failure", imageAttached = false) {
  await page.route("**/api/settings", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ serverKeyDisabled: false }),
    });
  });
  await page.route("**/api/lecture", async (route) => {
    const body = (route.request().postDataJSON() ?? {}) as { regenerate?: boolean };
    if (!body.regenerate) {
      await route.fulfill({
        status: 200,
        contentType: "application/x-ndjson",
        body: lectureBody(OLD_STEP, true, "b", imageAttached),
      });
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
    await route.fulfill({
      status: 200,
      contentType: "application/x-ndjson",
      body: lectureBody(NEW_STEP, false, "c"),
    });
  });
}

async function settlePlayback(page: Page) {
  const pause = page.locator("header").getByRole("button", { name: "暂停", exact: true });
  const resume = page.locator("header").getByRole("button", { name: "继续", exact: true });
  await expect(pause.or(resume)).toBeVisible();
  if (await pause.isVisible()) await pause.click();
}

async function startLecture(page: Page) {
  await page.goto("/problem/group-anagrams");
  await page.getByRole("button", { name: "开始讲课", exact: true }).click();
  await expect(page.getByText("第 1 / 3 步")).toBeVisible();
  await settlePlayback(page);
}

async function openRegenDialog(page: Page) {
  await page.getByRole("button", { name: "更多", exact: true }).click();
  await page.getByRole("menuitem", { name: "重新生成" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  return dialog;
}

test.describe("M7/T9 step answer imageAttached note (1280x800)", () => {
  test.use({ viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" });

  test("I6: copy pending Cosmo", async () => {
    test.skip(true, "I6 BLOCKED: copy pending Cosmo");
    expect(ASK_IMAGE_NOT_USED_NOTE).toBe("__COSMO_LOCKED_COPY__");
  });

  test("I3: imageAttached=true does not show missing image notice", async ({ page }) => {
    await mockLectureWithAnswer(page, true);
    await startLecture(page);
    const askBtn = page.getByRole("button", { name: `你问的 ${QUESTION}` });
    await expect(askBtn).toBeVisible();
    await askBtn.click();
    await expect(page.getByText(ANSWER_TEXT)).toBeVisible();
    await expect(page.locator("[data-testid='answer-image-missing']")).toHaveCount(0);
    await expect(page.locator("[data-answer-image-notice]")).toHaveCount(0);
  });

  test("I4: legacy answer without imageAttached (undefined) does not show missing image notice", async ({ page }) => {
    await mockLectureWithAnswer(page, undefined);
    await startLecture(page);
    const askBtn = page.getByRole("button", { name: `你问的 ${QUESTION}` });
    await expect(askBtn).toBeVisible();
    await askBtn.click();
    await expect(page.getByText(ANSWER_TEXT)).toBeVisible();
    await expect(page.locator("[data-testid='answer-image-missing']")).toHaveCount(0);
    await expect(page.locator("[data-answer-image-notice]")).toHaveCount(0);
  });

  test("imageAttached=false shows notice when expanded, hidden when collapsed", async ({ page }) => {
    await mockLectureWithAnswer(page, false);
    await startLecture(page);
    const askBtn = page.getByRole("button", { name: `你问的 ${QUESTION}` });
    await expect(askBtn).toBeVisible();
    await expect(page.locator("[data-testid='answer-image-missing']")).toHaveCount(0);
    await expect(page.locator("[data-answer-image-notice]")).toHaveCount(0);

    await askBtn.click();
    const notice = page.locator("[data-testid='answer-image-missing']");
    await expect(notice).toBeVisible();
    await expect(notice).toHaveText(ASK_IMAGE_NOT_USED_NOTE);
    await expect(notice).not.toHaveAttribute("aria-live");
    await expect(notice).not.toHaveAttribute("role");
    await expect(page.locator("[data-answer-image-notice]")).toBeVisible();
    await expect(page.getByText(ANSWER_TEXT)).toBeVisible();

    await askBtn.click();
    await expect(page.locator("[data-testid='answer-image-missing']")).toHaveCount(0);
  });

  test("I1/I12 server-mode persistence: reload and restart preserves imageAttached=false notice", async ({ page }) => {
    // True browser localStorage I12 persistence is covered via storage unit tests in tests/answers-repo.test.ts;
    // this covers persistence across page reload under server-mode lecture mock.
    await mockLectureWithAnswer(page, false);
    await startLecture(page);
    const askBtn = page.getByRole("button", { name: `你问的 ${QUESTION}` });
    await expect(askBtn).toBeVisible();
    await askBtn.click();
    await expect(page.locator("[data-testid='answer-image-missing']")).toBeVisible();

    await page.reload();
    await page.getByRole("button", { name: "开始讲课", exact: true }).click();
    await expect(page.getByText("第 1 / 3 步")).toBeVisible();
    await settlePlayback(page);
    const askBtnAfterReload = page.getByRole("button", { name: `你问的 ${QUESTION}` });
    await expect(askBtnAfterReload).toBeVisible();
    await askBtnAfterReload.click();
    await expect(page.locator("[data-testid='answer-image-missing']")).toBeVisible();
    await expect(page.locator("[data-testid='answer-image-missing']")).toHaveText(ASK_IMAGE_NOT_USED_NOTE);
  });

  test("I10: regenerate success clears ask button and missing image notice", async ({ page }) => {
    await mockLectureRegenerate(page, "success", false);
    await startLecture(page);
    const askBtn = page.getByRole("button", { name: `你问的 ${QUESTION}` });
    await expect(askBtn).toBeVisible();
    await askBtn.click();
    await expect(page.locator("[data-testid='answer-image-missing']")).toBeVisible();

    const dialog = await openRegenDialog(page);
    await dialog.getByRole("button", { name: "确定重新生成", exact: true }).click();
    await expect(page.getByText(NEW_STEP).first()).toBeVisible();
    await expect(page.getByText("第 1 / 3 步")).toBeVisible();
    await expect(page.getByRole("button", { name: /你问的/ })).toHaveCount(0);
    await expect(page.locator("[data-testid='answer-image-missing']")).toHaveCount(0);
    await expect(page.locator("[data-answer-image-notice]")).toHaveCount(0);
  });

  test("I11: regenerate failure keeps ask button and notice after expand", async ({ page }) => {
    await mockLectureRegenerate(page, "failure", false);
    await startLecture(page);
    const askBtn = page.getByRole("button", { name: `你问的 ${QUESTION}` });
    await expect(askBtn).toBeVisible();

    const dialog = await openRegenDialog(page);
    await dialog.getByRole("button", { name: "确定重新生成", exact: true }).click();
    await expect(page.getByText("AI 服务暂时连不上，请稍后再试。").first()).toBeVisible();
    await expect(page.getByText(OLD_STEP).first()).toBeVisible();

    await expect(askBtn).toBeVisible();
    await askBtn.click();
    await expect(page.locator("[data-testid='answer-image-missing']")).toBeVisible();
    await expect(page.locator("[data-testid='answer-image-missing']")).toHaveText(ASK_IMAGE_NOT_USED_NOTE);
  });
});

test.describe("M7/T9 mobile viewport (390x844)", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, reducedMotion: "reduce" });

  test("I1 mobile: imageAttached=false shows notice when expanded", async ({ page }) => {
    await mockLectureWithAnswer(page, false);
    await startLecture(page);
    const askBtn = page.getByRole("button", { name: `你问的 ${QUESTION}` });
    await expect(askBtn).toBeVisible();
    await askBtn.click();
    const notice = page.locator("[data-testid='answer-image-missing']");
    await expect(notice).toBeVisible();
    await expect(notice).toHaveText(ASK_IMAGE_NOT_USED_NOTE);
    await expect(notice).not.toHaveAttribute("aria-live");
    await expect(notice).not.toHaveAttribute("role");
    await expect(page.locator("[data-answer-image-notice]")).toBeVisible();
  });
});
