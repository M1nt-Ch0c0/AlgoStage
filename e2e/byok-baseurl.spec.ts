import { expect, test } from "@playwright/test";

test.beforeEach(async ({ context, baseURL }) => {
  // The real app serves every asset locally; tests must never call AI/CDNs.
  await context.route(/^https?:\/\//, (route) => {
    if (new URL(route.request().url()).origin === baseURL) return route.continue();
    throw new Error(`Unexpected external request: ${new URL(route.request().url()).origin}`);
  });
});

test("settings baseURL validation: typing, blur error, edit clears, empty ok, no goto-settings link, save shows 已保存", async ({ page }) => {
  await page.goto("/settings");
  const baseURLInput = page.locator("#baseURL");
  const apiKeyInput = page.locator("#apiKey");
  const errorText = "接口地址格式不对，要以 http:// 或 https:// 开头";
  const gotoSettingsLink = page.getByRole("link", { name: "去设置" });

  await expect(baseURLInput).toBeVisible();

  // Type "ftp://x" -> no error while typing
  await baseURLInput.fill("ftp://x");
  await expect(page.getByText(errorText)).toHaveCount(0);
  await expect(gotoSettingsLink).toHaveCount(0);

  // Blur -> inline error visible, input focused, no 去设置 link
  await baseURLInput.blur();
  await expect(page.getByText(errorText)).toBeVisible();
  await expect(baseURLInput).toBeFocused();
  await expect(gotoSettingsLink).toHaveCount(0);

  // Edit -> error gone
  await baseURLInput.fill("ftp://xy");
  await expect(page.getByText(errorText)).toHaveCount(0);
  await expect(gotoSettingsLink).toHaveCount(0);

  // Empty -> no error on typing or blur
  await baseURLInput.fill("");
  await expect(page.getByText(errorText)).toHaveCount(0);
  await baseURLInput.blur();
  await expect(page.getByText(errorText)).toHaveCount(0);
  await expect(gotoSettingsLink).toHaveCount(0);

  // Save succeeds without external calls -> shows 「已保存」 and never 「验证通过」
  await apiKeyInput.fill("sk-e2e-dummy-key-0000");
  await page.getByRole("button", { name: "保存设置" }).click();
  await expect(page.getByRole("button", { name: "已保存" })).toBeVisible();
  await expect(page.getByText("验证通过")).toHaveCount(0);
  await expect(gotoSettingsLink).toHaveCount(0);
});

test("settings focus query params: focus=baseUrl and focus=apiKey focus, highlight, and scroll into viewport", async ({ page }) => {
  await page.goto("/settings?focus=baseUrl");
  const baseURLInput = page.locator("#baseURL");
  await expect(baseURLInput).toBeFocused();
  await expect(baseURLInput).toHaveAttribute("data-highlight", "true");
  await expect(baseURLInput).toBeInViewport();
  await expect(page.getByRole("link", { name: "去设置" })).toHaveCount(0);

  await page.goto("/settings?focus=apiKey");
  const apiKeyInput = page.locator("#apiKey");
  await expect(apiKeyInput).toBeFocused();
  await expect(apiKeyInput).toHaveAttribute("data-highlight", "true");
  await expect(apiKeyInput).toBeInViewport();
  await expect(page.getByRole("link", { name: "去设置" })).toHaveCount(0);
});

test("lecture and hint with private baseURL hit real server 400 BASE_URL_NOT_ALLOWED and navigate to /settings?focus=baseUrl", async ({ page }) => {
  const privateByok = {
    apiKey: "sk-e2e-dummy-key-0000",
    baseURL: "http://192.168.1.2/v1",
  };

  // Confirm real server returns 400 BASE_URL_NOT_ALLOWED on /api/hint and /api/lecture
  const hintRes = await page.request.post("/api/hint", {
    data: { slug: "3sum", level: 1, byok: privateByok },
  });
  expect(hintRes.status()).toBe(400);
  expect(await hintRes.json()).toMatchObject({
    code: "BASE_URL_NOT_ALLOWED",
    error: "BASE_URL_NOT_ALLOWED",
  });

  const lectureRes = await page.request.post("/api/lecture", {
    data: { slug: "3sum", solutionLanguage: "typescript", byok: privateByok },
  });
  expect(lectureRes.status()).toBe(400);
  expect(await lectureRes.json()).toMatchObject({
    code: "BASE_URL_NOT_ALLOWED",
    error: "BASE_URL_NOT_ALLOWED",
  });

  // Set localStorage "algostage.byok" and trigger lecture flow on /problem/3sum
  await page.goto("/problem/3sum");
  await page.evaluate((byok) => {
    window.localStorage.setItem("algostage.byok", JSON.stringify(byok));
  }, privateByok);

  await expect(page.getByRole("heading", { level: 1 })).toContainText("三数之和");
  await page.getByRole("button", { name: "开始讲课", exact: true }).click();

  const expectedError = "接口地址只支持公网 http(s) 地址，去设置页改一下就能开讲。";
  await expect(page.getByText(expectedError)).toBeVisible();
  const gotoSettings = page.getByTestId("goto-settings");
  await expect(gotoSettings).toBeVisible();
  await expect(gotoSettings).toHaveAttribute("href", "/settings?focus=baseUrl");

  await gotoSettings.click();
  await expect(page).toHaveURL(/\/settings\?focus=baseUrl$/);
  const baseURLInput = page.locator("#baseURL");
  await expect(baseURLInput).toBeFocused();
  await expect(baseURLInput).toHaveAttribute("data-highlight", "true");
  await expect(baseURLInput).toBeInViewport();
  await expect(page.getByRole("link", { name: "去设置" })).toHaveCount(0);
});

