import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { expect, test, type Page } from "@playwright/test";

const step = (id: string, narration: string) => ({
  id,
  narration,
  targets: [{ kind: "code-line", start: 1, end: 2 }],
  effects: [],
  dwellMs: 100,
});

function lectureSteps(count: number) {
  return Array.from({ length: count }, (_, index) => step(`s${index + 1}`, `第${index + 1}步`));
}

/**
 * 只写出前 count 步，连接保持打开，播放器停在「下一步准备中…」。
 * route.fulfill 会等整个 body，所以改把请求续到本机的分块响应。
 */
async function mockPartialLecture(page: Page, problemSlug: string, count: number) {
  const steps = lectureSteps(count);
  const payload = [
    JSON.stringify({ type: "progress", attempt: 1, message: `${problemSlug} 备课中` }),
    ...steps.map((item) => JSON.stringify({ type: "step", step: item })),
    "",
  ].join("\n");
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

async function mockLecture(page: Page, problemSlug: string, count = 3) {
  let posts = 0;
  await page.route("**/api/lecture", async (route) => {
    posts++;
    const body = route.request().postDataJSON() as { solutionLanguage?: string };
    const solutionLanguage = body.solutionLanguage ?? "typescript";
    const steps = lectureSteps(count);
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
  // 备课中的用例把 /api/lecture 续到 127.0.0.1 的分块响应，这个端口也放行。
  await context.route(/^https?:\/\//, (route) => {
    const url = new URL(route.request().url());
    const partialLecture = url.hostname === "127.0.0.1" && url.pathname === "/api/lecture";
    if (url.origin === baseURL || partialLecture) return route.continue();
    throw new Error(`Unexpected external request: ${url.origin}`);
  });
});

test("narration end pauses and shows 「按空格继续」 and Space advances", async ({ page }) => {
  await mockLecture(page, "group-anagrams");
  await page.goto("/problem/group-anagrams");
  await page.getByRole("group", { name: "语速" }).getByRole("button", { name: "2×", exact: true }).click();
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
  await page.getByRole("group", { name: "语速" }).getByRole("button", { name: "2×", exact: true }).click();
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
  await page.getByRole("group", { name: "语速" }).getByRole("button", { name: "2×", exact: true }).click();
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
  await page.getByRole("group", { name: "语速" }).getByRole("button", { name: "2×", exact: true }).click();
  await page.locator("header").getByRole("button", { name: "开始讲课", exact: true }).click();
  await expect(page.getByText("第 1 / 3 步")).toBeVisible();
  await expect(page.getByTestId("continue-hint")).toHaveText("按空格继续");

  const speed = page.getByRole("group", { name: "语速" }).getByRole("button", { name: "1×", exact: true });
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
  await page.getByRole("group", { name: "语速" }).getByRole("button", { name: "2×", exact: true }).click();

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
  await page.getByRole("group", { name: "语速" }).getByRole("button", { name: "2×", exact: true }).click();

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
  await page.getByRole("group", { name: "语速" }).getByRole("button", { name: "2×", exact: true }).click();
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
  await page.getByRole("group", { name: "语速" }).getByRole("button", { name: "2×", exact: true }).click();
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
    await page.getByRole("group", { name: "语速" }).getByRole("button", { name: "2×", exact: true }).click();
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
    await page.getByRole("group", { name: "语速" }).getByRole("button", { name: "2×", exact: true }).click();
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
    await page.getByRole("group", { name: "语速" }).getByRole("button", { name: "2×", exact: true }).click();
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
    // 窄屏上「点「下一步」继续」会把时间线挤到下一行。DOM.getBoxModel 会停在换行前的按钮盒，
    // 色条却已经到新位置，于是色条中心落在按钮盒外面。等布局稳定后用同一帧的布局盒来量。
    await expect(page.getByTestId("continue-hint")).toHaveText("点「下一步」继续");
    await expectTouchHitArea(page, "下一步");

    const dots = [
      page.getByRole("button", { name: "跳到第 1 步", exact: true }),
      page.getByRole("button", { name: "跳到第 2 步", exact: true }),
      page.getByRole("button", { name: "跳到第 3 步", exact: true }),
    ];
    const boxes = [];
    for (const dot of dots) {
      const visual = dot.locator("[data-dot-visual]");
      await expect(visual).toHaveCount(1);
      const read = () =>
        Promise.all([
          dot.evaluate((el) => {
            const rect = el.getBoundingClientRect();
            return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
          }),
          visual.evaluate((el) => {
            const rect = el.getBoundingClientRect();
            return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
          }),
        ]);
      let box!: { x: number; y: number; width: number; height: number };
      let bar!: { x: number; y: number; width: number; height: number };
      await expect(async () => {
        [box, bar] = await read();
        expect(box.height).toBeGreaterThanOrEqual(44);
        expect(bar.height).toBeLessThanOrEqual(20);
        const visualCenter = bar.x + bar.width / 2;
        expect(visualCenter).toBeGreaterThanOrEqual(box.x);
        expect(visualCenter).toBeLessThanOrEqual(box.x + box.width);
      }).toPass();
      boxes.push(box);
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
  await page.getByRole("group", { name: "语速" }).getByRole("button", { name: "2×", exact: true }).click();
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
    await page.getByRole("group", { name: "语速" }).getByRole("button", { name: "2×", exact: true }).click();
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

type LayoutBox = { x: number; y: number; width: number; height: number };

/** 等窄屏换行落定后读布局盒。DOM.getBoxModel 会停在换行前的按钮，色条已经换行。 */
async function readSettledDot(dot: ReturnType<Page["getByRole"]>) {
  const visual = dot.locator("[data-dot-visual]");
  await expect(visual).toHaveCount(1);
  const read = () =>
    Promise.all([
      dot.evaluate((el) => {
        const rect = el.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      }),
      visual.evaluate((el) => {
        const rect = el.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      }),
    ]);
  let box!: LayoutBox;
  let bar!: LayoutBox;
  await expect(async () => {
    [box, bar] = await read();
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(bar.height).toBeLessThanOrEqual(20);
    const visualCenter = bar.x + bar.width / 2;
    expect(visualCenter).toBeGreaterThanOrEqual(box.x);
    expect(visualCenter).toBeLessThanOrEqual(box.x + box.width);
  }).toPass();
  return { box, bar };
}

/** 时间线轨道：圆点按钮的父级。占位条若存在也在这一层，不另算进圆点等分。 */
function timelineTrack(page: Page) {
  return page.locator("[data-testid='player-controls'] [data-dot-visual]").first().locator("xpath=..").locator("xpath=..");
}

test.describe("coarse pointer hit areas 390", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
  touchHitTests({ width: 390, height: 844 });

  test("12 步时间线圆点边对边铺满轨道，点按色条中心跳步，上一步下一步至少 44×44", async ({ page }) => {
    const count = 12;
    await mockLecture(page, "group-anagrams", count);
    await page.goto("/problem/group-anagrams");
    await page.getByRole("group", { name: "语速" }).getByRole("button", { name: "2×", exact: true }).click();
    await page.locator("header").getByRole("button", { name: "开始讲课", exact: true }).click();
    await expect(page.getByText(`第 1 / ${count} 步`)).toBeVisible();
    // 窄屏上「点「下一步」继续」会把时间线挤到下一行，等这一行落定再量。
    await expect(page.getByTestId("continue-hint")).toHaveText("点「下一步」继续");

    const dots = page.getByRole("button", { name: /^跳到第 \d+ 步$/ });
    await expect(dots).toHaveCount(count);
    const track = timelineTrack(page);
    const boxes: LayoutBox[] = [];
    for (let i = 0; i < count; i++) {
      const { box } = await readSettledDot(dots.nth(i));
      boxes.push(box);
    }
    const container = await track.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    });
    const sorted = [...boxes].sort((a, b) => a.x - b.x);
    const first = sorted[0]!;
    const last = sorted[sorted.length - 1]!;
    expect(Math.abs(first.x - container.x)).toBeLessThanOrEqual(1);
    const pending = page.locator("[data-pending-step]");
    if ((await pending.count()) === 0) {
      expect(Math.abs(last.x + last.width - (container.x + container.width))).toBeLessThanOrEqual(1);
    }
    for (const box of sorted) expect(box.height).toBeGreaterThanOrEqual(44);
    for (let i = 1; i < sorted.length; i++) {
      const prevBox = sorted[i - 1]!;
      const nextBox = sorted[i]!;
      expect(nextBox.x).toBeGreaterThanOrEqual(prevBox.x + prevBox.width - 1);
      expect(nextBox.x - (prevBox.x + prevBox.width)).toBeLessThanOrEqual(1);
    }

    const indicator = page.getByText(/第 \d+ \/ 12 步/);
    for (let i = 0; i < count; i++) {
      // 离开第 1 步后「点「下一步」继续」收起，时间线会回到按钮那一行。点偏了就重读色条中心再试。
      await expect(async () => {
        const { bar } = await readSettledDot(dots.nth(i));
        await page.touchscreen.tap(bar.x + bar.width / 2, bar.y + bar.height / 2);
        await expect(indicator).toHaveText(`第 ${i + 1} / ${count} 步`, { timeout: 1_000 });
      }).toPass({ timeout: 10_000 });
    }

    const prev = await expectTouchHitArea(page, "上一步");
    const next = await expectTouchHitArea(page, "下一步");
    expect(prev.width).toBeGreaterThanOrEqual(44);
    expect(next.width).toBeGreaterThanOrEqual(44);
  });

  test("备课中只按真实圆点均分，占位条不计入等分", async ({ page }) => {
    const count = 4;
    const close = await mockPartialLecture(page, "group-anagrams", count);
    try {
      await page.goto("/problem/group-anagrams");
      await page.getByRole("group", { name: "语速" }).getByRole("button", { name: "2×", exact: true }).click();
      await page.locator("header").getByRole("button", { name: "开始讲课", exact: true }).click();
      // 备课中控制栏不显示「第 x / N 步」（v0.2.1），改等 role=status 的「已收到 N 步…」。
      await expect(page.getByRole("status").filter({ hasText: `已收到 ${count} 步，仍在备课…` })).toBeVisible();
      await page.getByRole("button", { name: `跳到第 ${count} 步`, exact: true }).tap();
      await expect(page.getByRole("button", { name: `跳到第 ${count} 步`, exact: true })).toHaveAttribute("aria-current", "step");
      await expect(page.getByText("下一步准备中…")).toBeVisible();

      const dots = page.getByRole("button", { name: /^跳到第 \d+ 步$/ });
      await expect(dots).toHaveCount(count);
      const pending = page.locator("[data-pending-step]");
      // 本分支已实现占位条：必须走占位分支。
      await expect(pending).toHaveCount(1);
      const pendingCount = await pending.count();
      const boxes: LayoutBox[] = [];
      for (let i = 0; i < count; i++) {
        const { box } = await readSettledDot(dots.nth(i));
        boxes.push(box);
      }
      const sorted = [...boxes].sort((a, b) => a.x - b.x);
      const track = timelineTrack(page);
      const container = await track.evaluate((el) => {
        const rect = el.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      });

      expect(Math.abs(sorted[0]!.x - container.x)).toBeLessThanOrEqual(1);
      for (const box of sorted) expect(box.height).toBeGreaterThanOrEqual(44);
      for (let i = 1; i < sorted.length; i++) {
        const prevBox = sorted[i - 1]!;
        const nextBox = sorted[i]!;
        expect(Math.abs(nextBox.width - prevBox.width)).toBeLessThanOrEqual(1);
        expect(nextBox.x).toBeGreaterThanOrEqual(prevBox.x + prevBox.width - 1);
        expect(nextBox.x - (prevBox.x + prevBox.width)).toBeLessThanOrEqual(1);
      }

      const last = sorted[sorted.length - 1]!;
      if (pendingCount === 0) {
        expect(Math.abs(last.x + last.width - (container.x + container.width))).toBeLessThanOrEqual(1);
      } else {
        await expect(pending).toHaveCount(1);
        const placeholder = await pending.evaluate((el) => {
          const rect = el.getBoundingClientRect();
          return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        });
        expect(placeholder.width).toBeLessThanOrEqual(32);
        expect(placeholder.x).toBeGreaterThanOrEqual(last.x + last.width - 1);
        expect(placeholder.x - (last.x + last.width)).toBeLessThanOrEqual(1);
        expect(Math.abs(placeholder.x + placeholder.width - (container.x + container.width))).toBeLessThanOrEqual(1);
      }
    } finally {
      await close();
    }
  });

  test("tap timeline dot at 2× does not advance an extra step with autoplay off", async ({ page }) => {
    // Paige decision, 2× persists across lecture start; tapping must not advance an extra step.
    const count = 12;
    await mockLecture(page, "group-anagrams", count);
    await page.goto("/problem/group-anagrams");
    await page.getByRole("group", { name: "语速" }).getByRole("button", { name: "2×", exact: true }).click();
    await page.locator("header").getByRole("button", { name: "开始讲课", exact: true }).click();
    await expect(page.getByText("第 1 / 12 步")).toBeVisible();

    const track = timelineTrack(page);
    await expect(track).toBeVisible();

    const dots = page.getByRole("button", { name: /^跳到第 \d+ 步$/ });
    await expect(dots).toHaveCount(count);
    const indicator = page.getByText(/第 \d+ \/ 12 步/);

    await expect(async () => {
      const { bar } = await readSettledDot(dots.nth(4));
      await page.touchscreen.tap(bar.x + bar.width / 2, bar.y + bar.height / 2);
      await expect(indicator).toHaveText("第 5 / 12 步", { timeout: 1_000 });
    }).toPass({ timeout: 10_000 });

    await page.waitForTimeout(2500);
    await expect(indicator).toHaveText("第 5 / 12 步");
  });
});

test.describe("coarse pointer hit areas 1024", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 1024, height: 768 } });
  touchHitTests({ width: 1024, height: 768 });
});

