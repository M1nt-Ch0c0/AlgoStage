import { expect, test } from "@playwright/test";

const step = (id: string, narration: string) => ({
  id, narration, targets: [{ kind: "code-line", start: 1, end: 2 }], effects: [],
});

test("regenerate while paused stays preparing and hides the old step", async ({ page }) => {
  let posts = 0;
  await page.route("**/api/lecture", async (route) => {
    const body = route.request().postDataJSON() as { solutionLanguage?: string; regenerate?: boolean };
    if (++posts === 1) {
      const language = body.solutionLanguage ?? "typescript";
      const steps = [step("s1", "计数签名"), step("s2", "归入同组"), step("s3", "返回各组")];
      const lines = [
        ...steps.map((item) => JSON.stringify({ type: "step", step: item })),
        JSON.stringify({
          type: "result",
          script: { problemSlug: "group-anagrams", mode: "lecture", language: "zh", solutionLanguage: language, steps },
        }),
      ];
      await route.fulfill({
        status: 200,
        contentType: "application/x-ndjson",
        body: `${lines.join("\n")}\n`,
      });
      return;
    }
    expect(body.regenerate).toBe(true);
    await new Promise<void>(() => {});
  });

  await page.goto("/problem/group-anagrams");
  await page.getByRole("button", { name: "开始讲课", exact: true }).click();
  await expect(page.getByText("第 1 / 3 步")).toBeVisible();
  await page.locator("header").getByRole("button", { name: "暂停", exact: true }).click();
  await expect(page.locator("header").getByRole("button", { name: "继续", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "更多", exact: true }).click();
  await page.getByRole("menuitem", { name: "重新生成" }).click();
  await page.getByRole("button", { name: "确定重新生成", exact: true }).click();

  const preparing = page.locator("header").getByRole("button", { name: "备课中…", exact: true });
  await expect(preparing).toBeDisabled();
  await expect(page.getByRole("button", { name: "取消备课", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "继续", exact: true })).toHaveCount(0);
  await preparing.click({ force: true });
  await expect(page.getByText("计数签名")).toHaveCount(0);
  await expect(page.getByText("第 1 / 3 步")).toHaveCount(0);
});

test("regenerate confirm dialog traps focus and restores focus on Escape", async ({ page }) => {
  await page.route("**/api/lecture", async (route) => {
    const body = route.request().postDataJSON() as { solutionLanguage?: string };
    const language = body.solutionLanguage ?? "typescript";
    const steps = [step("s1", "计数签名"), step("s2", "归入同组"), step("s3", "返回各组")];
    const lines = [
      ...steps.map((item) => JSON.stringify({ type: "step", step: item })),
      JSON.stringify({
        type: "result",
        script: { problemSlug: "group-anagrams", mode: "lecture", language: "zh", solutionLanguage: language, steps },
      }),
    ];
    await route.fulfill({
      status: 200,
      contentType: "application/x-ndjson",
      body: `${lines.join("\n")}\n`,
    });
  });

  await page.goto("/problem/group-anagrams");
  await page.getByRole("button", { name: "开始讲课", exact: true }).click();
  await expect(page.locator("header").getByRole("button", { name: "暂停", exact: true })).toBeVisible();
  await page.locator("header").getByRole("button", { name: "暂停", exact: true }).click();
  await expect(page.locator("header").getByRole("button", { name: "继续", exact: true })).toBeVisible();

  const moreBtn = page.getByRole("button", { name: "更多", exact: true });
  await moreBtn.click();
  await page.getByRole("menuitem", { name: "重新生成" }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("aria-modal", "true");

  const cancelBtn = dialog.getByRole("button", { name: "取消", exact: true });
  const confirmBtn = dialog.getByRole("button", { name: "确定重新生成", exact: true });
  await expect(cancelBtn).toBeFocused();

  await page.keyboard.press("Tab");
  await expect(confirmBtn).toBeFocused();

  await page.keyboard.press("Tab");
  await expect(cancelBtn).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(moreBtn).toBeFocused();
});

// depends on Gavin's a1-touch-next player-controls change (ignore Space/Arrow inside button/a/[role=dialog]); may fail before rebase.
test("pressing Space on cancel in regenerate dialog closes dialog without advancing step", async ({ page }) => {
  await page.route("**/api/lecture", async (route) => {
    const body = route.request().postDataJSON() as { solutionLanguage?: string };
    const language = body.solutionLanguage ?? "typescript";
    const steps = [step("s1", "计数签名"), step("s2", "归入同组"), step("s3", "返回各组")];
    const lines = [
      ...steps.map((item) => JSON.stringify({ type: "step", step: item })),
      JSON.stringify({
        type: "result",
        script: { problemSlug: "group-anagrams", mode: "lecture", language: "zh", solutionLanguage: language, steps },
      }),
    ];
    await route.fulfill({
      status: 200,
      contentType: "application/x-ndjson",
      body: `${lines.join("\n")}\n`,
    });
  });

  await page.goto("/problem/group-anagrams");
  await page.getByRole("button", { name: "开始讲课", exact: true }).click();
  await expect(page.getByText("第 1 / 3 步")).toBeVisible();
  await page.locator("header").getByRole("button", { name: "暂停", exact: true }).click();
  await expect(page.locator("header").getByRole("button", { name: "继续", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "更多", exact: true }).click();
  await page.getByRole("menuitem", { name: "重新生成" }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const cancelBtn = dialog.getByRole("button", { name: "取消", exact: true });
  await expect(cancelBtn).toBeFocused();

  await page.keyboard.press("Space");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("第 1 / 3 步")).toBeVisible();
  await expect(page.locator("header").getByRole("button", { name: "继续", exact: true })).toBeVisible();
});

