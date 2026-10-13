import { expect, test } from "@playwright/test";

test.beforeEach(async ({ context, baseURL }) => {
  // The real app serves every asset locally; smoke tests must never call AI/CDNs.
  await context.route(/^https?:\/\//, (route) => {
    if (new URL(route.request().url()).origin === baseURL) return route.continue();
    throw new Error(`Unexpected external request: ${new URL(route.request().url()).origin}`);
  });
});

test.fixme("narration end pauses and shows 「按空格继续」 and Space advances", async ({ page }) => {
  await page.goto("/problem/two-sum");
  await page.getByRole("button", { name: "开始讲课", exact: true }).click();
  await expect(page.getByText("按空格继续")).toBeVisible();
  await page.keyboard.press("Space");
  await expect(page.getByRole("button", { name: "跳到第 2 步", exact: true })).toHaveAttribute("aria-current", "step");
});

test.fixme("last step shows 「讲完了」 and 「重播」", async ({ page }) => {
  await page.goto("/problem/two-sum");
  await page.getByRole("button", { name: "开始讲课", exact: true }).click();
  await expect(page.getByText("讲完了")).toBeVisible();
  await expect(page.getByRole("button", { name: "重播" })).toBeVisible();
});

test.fixme("toggle 「自动播放」 on auto-advances without hint", async ({ page }) => {
  await page.goto("/problem/two-sum");
  await page.getByRole("button", { name: "自动播放" }).click();
  await page.getByRole("button", { name: "开始讲课", exact: true }).click();
  await expect(page.getByText("按空格继续")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "跳到第 2 步", exact: true })).toHaveAttribute("aria-current", "step");
});

test.fixme("after finish primary button shows 「下一题」", async ({ page }) => {
  await page.goto("/problem/two-sum");
  await page.getByRole("button", { name: "开始讲课", exact: true }).click();
  await expect(page.getByRole("button", { name: /下一题/ })).toBeVisible();
});

test.fixme("on last roadmap problem primary button becomes 「回路线图」", async ({ page }) => {
  await page.goto("/problem/two-sum");
  await expect(page.getByRole("button", { name: "回路线图" })).toBeVisible();
});

test.fixme("「重新生成」 in more menu shows confirm dialog first", async ({ page }) => {
  await page.goto("/problem/two-sum");
  await page.getByRole("button", { name: "重新生成" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
});
