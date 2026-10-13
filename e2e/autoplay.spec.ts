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
    await expect(page.getByTestId("continue-hint")).toHaveText("按空格继续");
    await page.keyboard.press("Space");
  }
  await expect(page.getByText("第 3 / 3 步")).toBeVisible();
  await expect(page.getByTestId("continue-hint")).toHaveText("按空格继续");
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

test("Space on the focused speed button changes speed and does not advance", async ({ page }) => {
  await mockLecture(page, "group-anagrams");
  await page.goto("/problem/group-anagrams");
  await page.getByRole("group", { name: "语速" }).getByRole("button", { name: "2x", exact: true }).click();
  await page.locator("header").getByRole("button", { name: "开始讲课", exact: true }).click();
  await expect(page.getByText("第 1 / 3 步")).toBeVisible();
  await expect(page.getByTestId("continue-hint")).toHaveText("按空格继续");

  const speed = page.getByRole("group", { name: "语速" }).getByRole("button", { name: "1x", exact: true });
  await speed.focus();
  await page.keyboard.press("Space");
  await expect(speed).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("第 1 / 3 步")).toBeVisible();
  await expect(page.getByTestId("continue-hint")).toHaveText("按空格继续");
});

test("after the finished panel shows, Space on 「重播」 replays from step 1", async ({ page }) => {
  await reachLastStep(page);
  await page.keyboard.press("Space");
  await expectFinishedReplay(page);

  const replay = page.getByRole("button", { name: "重播", exact: true });
  await replay.focus();
  await page.keyboard.press("Space");
  await expect(page.getByText("讲完了")).toHaveCount(0);
  await expect(page.getByText("第 1 / 3 步")).toBeVisible();
  await expect(page.getByRole("button", { name: "跳到第 1 步", exact: true })).toHaveAttribute("aria-current", "step");
});

test("after the finished panel shows, Space and ArrowRight leave it in place", async ({ page }) => {
  await reachLastStep(page);
  await page.keyboard.press("Space");
  await expectFinishedReplay(page);
  // 面板刚出现时焦点在「重播」上，那里的 Space 会重播。空键断言先把焦点移开。
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });

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

