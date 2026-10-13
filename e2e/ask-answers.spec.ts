import { expect, test, type Page } from "@playwright/test";

const step = (id: string, narration: string) => ({
  id, narration, targets: [{ kind: "code-line", start: 1, end: 2 }], effects: [],
});

function answerFor(stepId: string) {
  return {
    v: 1 as const,
    id: "ans-e2e-1",
    stepId,
    question: "这段代码为什么用哈希表？",
    selection: {
      mode: "single" as const,
      bbox: { x: 0, y: 0, width: 10, height: 10 },
      targets: [{ kind: "code" as const, id: "c1", stepId }],
    },
    segments: [
      { id: "seg1", narration: "因为要在常数时间查补数。" },
      { id: "seg2", narration: "这样整体是线性时间。" },
    ],
    createdAt: "2026-10-14T00:00:00.000Z",
  };
}

async function mockLectureWithAnswer(page: Page) {
  await page.route("**/api/settings", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ serverKeyDisabled: false }),
    });
  });
  await page.route("**/api/lecture", async (route) => {
    const body = route.request().postDataJSON() as { solutionLanguage?: string };
    const language = body.solutionLanguage ?? "typescript";
    const steps = [step("s1", "开局建表"), step("s2", "边走边查"), step("s3", "返回答案")];
    const ans = answerFor("s1");
    const lines = [
      ...steps.map((item) => JSON.stringify({ type: "step", step: item })),
      JSON.stringify({
        type: "result",
        script: { problemSlug: "group-anagrams", mode: "lecture", language: "zh", solutionLanguage: language, steps },
        cacheKey: "a".repeat(40),
        scriptVersion: "b".repeat(40),
        answers: { s1: [ans] },
        askDisabledStepIds: [],
      }),
    ];
    await route.fulfill({
      status: 200,
      contentType: "application/x-ndjson",
      body: `${lines.join("\n")}\n`,
    });
  });
}

/** 短句可能在断言前就打完并变成「继续」，两种顶栏状态都停稳。 */
async function settlePlayback(page: Page) {
  const pause = page.locator("header").getByRole("button", { name: "暂停", exact: true });
  const resume = page.locator("header").getByRole("button", { name: "继续", exact: true });
  await expect(pause.or(resume)).toBeVisible();
  if (await pause.isVisible()) await pause.click();
}

async function flow(page: Page) {
  await mockLectureWithAnswer(page);
  await page.goto("/problem/group-anagrams");
  await page.getByRole("button", { name: "开始讲课", exact: true }).click();
  await expect(page.getByText("第 1 / 3 步")).toBeVisible();
  await settlePlayback(page);
  const askBtn = page.getByRole("button", { name: /你问的/ });
  await expect(askBtn).toBeVisible();
  await askBtn.click();
  await page.getByRole("button", { name: "播放回答", exact: true }).click();
  await expect(page.getByRole("button", { name: "回到这一步", exact: true })).toBeVisible();
  const before = await page.getByText(/第 \d+ \/ 3 步/).textContent();
  await page.getByRole("button", { name: "回到这一步", exact: true }).click();
  await expect(page.getByText(/第 \d+ \/ 3 步/)).toHaveText(before!);
  // 重播只在讲完面板上。走完剩余步再重播，展开应收起。
  const replay = page.getByRole("button", { name: "重播", exact: true });
  for (let i = 0; i < 3 && (await replay.count()) === 0; i++) {
    const next = page.getByRole("button", { name: "下一步", exact: true });
    await expect(next).toBeEnabled();
    await next.click();
  }
  await expect(replay).toBeVisible();
  await replay.click();
  await expect(page.getByText("第 1 / 3 步")).toBeVisible();
  await expect(page.getByText("因为要在常数时间查补数。")).toHaveCount(0);
  await settlePlayback(page);
  // 时间线圆点无障碍名是「跳到第 N 步，有 M 个提问」。
  await expect(page.getByRole("button", { name: /有 1 个提问/ })).toBeVisible();
  const stepLabel = await page.getByText(/第 \d+ \/ 3 步/).textContent();
  await askBtn.click();
  await expect(page.getByText(/第 \d+ \/ 3 步/)).toHaveText(stepLabel!);
}

for (const [w, h] of [[390, 844], [1280, 800]] as const) {
  test(`ask answers expand/return ${w}x${h}`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await flow(page);
    if (w === 390) {
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(1);
    }
  });
}
