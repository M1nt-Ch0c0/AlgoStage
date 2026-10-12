import { expect, test } from "@playwright/test";

test.beforeEach(async ({ context, baseURL }) => {
  // The real app serves every asset locally; smoke tests must never call AI/CDNs.
  await context.route(/^https?:\/\//, (route) => {
    if (new URL(route.request().url()).origin === baseURL) return route.continue();
    throw new Error(`Unexpected external request: ${new URL(route.request().url()).origin}`);
  });
});

test("home page loads and links to the first lesson", async ({ page }) => {
  const response = await page.goto("/");
  expect(response?.status()).toBe(200);
  await expect(page).toHaveTitle(/AlgoStage/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("老师讲到哪");
  await expect(page.getByRole("link", { name: "听第一堂课：两数之和" })).toHaveAttribute("href", "/problem/two-sum");
});

test("a problem renders its statement, reference code and editor", async ({ page }) => {
  await page.goto("/problem/two-sum");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("两数之和");
  await expect(page.locator('[data-statement="intro"]')).toContainText("给定一个整数数组");
  await expect(page.locator(".monaco-editor")).toBeVisible();
  await expect(page.locator(".monaco-editor .view-lines")).toContainText("function twoSum");
  await expect(page.getByRole("button", { name: "开始讲课", exact: true })).toBeEnabled();
});

test("Demo plays the built-in lesson and disables model requests", async ({ page, request }) => {
  const modelRequests: string[] = [];
  page.on("request", (request) => {
    if (/\/api\/(lecture|hint)$/.test(new URL(request.url()).pathname)) modelRequests.push(request.url());
  });
  await page.goto("/problem/two-sum");
  await expect(page.getByText("这是在线体验版", { exact: false })).toBeVisible();
  await expect(page.locator(".monaco-editor .view-lines")).toContainText("function twoSum");
  const progress = page.waitForResponse((response) => response.url().endsWith("/api/progress") && response.request().method() === "POST");
  await page.getByRole("button", { name: "开始讲课", exact: true }).click();
  expect((await progress).ok()).toBe(true);
  await page.locator("header").getByRole("button", { name: "暂停", exact: true }).click();
  await expect(page.getByRole("button", { name: "播放", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "跳到第 3 步", exact: true }).click();
  await expect(page.getByRole("button", { name: "跳到第 3 步", exact: true })).toHaveAttribute("aria-current", "step");
  await expect(page.locator(".monaco-editor .beam-line").first()).toBeVisible();
  expect(modelRequests).toEqual([]);

  await page.goto("/problem/3sum");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("三数之和");
  await expect(page.getByRole("button", { name: "开始讲课", exact: true })).toBeDisabled();
  for (const endpoint of ["lecture", "hint"]) {
    const response = await request.post(`/api/${endpoint}`, { data: { slug: "3sum", level: 1 } });
    expect(response.status()).toBe(403);
    expect(await response.json()).toMatchObject({ error: "DEMO" });
  }
});