test("autoplay stays on after reload and problem switch, and off after toggling", async ({ page }) => {
  await mockLecture(page, "group-anagrams");
  await page.goto("/problem/group-anagrams");
  await page.getByRole("group", { name: "语速" }).getByRole("button", { name: "2x", exact: true }).click();

  const autoPlayBtn = page.getByRole("button", { name: "自动播放", exact: true });
  await expect(autoPlayBtn).toHaveAttribute("aria-pressed", "false");
  await autoPlayBtn.click();
  await expect(autoPlayBtn).toHaveAttribute("aria-pressed", "true");

  await page.reload();
  const reloaded = page.getByRole("button", { name: "自动播放", exact: true });
  await expect(reloaded).toHaveAttribute("aria-pressed", "true");
  await page.locator("header").getByRole("button", { name: "开始讲课", exact: true }).click();
  await expect(page.getByText("第 3 / 3 步")).toBeVisible();
  await expect(page.getByText("讲完了")).toBeVisible();
  await expect(page.getByTestId("continue-hint")).toHaveCount(0);

  await page.getByRole("link", { name: "下一题", exact: true }).click();
  await expect(page).toHaveURL(/\/problem\/longest-consecutive-sequence$/);
  const switched = page.getByRole("button", { name: "自动播放", exact: true });
  await expect(switched).toHaveAttribute("aria-pressed", "true");
  await page.locator("header").getByRole("button", { name: "开始讲课", exact: true }).click();
  await expect(page.getByText("第 3 / 3 步")).toBeVisible();
  await expect(page.getByText("讲完了")).toBeVisible();
  await expect(page.getByTestId("continue-hint")).toHaveCount(0);

  await page.reload();
  const stillOn = page.getByRole("button", { name: "自动播放", exact: true });
  await expect(stillOn).toHaveAttribute("aria-pressed", "true");
  await stillOn.click();
  await expect(stillOn).toHaveAttribute("aria-pressed", "false");

  await page.reload();
  const turnedOff = page.getByRole("button", { name: "自动播放", exact: true });
  await expect(turnedOff).toHaveAttribute("aria-pressed", "false");
  await page.locator("header").getByRole("button", { name: "开始讲课", exact: true }).click();
  await expect(page.getByText("第 1 / 3 步")).toBeVisible();
  await expect(page.getByTestId("continue-hint")).toHaveText("按空格继续");
  await expect(page.getByText("讲完了")).toHaveCount(0);
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

async function expectTouchHitArea(page: Page, name: string, min = 44) {
  const bar = page.getByTestId("player-controls");
  const scoped = name === "重播" ? page : bar;
  const button = scoped.getByRole("button", { name, exact: true });
  await expect(button).toBeVisible();
  const box = await button.boundingBox();
  expect(box, name).toBeTruthy();
  expect(box!.width, name).toBeGreaterThanOrEqual(min);
  expect(box!.height, name).toBeGreaterThanOrEqual(min);
  return box!;
}

function touchHitTests(viewport: { width: number; height: number }) {
  test(`coarse pointer ${viewport.width}x${viewport.height} hit areas are at least 44px and timeline dots do not overlap`, async ({ page }) => {
    await mockLecture(page, "group-anagrams");
    await page.goto("/problem/group-anagrams");
    await page.getByRole("group", { name: "语速" }).getByRole("button", { name: "2x", exact: true }).click();
    await page.locator("header").getByRole("button", { name: "开始讲课", exact: true }).click();
    await expect(page.getByText("第 1 / 3 步")).toBeVisible();

    const prev = await expectTouchHitArea(page, "上一步");
    const play = await expectTouchHitArea(page, "暂停");
    const next = await expectTouchHitArea(page, "下一步");
    expect(next.height).toBeGreaterThanOrEqual(44);
    expect(prev.height).toBeGreaterThanOrEqual(44);
    expect(play.height).toBeGreaterThanOrEqual(44);

    const nextButton = page.getByRole("button", { name: "下一步", exact: true });
    await nextButton.tap();
    await expect(page.getByText("第 2 / 3 步")).toBeVisible();
    await expectTouchHitArea(page, "下一步");

    const dots = [
      page.getByRole("button", { name: "跳到第 1 步", exact: true }),
      page.getByRole("button", { name: "跳到第 2 步", exact: true }),
      page.getByRole("button", { name: "跳到第 3 步", exact: true }),
    ];
    const boxes = [];
    for (const dot of dots) {
      const box = await dot.boundingBox();
      expect(box).toBeTruthy();
      expect(box!.height).toBeGreaterThanOrEqual(44);
      const visual = await dot.locator("span").boundingBox();
      expect(visual).toBeTruthy();
      expect(visual!.height).toBeLessThanOrEqual(20);
      const visualCenter = visual!.x + visual!.width / 2;
      expect(visualCenter).toBeGreaterThanOrEqual(box!.x);
      expect(visualCenter).toBeLessThanOrEqual(box!.x + box!.width);
      boxes.push(box!);
    }
    const sorted = [...boxes].sort((a, b) => a.x - b.x);
    for (let i = 1; i < sorted.length; i++) {
      const prevBox = sorted[i - 1]!;
      const nextBox = sorted[i]!;
      expect(prevBox.x + prevBox.width).toBeLessThanOrEqual(nextBox.x + 0.5);
      expect(nextBox.x - (prevBox.x + prevBox.width)).toBeLessThanOrEqual(1);
    }

    await nextButton.tap();
    await expect(page.getByText("第 3 / 3 步")).toBeVisible();
    await nextButton.tap();
    await expect(page.getByText("讲完了")).toBeVisible();
    await expectTouchHitArea(page, "重播");
    await expectTouchHitArea(page, "播放");
  });
}

async function finishAndExpectReplayFocused(page: Page) {
  await mockLecture(page, "group-anagrams");
  await page.goto("/problem/group-anagrams");
  await page.getByRole("group", { name: "语速" }).getByRole("button", { name: "2x", exact: true }).click();
  await page.getByRole("button", { name: "自动播放", exact: true }).click();
  await page.locator("header").getByRole("button", { name: "开始讲课", exact: true }).click();
  await expect(page.getByText("讲完了")).toBeVisible();
  await expect(page.getByRole("button", { name: "重播", exact: true })).toBeFocused();
}

test("desktop 1280 moves focus to 「重播」 when the finished panel appears", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await finishAndExpectReplayFocused(page);
});

test.describe("coarse pointer focus 390", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
  test("moves focus to 「重播」 when the finished panel appears", async ({ page }) => {
    await finishAndExpectReplayFocused(page);
  });
});

test.describe("coarse pointer focus 1024", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 1024, height: 768 } });
  test("moves focus to 「重播」 when the finished panel appears", async ({ page }) => {
    await finishAndExpectReplayFocused(page);
  });
});

test.describe("coarse pointer 1024 hint", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 1024, height: 768 } });

  test("「点「下一步」继续」 sits in the bottom control bar once and stays in view", async ({ page }) => {
    await mockLecture(page, "group-anagrams");
    await page.goto("/problem/group-anagrams");
    await page.getByRole("group", { name: "语速" }).getByRole("button", { name: "2x", exact: true }).click();
    await page.locator("header").getByRole("button", { name: "开始讲课", exact: true }).click();

    const bar = page.getByTestId("player-controls");
    const hint = bar.getByTestId("continue-hint");
    await expect(hint).toHaveText("点「下一步」继续");
    await expect(page.getByText("点「下一步」继续")).toHaveCount(1);
    await expect(page.getByText("按空格继续")).toHaveCount(0);
    await expect(page.locator("[data-testid='continue-hint']")).toHaveCount(1);

    const scrolled = await page.evaluate(() => window.scrollY);
    expect(scrolled).toBe(0);
    const box = await hint.boundingBox();
    expect(box).toBeTruthy();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(1024);
    expect(box!.y + box!.height).toBeLessThanOrEqual(768);
  });
});

test.describe("coarse pointer hit areas 390", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
  touchHitTests({ width: 390, height: 844 });
});

test.describe("coarse pointer hit areas 1024", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 1024, height: 768 } });
  touchHitTests({ width: 1024, height: 768 });
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