test("lecture and hint with malformed baseURL hit real server 400 BASE_URL_INVALID and navigate to /settings?focus=baseUrl", async ({ page }) => {
  const malformedCandidates = ["htp:/bad", "not a url", "ftp://x.com/v1"];
  const expectedError = "接口地址格式不对，要以 http:// 或 https:// 开头，去设置页改一下就能开讲。";

  for (const candidate of malformedCandidates) {
    const byok = {
      apiKey: "sk-e2e-dummy-key-0000",
      baseURL: candidate,
    };

    const hintRes = await page.request.post("/api/hint", {
      data: { slug: "3sum", level: 1, byok },
    });
    expect(hintRes.status()).toBe(400);
    expect(await hintRes.json()).toMatchObject({
      code: "BASE_URL_INVALID",
      error: "BASE_URL_INVALID",
    });

    const lectureRes = await page.request.post("/api/lecture", {
      data: { slug: "3sum", solutionLanguage: "typescript", byok },
    });
    expect(lectureRes.status()).toBe(400);
    expect(await lectureRes.json()).toMatchObject({
      code: "BASE_URL_INVALID",
      error: "BASE_URL_INVALID",
    });
  }

  const malformedByok = {
    apiKey: "sk-e2e-dummy-key-0000",
    baseURL: "htp:/bad",
  };

  // Lecture flow on /problem/3sum
  await page.goto("/problem/3sum");
  await page.evaluate((byok) => {
    window.localStorage.setItem("algostage.byok", JSON.stringify(byok));
  }, malformedByok);

  await expect(page.getByRole("heading", { level: 1 })).toContainText("三数之和");
  await page.getByRole("button", { name: "开始讲课", exact: true }).click();

  await expect(page.getByText(expectedError)).toBeVisible();
  await expect(page.getByText("AI 服务暂时连不上")).toHaveCount(0);
  const lectureGotoSettings = page.getByTestId("goto-settings");
  await expect(lectureGotoSettings).toBeVisible();
  await expect(lectureGotoSettings).toHaveAttribute("href", "/settings?focus=baseUrl");

  await lectureGotoSettings.click();
  await expect(page).toHaveURL(/\/settings\?focus=baseUrl/);
  const baseURLInput = page.locator("#baseURL");
  await expect(baseURLInput).toBeFocused();
  await expect(baseURLInput).toHaveAttribute("data-highlight", "true");
  await expect(page.getByText("AI 服务暂时连不上")).toHaveCount(0);

  // Hint flow on /problem/3sum
  await page.goto("/problem/3sum");
  await page.evaluate((byok) => {
    window.localStorage.setItem("algostage.byok", JSON.stringify(byok));
  }, malformedByok);

  await expect(page.getByRole("heading", { level: 1 })).toContainText("三数之和");
  await page.getByRole("button", { name: /L1\s*观察/ }).click();

  await expect(page.getByText(expectedError)).toBeVisible();
  await expect(page.getByText("AI 服务暂时连不上")).toHaveCount(0);
  const hintGotoSettings = page.getByTestId("goto-settings");
  await expect(hintGotoSettings).toBeVisible();
  await expect(hintGotoSettings).toHaveAttribute("href", "/settings?focus=baseUrl");

  await hintGotoSettings.click();
  await expect(page).toHaveURL(/\/settings\?focus=baseUrl/);
  await expect(baseURLInput).toBeFocused();
  await expect(baseURLInput).toHaveAttribute("data-highlight", "true");
  await expect(page.getByText("AI 服务暂时连不上")).toHaveCount(0);
});

