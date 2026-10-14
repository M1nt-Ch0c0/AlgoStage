import { expect, type Page, test } from "@playwright/test";

const defaultBaseURL = `http://127.0.0.1:${process.env.E2E_PORT || "4173"}`;
const lockedBaseURL = `http://127.0.0.1:${process.env.E2E_BYOK_PORT || "4174"}`;

const modes = [
  { name: "default", baseURL: defaultBaseURL, locked: false },
  { name: "locked", baseURL: lockedBaseURL, locked: true },
] as const;

test.beforeEach(async ({ context }) => {
  await context.route(/^https?:\/\//, (route) => {
    const origin = new URL(route.request().url()).origin;
    if (origin === new URL(defaultBaseURL).origin || origin === new URL(lockedBaseURL).origin) {
      return route.continue();
    }
    throw new Error(`Unexpected external request: ${origin}`);
  });
});

async function gotoSettings(page: Page, baseURL: string, locked: boolean) {
  await page.goto(`${baseURL}/settings`);
  if (locked) {
    await expect(page.getByText("API Key 只保存在你这台浏览器里，不会存到服务器。")).toBeVisible();
  } else {
    await expect(page.getByText("API Key 来源：")).toBeVisible();
  }
}

for (const mode of modes) {
  test.describe(`${mode.name} mode`, () => {
    test("(a) choose 1.5× and 克制 on /settings, save, reload, and verify in player", async ({ page }) => {
      await gotoSettings(page, mode.baseURL, mode.locked);

      const speedGroup = page.getByRole("group", { name: "讲课语速" });
      const effectGroup = page.getByRole("group", { name: "特效强度" });

      await speedGroup.getByRole("button", { name: "1.5×" }).click();
      await expect(speedGroup.getByRole("button", { name: "1.5×" })).toHaveAttribute("aria-pressed", "true");

      await effectGroup.getByRole("button", { name: "克制" }).click();
      await expect(effectGroup.getByRole("button", { name: "克制" })).toHaveAttribute("aria-pressed", "true");

      await page.getByRole("button", { name: "保存设置" }).click();
      await expect(page.getByRole("button", { name: "已保存" })).toBeVisible();

      await page.reload();

      await expect(page.getByRole("group", { name: "讲课语速" }).getByRole("button", { name: "1.5×" })).toHaveAttribute(
        "aria-pressed",
        "true"
      );
      await expect(page.getByRole("group", { name: "特效强度" }).getByRole("button", { name: "克制" })).toHaveAttribute(
        "aria-pressed",
        "true"
      );

      // Go to a lecture page
      await page.goto(`${mode.baseURL}/problem/two-sum`);
      const playerControls = page.getByTestId("player-controls");
      await expect(playerControls).toBeVisible();

      const playerSpeed = playerControls.getByRole("group", { name: "语速" }).getByRole("button", { name: "1.5×" });
      await expect(playerSpeed).toHaveAttribute("aria-pressed", "true");

      const playerEffect = playerControls.getByRole("group", { name: "特效强度" }).getByRole("button", { name: "克制" });
      await expect(playerEffect).toHaveAttribute("aria-pressed", "true");
    });

    test("(b) change speed in the player, then open /settings, same value pressed", async ({ page }) => {
      await page.goto(`${mode.baseURL}/problem/two-sum`);
      const playerControls = page.getByTestId("player-controls");
      await expect(playerControls).toBeVisible();

      const playerSpeedGroup = playerControls.getByRole("group", { name: "语速" });
      await playerSpeedGroup.getByRole("button", { name: "2×" }).click();
      await expect(playerSpeedGroup.getByRole("button", { name: "2×" })).toHaveAttribute("aria-pressed", "true");

      const playerEffectGroup = playerControls.getByRole("group", { name: "特效强度" });
      await playerEffectGroup.getByRole("button", { name: "极简" }).click();
      await expect(playerEffectGroup.getByRole("button", { name: "极简" })).toHaveAttribute("aria-pressed", "true");

      await gotoSettings(page, mode.baseURL, mode.locked);

      await expect(page.getByRole("group", { name: "讲课语速" }).getByRole("button", { name: "2×" })).toHaveAttribute(
        "aria-pressed",
        "true"
      );
      await expect(page.getByRole("group", { name: "特效强度" }).getByRole("button", { name: "极简" })).toHaveAttribute(
        "aria-pressed",
        "true"
      );
    });

    test("(c) cross-tab: two pages in same context, save in one, other page updates via storage event", async ({
      context,
    }) => {
      const page1 = await context.newPage();
      const page2 = await context.newPage();

      await gotoSettings(page1, mode.baseURL, mode.locked);
      await page2.goto(`${mode.baseURL}/problem/two-sum`);
      const playerControls2 = page2.getByTestId("player-controls");
      await expect(playerControls2).toBeVisible();

      // In page1 (settings): choose 1.5× and 克制, then save
      const speedGroup1 = page1.getByRole("group", { name: "讲课语速" });
      const effectGroup1 = page1.getByRole("group", { name: "特效强度" });
      await speedGroup1.getByRole("button", { name: "1.5×" }).click();
      await effectGroup1.getByRole("button", { name: "克制" }).click();
      await page1.getByRole("button", { name: "保存设置" }).click();
      await expect(page1.getByRole("button", { name: "已保存" })).toBeVisible();

      // Page2 (player) updates via storage event without reload
      const speedGroup2 = playerControls2.getByRole("group", { name: "语速" });
      const effectGroup2 = playerControls2.getByRole("group", { name: "特效强度" });
      await expect(speedGroup2.getByRole("button", { name: "1.5×" })).toHaveAttribute("aria-pressed", "true");
      await expect(effectGroup2.getByRole("button", { name: "克制" })).toHaveAttribute("aria-pressed", "true");

      // Now change in player (page2), page1 (settings) updates via storage event
      await speedGroup2.getByRole("button", { name: "0.5×" }).click();
      await expect(speedGroup1.getByRole("button", { name: "0.5×" })).toHaveAttribute("aria-pressed", "true");

      await page1.close();
      await page2.close();
    });

    test("(d) setItem throwing via addInitScript shows failure copy and no 已保存", async ({ page }) => {
      await page.addInitScript(() => {
        const orig = Storage.prototype.setItem;
        Storage.prototype.setItem = function (key: string, value: string) {
          if (key === "algostage.speed") {
            throw new Error("QuotaExceededError");
          }
          return orig.call(this, key, value);
        };
      });

      await gotoSettings(page, mode.baseURL, mode.locked);

      const speedGroup = page.getByRole("group", { name: "讲课语速" });
      await speedGroup.getByRole("button", { name: "1.5×" }).click();

      await page.getByRole("button", { name: "保存设置" }).click();

      await expect(page.getByText("没保存成功，请确认浏览器允许本地存储后再试。")).toBeVisible();
      await expect(page.getByRole("button", { name: "已保存" })).toHaveCount(0);
    });

    test("(f) same-tab navigation: change speed in player, navigate to settings via internal link, save 1.5× and 克制, return via internal link, assert player synced", async ({
      page,
    }) => {
      // 打开讲课页
      await page.goto(`${mode.baseURL}/problem/two-sum`);
      const playerControls = page.getByTestId("player-controls");
      await expect(playerControls).toBeVisible();

      // 改倍速
      const playerSpeedGroup = playerControls.getByRole("group", { name: "语速" });
      await playerSpeedGroup.getByRole("button", { name: "2×" }).click();
      await expect(playerSpeedGroup.getByRole("button", { name: "2×" })).toHaveAttribute("aria-pressed", "true");

      // 通过站内链接点击进设置页（不用 page.goto、不 reload）
      await page.getByRole("link", { name: "设置" }).click();
      const speedGroup = page.getByRole("group", { name: "讲课语速" });
      const effectGroup = page.getByRole("group", { name: "特效强度" });
      await expect(speedGroup).toBeVisible();

      // 选 1.5× 和「克制」点「保存设置」
      await speedGroup.getByRole("button", { name: "1.5×" }).click();
      await expect(speedGroup.getByRole("button", { name: "1.5×" })).toHaveAttribute("aria-pressed", "true");

      await effectGroup.getByRole("button", { name: "克制" }).click();
      await expect(effectGroup.getByRole("button", { name: "克制" })).toHaveAttribute("aria-pressed", "true");

      await page.getByRole("button", { name: "保存设置" }).click();
      await expect(page.getByRole("button", { name: "已保存" })).toBeVisible();

      // 通过站内链接回讲课页
      await page.getByRole("link", { name: "AlgoStage 首页" }).click();
      await page.getByRole("link", { name: "听第一堂课：两数之和" }).click();

      // 断言播放器显示 1.5× 和克制
      const returnPlayerControls = page.getByTestId("player-controls");
      await expect(returnPlayerControls).toBeVisible();

      const returnSpeed = returnPlayerControls.getByRole("group", { name: "语速" }).getByRole("button", { name: "1.5×" });
      await expect(returnSpeed).toHaveAttribute("aria-pressed", "true");

      const returnEffect = returnPlayerControls.getByRole("group", { name: "特效强度" }).getByRole("button", { name: "克制" });
      await expect(returnEffect).toHaveAttribute("aria-pressed", "true");
    });
  });
}

