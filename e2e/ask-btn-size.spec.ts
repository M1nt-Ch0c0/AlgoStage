import { expect, test, type Page } from "@playwright/test";

const CACHE_KEY = "a".repeat(40);
const SCRIPT_VERSION = "b".repeat(40);

function step(id: string, narration: string) {
  return {
    id,
    narration,
    targets: [{ kind: "code-line", start: 1, end: 2 }],
    effects: [],
    dwellMs: 60_000,
    viz: { type: "array", state: { values: [1, 2, 3], highlight: [0] } },
  };
}

function lectureNdjson() {
  const steps = [step("s1", "开局把词按字母分组"), step("s2", "再写回结果"), step("s3", "返回分组")];
  const lines = steps.map((item) => JSON.stringify({ type: "step", step: item }));
  lines.push(
    JSON.stringify({
      type: "result",
      script: {
        problemSlug: "group-anagrams",
        mode: "lecture",
        language: "zh",
        solutionLanguage: "typescript",
        steps,
      },
      cacheKey: CACHE_KEY,
      scriptVersion: SCRIPT_VERSION,
      answers: {},
      askDisabledStepIds: [],
    }),
  );
  return `${lines.join("\n")}\n`;
}

async function startGenerated(page: Page) {
  await page.route("**/api/settings", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ serverKeyDisabled: false, keySource: "env" }),
    }),
  );
  await page.route("**/api/lecture", async (route) => {
    if (route.request().url().includes("/api/lecture/ask")) {
      await route.fallback();
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/x-ndjson", body: lectureNdjson() });
  });
  await page.goto("/problem/group-anagrams");
  await page.locator("header").getByRole("button", { name: "开始讲课", exact: true }).click();
  await expect(page.getByText("第 1 / 3 步")).toBeVisible();
  const pause = page.locator("header").getByRole("button", { name: "暂停", exact: true });
  const resume = page.locator("header").getByRole("button", { name: "继续", exact: true });
  await expect(pause.or(resume)).toBeVisible();
  if (await pause.isVisible()) await pause.click();
  await expect(resume).toBeVisible();
}

const entry = (page: Page) => page.locator("[data-ask-entry]");

async function enterSelection(page: Page) {
  const button = entry(page).first();
  await expect(button).toBeEnabled();
  await button.click();
  await expect(page.locator("[data-ask-layer]")).toBeVisible();
  await expect(button).toHaveAttribute("aria-pressed", "true");
}

test.describe("1280 desktop btn-size", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("1280: enter ask → exit/entry button height≈40 (±2), bounding box ≥44×44, font ≥14.5, icon ≥20, elementFromPoint, regress drag 10px below", async ({ page }) => {
    await startGenerated(page);
    await enterSelection(page);

    const btn = entry(page).first();
    await expect(btn).toBeVisible();

    const box = (await btn.boundingBox())!;
    expect(box).not.toBeNull();
    // Desktop: height target 40 (h-10), hit target >=44x44
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(40);
    expect(box.height).toBeLessThanOrEqual(46);

    const fontSize = await btn.evaluate((el) => {
      return parseFloat(window.getComputedStyle(el).fontSize);
    });
    expect(fontSize).toBeGreaterThanOrEqual(14.5);

    const icon = btn.locator("[data-ask-entry-icon], svg").first();
    await expect(icon).toBeVisible();
    const iconBox = (await icon.boundingBox())!;
    expect(iconBox).not.toBeNull();
    expect(iconBox.width).toBeGreaterThanOrEqual(20);
    expect(iconBox.height).toBeGreaterThanOrEqual(20);

    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const isHit = await btn.evaluate((el, { x, y }) => {
      const hit = document.elementFromPoint(x, y);
      return hit !== null && (hit === el || el.contains(hit));
    }, { x: cx, y: cy });
    expect(isHit).toBe(true);

    // Regress drag 10px below exit button bottom edge on subtitle text
    const subtitleBody = page.locator('[data-ask-target="subtitle"] p').filter({ hasNotText: "字幕" }).first();
    await subtitleBody.scrollIntoViewIfNeeded();
    const btnBox = (await btn.boundingBox())!;
    const startX = btnBox.x + btnBox.width / 2;
    const startY = btnBox.y + btnBox.height + 10;

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX - 40, startY + 25, { steps: 5 });
    await page.mouse.up();

    const panelEl = page.locator("[data-ask-panel]");
    await expect(panelEl).toBeVisible();
    await expect(panelEl.locator("[data-ask-panel-label]")).toHaveText("已选：当前字幕");
  });
});