test("at 390x844 viewport, BASE_URL_INVALID error-action buttons/links in lecture and hint have height >= 44 and do not wrap text", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });

  const malformedByok = {
    apiKey: "sk-e2e-dummy-key-0000",
    baseURL: "htp:/bad",
  };
  const expectedError = "接口地址格式不对，要以 http:// 或 https:// 开头，去设置页改一下就能开讲。";

  await page.goto("/problem/3sum");
  await page.evaluate((byok) => {
    window.localStorage.setItem("algostage.byok", JSON.stringify(byok));
  }, malformedByok);

  await expect(page.getByRole("heading", { level: 1 })).toContainText("三数之和");
  await page.getByRole("button", { name: "开始讲课", exact: true }).click();

  const lectureAlert = page.getByRole("alert").first();
  await expect(lectureAlert).toContainText(expectedError);

  // Config-class errors show ONLY 「去设置」 and NO 「重试」/「重试讲课」
  await expect(lectureAlert.getByRole("button", { name: "重试讲课", exact: true })).toHaveCount(0);
  await expect(lectureAlert.getByRole("button", { name: "重试", exact: true })).toHaveCount(0);
  const lectureGotoSettings = lectureAlert.getByTestId("goto-settings");
  await expect(lectureGotoSettings).toBeVisible();

  const lectureGotoBox = await lectureGotoSettings.boundingBox();
  expect(lectureGotoBox).not.toBeNull();
  expect(lectureGotoBox!.height).toBeGreaterThanOrEqual(44);

  const lectureTextMetrics = await lectureGotoSettings.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    return {
      textHeight: range.getBoundingClientRect().height,
      lineHeight: parseFloat(window.getComputedStyle(el).lineHeight),
    };
  });
  expect(lectureTextMetrics.textHeight).toBeLessThan(2 * lectureTextMetrics.lineHeight);

  // Trigger hint error as well to verify hint state: NO 重试 button, 去设置 present
  await page.getByRole("button", { name: /L1\s*观察/ }).click();
  const hintAlert = page.getByRole("alert").nth(1);
  await expect(hintAlert).toContainText(expectedError);

  await expect(hintAlert.getByRole("button", { name: "重试", exact: true })).toHaveCount(0);
  const hintGotoSettings = hintAlert.getByTestId("goto-settings");
  await expect(hintGotoSettings).toBeVisible();

  const hintGotoBox = await hintGotoSettings.boundingBox();
  expect(hintGotoBox).not.toBeNull();
  expect(hintGotoBox!.height).toBeGreaterThanOrEqual(44);

  // UPSTREAM_ERROR hint error from real server (AI_BASE_URL http://127.0.0.1:1/no-model has zero egress and returns 502 UPSTREAM_ERROR)
  const upstreamCheck = await page.request.post("/api/hint", {
    data: { slug: "3sum", level: 1, byok: { apiKey: "sk-e2e-dummy-key-0000" } },
  });
  expect(upstreamCheck.status()).toBe(502);
  expect(await upstreamCheck.json()).toMatchObject({
    code: "UPSTREAM_ERROR",
    error: "UPSTREAM_ERROR",
  });

  // Now reload with byok containing only apiKey (falling back to server's private AI_BASE_URL for 502 UPSTREAM_ERROR)
  await page.goto("/problem/3sum");
  await page.evaluate(() => {
    window.localStorage.setItem("algostage.byok", JSON.stringify({ apiKey: "sk-e2e-dummy-key-0000" }));
  });
  await expect(page.getByRole("heading", { level: 1 })).toContainText("三数之和");
  await page.getByRole("button", { name: /L1\s*观察/ }).click();

  const upstreamHintAlert = page.getByRole("alert").first();
  await expect(upstreamHintAlert).toContainText("AI 服务暂时连不上，请稍后再试。");
  await expect(upstreamHintAlert.getByTestId("goto-settings")).toHaveCount(0);
  await expect(upstreamHintAlert.getByRole("link", { name: "去设置" })).toHaveCount(0);

  const hintRetryBtn = upstreamHintAlert.getByRole("button", { name: "重试", exact: true });
  await expect(hintRetryBtn).toBeVisible();

  const hintRetryBox = await hintRetryBtn.boundingBox();
  expect(hintRetryBox).not.toBeNull();
  expect(hintRetryBox!.width).toBeGreaterThanOrEqual(44);
  expect(hintRetryBox!.height).toBeGreaterThanOrEqual(44);

  const retryTextMetrics = await hintRetryBtn.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    return {
      textHeight: range.getBoundingClientRect().height,
      lineHeight: parseFloat(window.getComputedStyle(el).lineHeight),
    };
  });
  expect(retryTextMetrics.textHeight).toBeLessThan(2 * retryTextMetrics.lineHeight);
});