// Full regenerate flow (confirming and streaming new lecture while paused) is tested in e2e/regenerate.spec.ts.
test("after finish 「重新生成」 in more menu shows confirm button without firing a second lecture POST", async ({ page }) => {
  const getPosts = await mockLecture(page, "group-anagrams");
  await page.goto("/problem/group-anagrams");
  await page.getByRole("group", { name: "语速" }).getByRole("button", { name: "2×", exact: true }).click();
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

/** 只量热区，不点按，避免自动播放 / 语速 / 特效强度把播放状态改掉。 */
async function checkToggles(page: Page) {
  // components/board/player-controls.tsx: SPEEDS 0.5, 1, 1.5, 2；LEVELS 华丽 / 克制 / 极简。
  const speedLabels = ["0.5×", "1×", "1.5×", "2×"];
  const effectLabels = ["华丽", "克制", "极简"];
  const speedGroup = page.getByRole("group", { name: "语速" });
  const effectGroup = page.getByRole("group", { name: "特效强度" });
  const toggles = [
    page.getByRole("button", { name: "自动播放", exact: true }),
    ...speedLabels.map((name) => speedGroup.getByRole("button", { name, exact: true })),
    ...effectLabels.map((name) => effectGroup.getByRole("button", { name, exact: true })),
  ];

  for (const toggle of toggles) {
    await expect(async () => {
      const label = (await toggle.innerText()).trim();
      await toggle.evaluate((el) => el.setAttribute("data-hit-probe", ""));
      try {
        const rect = await toggle.evaluate((el) => {
          const box = el.getBoundingClientRect();
          const afterHeight = Number.parseFloat(getComputedStyle(el, "::after").height);
          return { x: box.x, y: box.y, width: box.width, height: box.height, afterHeight };
        });
        console.log(
          `[toggle-hit] ${label} width=${rect.width} height=${rect.height} after=${rect.afterHeight}`,
        );
        expect(rect.width).toBeGreaterThanOrEqual(44);
        expect(rect.afterHeight).toBeGreaterThanOrEqual(44);

        const dx = Math.min(18, rect.width / 2 - 1);
        const centerX = rect.x + rect.width / 2;
        const centerY = rect.y + rect.height / 2;
        const offsets: Array<[number, number]> = [
          [0, -18],
          [0, 18],
          [-dx, 0],
          [dx, 0],
        ];
        for (const [ox, oy] of offsets) {
          const x = centerX + ox;
          const y = centerY + oy;
          const hit = await page.evaluate(({ x, y }) => {
            const el = document.elementFromPoint(x, y);
            return el?.closest("button")?.hasAttribute("data-hit-probe") ?? false;
          }, { x, y });
          expect(hit).toBe(true);
        }
      } finally {
        await toggle.evaluate((el) => el.removeAttribute("data-hit-probe"));
      }
    }).toPass();
  }

  await expect(async () => {
    const measured = await page.getByTestId("player-controls").evaluate((el) => {
      const children: Array<{ top: number; bottom: number; centerY: number; label: string | null; text: string }> = [];
      for (const child of el.children) {
        const box = child.getBoundingClientRect();
        if (box.width <= 0 || box.height <= 0) continue;
        children.push({
          top: box.top,
          bottom: box.bottom,
          centerY: box.top + box.height / 2,
          label: child.getAttribute("aria-label"),
          // 自动播放按钮没有 aria-label，可访问名就是正文。
          text: (child.textContent ?? "").trim(),
        });
      }

      // 子项 centreY 落在已有行的 top..bottom 里才并入该行，不再用 top 相差 4px。
      const rows: Array<{ top: number; bottom: number }> = [];
      for (const child of [...children].sort((a, b) => a.centerY - b.centerY)) {
        const row = rows.find((candidate) => child.centerY >= candidate.top && child.centerY <= candidate.bottom);
        if (row) {
          row.top = Math.min(row.top, child.top);
          row.bottom = Math.max(row.bottom, child.bottom);
        } else {
          rows.push({ top: child.top, bottom: child.bottom });
        }
      }

      const centerY = (label: string) => children.find((child) => child.label === label)?.centerY ?? null;
      // 语速 / 特效强度用 aria-label。自动播放与时间线同一行，按钮本身没有 aria-label。
      const toggleChildren = children.filter(
        (child) => child.label === "语速" || child.label === "特效强度" || child.text === "自动播放",
      );
      const toggleRows: Array<{ top: number; bottom: number }> = [];
      for (const child of toggleChildren) {
        const row = rows.find((candidate) => child.centerY >= candidate.top && child.centerY <= candidate.bottom);
        if (row && !toggleRows.includes(row)) toggleRows.push(row);
      }
      toggleRows.sort((a, b) => a.top - b.top);
      const upperToggleRow = toggleRows[0];
      const lowerToggleRow = toggleRows[toggleRows.length - 1];
      const toggleGap =
        upperToggleRow && lowerToggleRow && upperToggleRow !== lowerToggleRow
          ? lowerToggleRow.top - upperToggleRow.bottom
          : null;
      return {
        count: rows.length,
        centres: rows.map((row) => (row.top + row.bottom) / 2),
        speedCenterY: centerY("语速"),
        effectCenterY: centerY("特效强度"),
        toggleRowCount: toggleRows.length,
        toggleGap,
      };
    });
    console.log(
      `[player-controls rows] count=${measured.count} centres=${measured.centres.join(",")} toggleRows=${measured.toggleRowCount} toggleGap=${measured.toggleGap}`,
    );
    expect(measured.count).toBeLessThanOrEqual(4);
    expect(measured.speedCenterY).not.toBeNull();
    expect(measured.effectCenterY).not.toBeNull();
    expect(Math.abs(measured.speedCenterY! - measured.effectCenterY!)).toBeLessThan(4);
  }).toPass();
}

/** 从每个 toggle 中心向四边逐像素探连续自命中，并量相邻行热区是否重叠。 */
async function probeToggleHits(page: Page, tag: string) {
  const measured = await page.evaluate(() => {
    const bar = document.querySelector('[data-testid="player-controls"]');
    if (!(bar instanceof HTMLElement)) throw new Error("player-controls missing");

    const isSelfHit = (button: HTMLButtonElement, hit: Element | null) =>
      hit === button || (hit !== null && button.contains(hit));

    const toggles = [...bar.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")].map((button) => {
      const box = button.getBoundingClientRect();
      const centerX = box.left + box.width / 2;
      const centerY = box.top + box.height / 2;
      const extent = (stepX: number, stepY: number) => {
        let distance = 0;
        for (let step = 1; step <= 80; step += 1) {
          const hit = document.elementFromPoint(centerX + stepX * step, centerY + stepY * step);
          if (!isSelfHit(button, hit)) break;
          distance = step;
        }
        return distance;
      };
      const up = extent(0, -1);
      const down = extent(0, 1);
      const left = extent(-1, 0);
      const right = extent(1, 0);
      return {
        label: (button.textContent ?? "").trim(),
        centerY,
        up,
        down,
        selfHitHeight: up + down + 1,
        selfHitWidth: left + right + 1,
      };
    });

    const rows: Array<typeof toggles> = [];
    for (const toggle of [...toggles].sort((a, b) => a.centerY - b.centerY)) {
      const row = rows.find((candidate) =>
        candidate.some((member) => Math.abs(member.centerY - toggle.centerY) <= 4),
      );
      if (row) row.push(toggle);
      else rows.push([toggle]);
    }

    const overlaps: number[] = [];
    for (let index = 0; index < rows.length - 1; index += 1) {
      const upper = rows[index];
      const lower = rows[index + 1];
      const upperBottomHit = Math.min(...upper.map((toggle) => toggle.centerY + toggle.down));
      const lowerTopHit = Math.max(...lower.map((toggle) => toggle.centerY - toggle.up));
      overlaps.push(upperBottomHit - lowerTopHit);
    }
    const rowOverlapPx = overlaps.length > 0 ? Math.max(...overlaps) : 0;

    return {
      barHeight: bar.getBoundingClientRect().height,
      rows: rows.length,
      rowOverlapPx,
      toggles,
    };
  });

  const summary = measured.toggles.map((toggle) => `${toggle.label}:${toggle.selfHitWidth}x${toggle.selfHitHeight}`).join(" ");
  console.log(
    `[toggle-probe ${tag}] barHeight=${measured.barHeight} rows=${measured.rows} rowOverlapPx=${measured.rowOverlapPx} ${summary}`,
  );

  for (const toggle of measured.toggles) {
    expect(toggle.selfHitHeight).toBeGreaterThanOrEqual(44);
    expect(toggle.selfHitWidth).toBeGreaterThanOrEqual(44);
  }
  expect(measured.rowOverlapPx).toBeLessThanOrEqual(0);
}

test.describe("coarse pointer toggle hit areas 390", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

  test("toggles keep own 44x44 hit area and speed and effect groups share a row while playing", async ({ page }) => {
    await mockLecture(page, "group-anagrams");
    await page.goto("/problem/group-anagrams");
    await page.locator("header").getByRole("button", { name: "开始讲课", exact: true }).click();
    await expect(page.getByText("第 1 / 3 步")).toBeVisible();
    await checkToggles(page);
    await probeToggleHits(page, "844-playing");
  });

  test("same while preparing", async ({ page }) => {
    const cleanup = await mockPartialLecture(page, "group-anagrams", 2);
    try {
      await page.goto("/problem/group-anagrams");
      await page.locator("header").getByRole("button", { name: "开始讲课", exact: true }).click();
      // 「备课中…」只在第一步到达前显示；已收到 2 步时是仍在备课状态，不要退回步数计数。
      await expect(page.getByRole("status").filter({ hasText: "已收到 2 步，仍在备课…" })).toBeVisible();
      await checkToggles(page);
      await probeToggleHits(page, "844-preparing");
    } finally {
      await cleanup();
    }
  });
});

test.describe("coarse pointer toggle hit areas 390x667", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 667 } });

  test("toggles keep own 44x44 hit area and speed and effect groups share a row while playing", async ({ page }) => {
    await mockLecture(page, "group-anagrams");
    await page.goto("/problem/group-anagrams");
    await page.locator("header").getByRole("button", { name: "开始讲课", exact: true }).click();
    await expect(page.getByText("第 1 / 3 步")).toBeVisible();
    await checkToggles(page);
    await probeToggleHits(page, "667-playing");
  });

  test("same while preparing", async ({ page }) => {
    const cleanup = await mockPartialLecture(page, "group-anagrams", 2);
    try {
      await page.goto("/problem/group-anagrams");
      await page.locator("header").getByRole("button", { name: "开始讲课", exact: true }).click();
      // 「备课中…」只在第一步到达前显示；已收到 2 步时是仍在备课状态，不要退回步数计数。
      await expect(page.getByRole("status").filter({ hasText: "已收到 2 步，仍在备课…" })).toBeVisible();
      await checkToggles(page);
      await probeToggleHits(page, "667-preparing");
    } finally {
      await cleanup();
    }
  });
});