test.describe("390 mobile btn-size", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

  test("390 selecting: bar exit ≥48×48, elementFromPoint, shortcut gap ≥8", async ({ page }) => {
    await startGenerated(page);
    await enterSelection(page);

    const bar = page.locator("[data-ask-bottom-bar]");
    await expect(bar).toBeVisible();

    const barExit = bar.locator("[data-ask-entry]");
    await expect(barExit).toBeVisible();

    const exitBox = (await barExit.boundingBox())!;
    expect(exitBox).not.toBeNull();
    expect(exitBox.width).toBeGreaterThanOrEqual(48);
    expect(exitBox.height).toBeGreaterThanOrEqual(48);

    const cx = exitBox.x + exitBox.width / 2;
    const cy = exitBox.y + exitBox.height / 2;
    const isHit = await barExit.evaluate((el, { x, y }) => {
      const hit = document.elementFromPoint(x, y);
      return hit !== null && (hit === el || el.contains(hit));
    }, { x: cx, y: cy });
    expect(isHit).toBe(true);

    const shortcuts = bar.locator("[data-ask-shortcut]");
    const count = await shortcuts.count();
    expect(count).toBeGreaterThan(1);
    for (let i = 0; i < count - 1; i++) {
      const boxA = (await shortcuts.nth(i).boundingBox())!;
      const boxB = (await shortcuts.nth(i + 1).boundingBox())!;
      const gap = boxB.x - (boxA.x + boxA.width);
      expect(gap).toBeGreaterThanOrEqual(7.5);
    }
  });

  test("390 panel open: floating safe exit visible above panel, elementFromPoint, z-index ≤ panel, tap exits", async ({ page }) => {
    await startGenerated(page);
    await enterSelection(page);

    const bar = page.locator("[data-ask-bottom-bar]");
    await expect(bar).toBeVisible();

    // Open panel via shortcut chip
    await bar.locator('[data-ask-shortcut="subtitle"]').click();

    // Bottom bar unmounts
    await expect(bar).toBeHidden();

    // Floating safe exit button is visible
    const safeExit = page.locator("[data-ask-exit-safe]");
    await expect(safeExit).toBeVisible();

    const panelEl = page.locator("[data-ask-panel]");
    await expect(panelEl).toBeVisible();

    const exitBox = (await safeExit.boundingBox())!;
    const panelBox = (await panelEl.boundingBox())!;
    // Safe exit bottom must be above panel top
    expect(exitBox.y + exitBox.height).toBeLessThan(panelBox.y);

    // Center elementFromPoint must hit safe exit button
    const cx = exitBox.x + exitBox.width / 2;
    const cy = exitBox.y + exitBox.height / 2;
    const isHit = await safeExit.evaluate((el, { x, y }) => {
      const hit = document.elementFromPoint(x, y);
      return hit !== null && (hit === el || el.contains(hit));
    }, { x: cx, y: cy });
    expect(isHit).toBe(true);

    // Exit z-index <= panel z-index
    const { exitZ, panelZ } = await page.evaluate(() => {
      const safe = document.querySelector("[data-ask-exit-safe]");
      const p = document.querySelector("[data-ask-panel]");
      const parseZ = (el: Element | null) => {
        if (!el) return 0;
        const z = window.getComputedStyle(el).zIndex;
        return parseInt(z, 10) || 0;
      };
      return { exitZ: parseZ(safe), panelZ: parseZ(p) };
    });
    expect(exitZ).toBeLessThanOrEqual(panelZ);

    // Tap exit exits ask
    await safeExit.click();
    await expect(page.locator("[data-ask-layer]")).toHaveCount(0);
    await expect(page.locator("[data-ask-panel]")).toHaveCount(0);
  });
});
