import { expect, test } from "@playwright/test";

test.use({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
});

test.beforeEach(async ({ context, baseURL }) => {
  // The real app serves every asset locally; smoke tests must never call AI/CDNs.
  await context.route(/^https?:\/\//, (route) => {
    if (new URL(route.request().url()).origin === baseURL) return route.continue();
    throw new Error(`Unexpected external request: ${new URL(route.request().url()).origin}`);
  });
});

test("settings touch targets have >=44x44 hit areas and speed options are non-overlapping", async ({ page }) => {
  await page.goto("/settings");

  // First assert await page.evaluate(()=>matchMedia('(pointer: coarse)').matches) is true.
  const isPointerCoarse = await page.evaluate(() => matchMedia("(pointer: coarse)").matches);
  expect(isPointerCoarse).toBe(true);

  const scanHitArea = async (locator: ReturnType<typeof page.getByRole>) => {
    await locator.scrollIntoViewIfNeeded();
    const handle = await locator.elementHandle();
    return await page.evaluate((button) => {
      if (!button) throw new Error("Button element not found");
      const rect = button.getBoundingClientRect();
      const cx = Math.floor(rect.left + rect.width / 2);
      const cy = Math.floor(rect.top + rect.height / 2);

      const centerHit = document.elementFromPoint(cx, cy);
      const centerHits = centerHit !== null && centerHit.closest("button") === button;

      let left = 0;
      for (let step = 1; step <= 120; step++) {
        const hit = document.elementFromPoint(cx - step, cy);
        if (hit && hit.closest("button") === button) {
          left = step;
        } else {
          break;
        }
      }

      let right = 0;
      for (let step = 1; step <= 120; step++) {
        const hit = document.elementFromPoint(cx + step, cy);
        if (hit && hit.closest("button") === button) {
          right = step;
        } else {
          break;
        }
      }

      let up = 0;
      for (let step = 1; step <= 120; step++) {
        const hit = document.elementFromPoint(cx, cy - step);
        if (hit && hit.closest("button") === button) {
          up = step;
        } else {
          break;
        }
      }

      let down = 0;
      for (let step = 1; step <= 120; step++) {
        const hit = document.elementFromPoint(cx, cy + step);
        if (hit && hit.closest("button") === button) {
          down = step;
        } else {
          break;
        }
      }

      const width = Math.min(120, left + right + 1);
      const height = Math.min(120, up + down + 1);

      return {
        cx,
        cy,
        left,
        right,
        up,
        down,
        width,
        height,
        centerHits,
        hitRect: {
          left: cx - left,
          right: cx + right,
          top: cy - up,
          bottom: cy + down,
          width,
          height,
        },
      };
    }, handle);
  };

  // Locate targets
  const toggleApiKeyButton = page.getByRole("button", { name: "显示 API Key" });

  const speedFieldset = page.getByRole("group", { name: "字幕语速" });
  const speedSlowButton = speedFieldset.getByRole("button", { name: "慢 · 15 字/秒" });
  const speedDefaultButton = speedFieldset.getByRole("button", { name: "标准 · 22 字/秒" });
  const speedFastButton = speedFieldset.getByRole("button", { name: "快 · 30 字/秒" });
  const speedButtons = [speedSlowButton, speedDefaultButton, speedFastButton];

  const exportRecordButton = page.getByRole("button", { name: "导出学习记录" });

  const allTargets = [
    toggleApiKeyButton,
    ...speedButtons,
    exportRecordButton,
  ];

  for (const target of allTargets) {
    const result = await scanHitArea(target);
    expect(result.centerHits).toBe(true);
    expect(result.width).toBeGreaterThanOrEqual(44);
    expect(result.height).toBeGreaterThanOrEqual(44);
  }

  // For the 3 speed options additionally: compute each hit rect and assert no two overlap
  // Scroll the fieldset into view first so all 3 hit rects are in a shared stable viewport frame
  await speedFieldset.scrollIntoViewIfNeeded();
  const speedResults = [];
  for (const btn of speedButtons) {
    speedResults.push(await scanHitArea(btn));
  }

  const rectsOverlap = (
    r1: { left: number; right: number; top: number; bottom: number },
    r2: { left: number; right: number; top: number; bottom: number }
  ) => {
    return !(
      r1.right < r2.left ||
      r1.left > r2.right ||
      r1.bottom < r2.top ||
      r1.top > r2.bottom
    );
  };

  expect(rectsOverlap(speedResults[0].hitRect, speedResults[1].hitRect)).toBe(false);
  expect(rectsOverlap(speedResults[0].hitRect, speedResults[2].hitRect)).toBe(false);
  expect(rectsOverlap(speedResults[1].hitRect, speedResults[2].hitRect)).toBe(false);

  // Click each option near its hit-area edge (e.g. 2px inside the left edge) via page.mouse/tap
  // and assert it becomes aria-pressed=true
  for (let i = 0; i < speedButtons.length; i++) {
    const btn = speedButtons[i];
    const { hitRect, cy } = speedResults[i];
    await page.mouse.click(hitRect.left + 2, cy);
    await expect(btn).toHaveAttribute("aria-pressed", "true");
  }
});

test("home page AI setup prompt link has >=44x44 hit area under pointer: coarse", async ({ page }) => {
  await page.goto("/");

  const isPointerCoarse = await page.evaluate(() => matchMedia("(pointer: coarse)").matches);
  expect(isPointerCoarse).toBe(true);

  const link = page.getByRole("link", { name: "去设置" });
  await link.scrollIntoViewIfNeeded();

  const handle = await link.elementHandle();
  const result = await page.evaluate((el) => {
    if (!el) throw new Error("Link element not found");
    const rect = el.getBoundingClientRect();
    const cx = Math.floor(rect.left + rect.width / 2);
    const cy = Math.floor(rect.top + rect.height / 2);

    const centerHit = document.elementFromPoint(cx, cy);
    const centerHits = centerHit !== null && centerHit.closest("a") === el;

    let left = 0;
    for (let step = 1; step <= 120; step++) {
      const hit = document.elementFromPoint(cx - step, cy);
      if (hit && hit.closest("a") === el) {
        left = step;
      } else {
        break;
      }
    }

    let right = 0;
    for (let step = 1; step <= 120; step++) {
      const hit = document.elementFromPoint(cx + step, cy);
      if (hit && hit.closest("a") === el) {
        right = step;
      } else {
        break;
      }
    }

    let up = 0;
    for (let step = 1; step <= 120; step++) {
      const hit = document.elementFromPoint(cx, cy - step);
      if (hit && hit.closest("a") === el) {
        up = step;
      } else {
        break;
      }
    }

    let down = 0;
    for (let step = 1; step <= 120; step++) {
      const hit = document.elementFromPoint(cx, cy + step);
      if (hit && hit.closest("a") === el) {
        down = step;
      } else {
        break;
      }
    }

    const width = Math.min(120, left + right + 1);
    const height = Math.min(120, up + down + 1);

    return {
      centerHits,
      width,
      height,
    };
  }, handle);

  expect(result.centerHits).toBe(true);
  expect(result.width).toBeGreaterThanOrEqual(44);
  expect(result.height).toBeGreaterThanOrEqual(44);
});
