import { expect, test } from "@playwright/test";

const step = (id: string, narration: string) => ({
  id,
  narration,
  targets: [{ kind: "code-line", start: 1, end: 2 }],
  effects: [],
  dwellMs: 100,
});

test("switching to next problem after lecture finishes resets finished state and old narration", async ({ page }) => {
  await page.route("**/api/lecture", async (route) => {
    const body = route.request().postDataJSON() as { slug?: string; solutionLanguage?: string };
    const problemSlug = body.slug ?? "group-anagrams";
    const solutionLanguage = body.solutionLanguage ?? "typescript";
    const steps = [step("s1", "旧题字幕甲"), step("s2", "旧题字幕乙")];
    const lines = [
      ...steps.map((item) => JSON.stringify({ type: "step", step: item })),
      JSON.stringify({
        type: "result",
        script: { problemSlug, mode: "lecture", language: "zh", solutionLanguage, steps },
      }),
    ];
    await route.fulfill({
      status: 200,
      contentType: "application/x-ndjson",
      body: `${lines.join("\n")}\n`,
    });
  });

  await page.goto("/problem/group-anagrams");
  await page.getByRole("group", { name: "语速" }).getByRole("button", { name: "2x", exact: true }).click();
  await page.getByRole("button", { name: "自动播放", exact: true }).click();
  await page.locator("header").getByRole("button", { name: "开始讲课", exact: true }).click();

  await expect(page.getByText("讲完了")).toBeVisible();
  const nextLink = page.getByRole("link", { name: "下一题", exact: true });
  await expect(nextLink).toBeVisible();

  await nextLink.click();
  await expect(page).toHaveURL(/\/problem\/longest-consecutive-sequence$/);
  await expect(page.locator("header").getByRole("button", { name: "开始讲课", exact: true })).toBeVisible();

  await expect(page.getByText("讲完了")).toHaveCount(0);
  await expect(page.getByText("下一步准备中…")).toHaveCount(0);
  await expect(page.getByText("旧题字幕甲")).toHaveCount(0);
  await expect(page.getByText("旧题字幕乙")).toHaveCount(0);
});