test("(e) P5: default mode PUT legacy prefs to DB, locked-mode /settings shows defaults and can change+save", async ({
  page,
  request,
}) => {
  // In default mode, PUT /api/settings with narrationSpeed '15' effectLevel 'minimal'
  const putRes = await request.put(`${defaultBaseURL}/api/settings`, {
    data: {
      settings: {
        narrationSpeed: "15",
        effectLevel: "minimal",
      },
    },
  });
  expect(putRes.status()).toBe(200);

  // Confirm DB has these legacy values returned by GET
  const getRes = await request.get(`${defaultBaseURL}/api/settings`);
  expect(getRes.status()).toBe(200);
  const data = await getRes.json();
  expect(data.settings?.narrationSpeed).toBe("15");
  expect(data.settings?.effectLevel).toBe("minimal");

  // Default mode settings page also ignores legacy values from DB
  await gotoSettings(page, defaultBaseURL, false);
  await expect(page.getByRole("group", { name: "讲课语速" }).getByRole("button", { name: "1×（默认）" })).toHaveAttribute(
    "aria-pressed",
    "true"
  );
  await expect(page.getByRole("group", { name: "特效强度" }).getByRole("button", { name: "华丽" })).toHaveAttribute(
    "aria-pressed",
    "true"
  );

  // Open locked-mode /settings: shows default 1×（默认） and 华丽 pressed
  await gotoSettings(page, lockedBaseURL, true);

  const lockedSpeedGroup = page.getByRole("group", { name: "讲课语速" });
  const lockedEffectGroup = page.getByRole("group", { name: "特效强度" });

  await expect(lockedSpeedGroup.getByRole("button", { name: "1×（默认）" })).toHaveAttribute("aria-pressed", "true");
  await expect(lockedEffectGroup.getByRole("button", { name: "华丽" })).toHaveAttribute("aria-pressed", "true");

  // Can change + save
  await lockedSpeedGroup.getByRole("button", { name: "2×" }).click();
  await expect(lockedSpeedGroup.getByRole("button", { name: "2×" })).toHaveAttribute("aria-pressed", "true");

  await lockedEffectGroup.getByRole("button", { name: "克制" }).click();
  await expect(lockedEffectGroup.getByRole("button", { name: "克制" })).toHaveAttribute("aria-pressed", "true");

  await page.getByRole("button", { name: "保存设置" }).click();
  await expect(page.getByRole("button", { name: "已保存" })).toBeVisible();

  // Reload and verify persisted
  await page.reload();
  await expect(page.getByRole("group", { name: "讲课语速" }).getByRole("button", { name: "2×" })).toHaveAttribute(
    "aria-pressed",
    "true"
  );
  await expect(page.getByRole("group", { name: "特效强度" }).getByRole("button", { name: "克制" })).toHaveAttribute(
    "aria-pressed",
    "true"
  );
});
