import { expect, test, type Page } from "@playwright/test";

const step = (id: string, narration: string) => ({
  id,
  narration,
  targets: [{ kind: "code-line", start: 1, end: 2 }],
  effects: [],
  dwellMs: 100,
});

async function mockLecture(page: Page, problemSlug: string) {
  let posts = 0;
  await page.route("**/api/lecture", async (route) => {
    posts++;
    const body = route.request().postDataJSON() as { solutionLanguage?: string };
    const solutionLanguage = body.solutionLanguage ?? "typescript";
    const steps = [step("s1", "第一步"), step("s2", "第二步"), step("s3", "第三步")];
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
  return () => posts;
}

test.beforeEach(async ({ context, baseURL }) => {
  // The real app serves every asset locally; smoke tests must never call AI/CDNs.
  await context.route(/^https?:\/\//, (route) => {
    if (new URL(route.request().url()).origin === baseURL) return route.continue();
    throw new Error(`Unexpected external request: ${new URL(route.request().url()).origin}`);
  });
});

test("narration end pauses and shows 「按空格继续」 and Space advances", async ({ page }) => {
  await mockLecture(page, "group-anagrams");
  await page.goto("/problem/group-anagrams");
  await page.getByRole("group", { name: "语速" }).getByRole("button", { name: "2x", exact: true }).click();
  await page.locator("header").getByRole("button", { name: "开始讲课", exact: true }).click();

  await expect(page.getByText("第 1 / 3 步")).toBeVisible();
  await expect(page.getByTestId("continue-hint")).toHaveText("按空格继续");

  await page.keyboard.press("Space");
  await expect(page.getByText("第 2 / 3 步")).toBeVisible();
  await expect(page.getByRole("button", { name: "跳到第 2 步", exact: true })).toHaveAttribute("aria-current", "step");
});

async function reachLastStep(page: Page) {
  await mockLecture(page, "group-anagrams");
  await page.goto("/problem/group-anagrams");
  await page.getByRole("group", { name: "语速" }).getByRole("button", { name: "2x", exact: true }).click();
  await page.locator("header").getByRole("button", { name: "开始讲课", exact: true }).click();
  for (let i = 1; i <= 2; i++) {
    await expect(page.getByText(`第 ${i} / 3 步`)).toBeVisible();
    await page.keyboard.press("Space");
  }
  await expect(page.getByText("第 3 / 3 步")).toBeVisible();
  await expect(page.getByTestId("continue-hint")).toBeVisible();
  await expect(page.getByText("讲完了")).toHaveCount(0);
}

async function expectFinishedReplay(page: Page) {
  await expect(page.getByText("讲完了")).toBeVisible();
  await expect(page.getByRole("button", { name: "重播", exact: true })).toHaveCount(1);
}

test("last step shows 「讲完了」 and 「重播」", async ({ page }) => {
  await mockLecture(page, "group-anagrams");
  await page.goto("/problem/group-anagrams");
  await page.getByRole("group", { name: "语速" }).getByRole("button", { name: "2x", exact: true }).click();
  await page.locator("header").getByRole("button", { name: "开始讲课", exact: true }).click();

  for (let i = 1; i <= 3; i++) {
    await expect(page.getByText(`第 ${i} / 3 步`)).toBeVisible();
    await expect(page.getByTestId("continue-hint")).toHaveText("按空格继续");
    await page.keyboard.press("Space");
  }

  await expect(page.getByText("讲完了")).toBeVisible();
  await expect(page.locator("header").getByRole("button", { name: "重播", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "重播", exact: true })).toHaveCount(1);
});

test("last step click on 「下一步」 shows finished panel and exactly one 「重播」", async ({ page }) => {
  await reachLastStep(page);
  const nextButton = page.getByRole("button", { name: "下一步", exact: true });
  await expect(nextButton).toHaveText("下一步");
  await expect(nextButton).toBeEnabled();
  await nextButton.click();
  await expectFinishedReplay(page);
});

test("last step ArrowRight shows finished panel and exactly one 「重播」", async ({ page }) => {
  await reachLastStep(page);
  await page.keyboard.press("ArrowRight");
  await expectFinishedReplay(page);
});

test("after the finished panel shows, Space and ArrowRight leave it in place", async ({ page }) => {
  await reachLastStep(page);
  await page.keyboard.press("Space");
  await expectFinishedReplay(page);

  await page.keyboard.press("Space");
  await expect(page.getByText("讲完了")).toBeVisible();
  await expect(page.getByText("第 3 / 3 步")).toBeVisible();
  await expect(page.getByRole("button", { name: "重播", exact: true })).toHaveCount(1);

  await page.keyboard.press("ArrowRight");
  await expect(page.getByText("讲完了")).toBeVisible();
  await expect(page.getByText("第 3 / 3 步")).toBeVisible();
  await expect(page.getByRole("button", { name: "重播", exact: true })).toHaveCount(1);
});

test("toggle 「自动播放」 on auto-advances without hint", async ({ page }) => {
  await mockLecture(page, "group-anagrams");
  await page.goto("/problem/group-anagrams");
  await page.getByRole("group", { name: "语速" }).getByRole("button", { name: "2x", exact: true }).click();

  const autoPlayBtn = page.getByRole("button", { name: "自动播放", exact: true });
  await autoPlayBtn.click();
  await expect(autoPlayBtn).toHaveAttribute("aria-pressed", "true");

  await page.locator("header").getByRole("button", { name: "开始讲课", exact: true }).click();
  await expect(page.getByText("第 3 / 3 步")).toBeVisible();
  await expect(page.getByText("讲完了")).toBeVisible();
  await expect(page.getByTestId("continue-hint")).toHaveCount(0);
});

test("after finish shows 「下一题」 link to next problem", async ({ page }) => {
  await mockLecture(page, "group-anagrams");
  await page.goto("/problem/group-anagrams");
  await page.getByRole("group", { name: "语速" }).getByRole("button", { name: "2x", exact: true }).click();
  await page.getByRole("button", { name: "自动播放", exact: true }).click();
  await page.locator("header").getByRole("button", { name: "开始讲课", exact: true }).click();

  await expect(page.getByText("讲完了")).toBeVisible();
  const nextLink = page.getByRole("link", { name: "下一题", exact: true });
  await expect(nextLink).toBeVisible();
  await expect(nextLink).toHaveAttribute("href", "/problem/longest-consecutive-sequence");
});

test("on last roadmap problem after finish shows 「回路线图」 link and no 「下一题」", async ({ page }) => {
  await mockLecture(page, "find-the-duplicate-number");
  await page.goto("/problem/find-the-duplicate-number");
  await page.getByRole("group", { name: "语速" }).getByRole("button", { name: "2x", exact: true }).click();
  await page.getByRole("button", { name: "自动播放", exact: true }).click();
  await page.locator("header").getByRole("button", { name: "开始讲课", exact: true }).click();

  await expect(page.getByText("讲完了")).toBeVisible();
  await expect(page.getByRole("link", { name: "下一题", exact: true })).toHaveCount(0);
  const roadmapLink = page.getByRole("link", { name: "回路线图", exact: true });
  await expect(roadmapLink).toBeVisible();
  await expect(roadmapLink).toHaveAttribute("href", "/roadmap");
});

test.describe("coarse pointer", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

  test("waiting shows 「点「下一步」继续」 and tapping 「下一步」 advances", async ({ page }) => {
    await mockLecture(page, "group-anagrams");
    await page.goto("/problem/group-anagrams");
    await page.getByRole("group", { name: "语速" }).getByRole("button", { name: "2x", exact: true }).click();
    await page.locator("header").getByRole("button", { name: "开始讲课", exact: true }).click();

    await expect(page.getByText("第 1 / 3 步")).toBeVisible();
    await expect(page.getByTestId("continue-hint")).toHaveText("点「下一步」继续");
    await expect(page.getByText("点「下一步」继续")).toHaveCount(1);
    const hintBox = await page.getByTestId("continue-hint").boundingBox();
    expect(hintBox).toBeTruthy();
    expect(hintBox!.x).toBeGreaterThanOrEqual(0);
    expect(hintBox!.y).toBeGreaterThanOrEqual(0);
    expect(hintBox!.x + hintBox!.width).toBeLessThanOrEqual(390);
    expect(hintBox!.y + hintBox!.height).toBeLessThanOrEqual(844);

    const nextButton = page.getByRole("button", { name: "下一步", exact: true });
    await expect(nextButton).toBeVisible();
    await expect(nextButton).toHaveText("下一步");
    const box = await nextButton.boundingBox();
    expect(box).toBeTruthy();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(box!.width).toBeGreaterThanOrEqual(44);
    await nextButton.tap();
    await expect(page.getByText("第 2 / 3 步")).toBeVisible();
    await expect(page.getByRole("button", { name: "跳到第 2 步", exact: true })).toHaveAttribute("aria-current", "step");
  });

  test("last step tap on 「下一步」 shows finished panel and exactly one 「重播」", async ({ page }) => {
    await mockLecture(page, "group-anagrams");
    await page.goto("/problem/group-anagrams");
    await page.getByRole("group", { name: "语速" }).getByRole("button", { name: "2x", exact: true }).click();
    await page.locator("header").getByRole("button", { name: "开始讲课", exact: true }).click();

    const nextButton = page.getByRole("button", { name: "下一步", exact: true });
    for (let i = 1; i <= 2; i++) {
      await expect(page.getByText(`第 ${i} / 3 步`)).toBeVisible();
      await nextButton.tap();
    }
    await expect(page.getByText("第 3 / 3 步")).toBeVisible();
    await expect(page.getByText("讲完了")).toHaveCount(0);
    await expect(nextButton).toHaveText("下一步");
    await nextButton.tap();
    await expect(page.getByText("讲完了")).toBeVisible();
    await expect(page.getByRole("button", { name: "重播", exact: true })).toHaveCount(1);
  });
});

// Full regenerate flow (confirming and streaming new lecture while paused) is tested in e2e/regenerate.spec.ts.
test("after finish 「重新生成」 in more menu shows confirm button without firing a second lecture POST", async ({ page }) => {
  const getPosts = await mockLecture(page, "group-anagrams");
  await page.goto("/problem/group-anagrams");
  await page.getByRole("group", { name: "语速" }).getByRole("button", { name: "2x", exact: true }).click();
  await page.getByRole("button", { name: "自动播放", exact: true }).click();
  await page.locator("header").getByRole("button", { name: "开始讲课", exact: true }).click();

  await expect(page.getByText("讲完了")).toBeVisible();
  expect(getPosts()).toBe(1);

  await page.getByRole("button", { name: "更多", exact: true }).click();
  await page.getByRole("menuitem", { name: "重新生成" }).click();

  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("button", { name: "确定重新生成", exact: true })).toBeVisible();
  expect(getPosts()).toBe(1);
});

