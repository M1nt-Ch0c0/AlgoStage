import { expect, test } from "@playwright/test";

test.beforeEach(async ({ context, baseURL }) => {
  // The real app serves every asset locally; smoke tests must never call AI/CDNs.
  await context.route(/^https?:\/\//, (route) => {
    if (new URL(route.request().url()).origin === baseURL) return route.continue();
    throw new Error(`Unexpected external request: ${new URL(route.request().url()).origin}`);
  });
});

test.describe("390 mobile touch targets", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
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

    const speedFieldset = page.getByRole("group", { name: "讲课语速" });
    const speed05Button = speedFieldset.getByRole("button", { name: "0.5×" });
    const speed10Button = speedFieldset.getByRole("button", { name: "1×（默认）" });
    const speed15Button = speedFieldset.getByRole("button", { name: "1.5×" });
    const speed20Button = speedFieldset.getByRole("button", { name: "2×" });
    const speedButtons = [speed05Button, speed10Button, speed15Button, speed20Button];

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

    // Four speed buttons each have bounding box height >= 44 and width >= 44
    const speedBoxes = [];
    for (const btn of speedButtons) {
      const box = await btn.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.width).toBeGreaterThanOrEqual(44);
      expect(box!.height).toBeGreaterThanOrEqual(44);
      speedBoxes.push(box!);
    }

    // Bounding boxes do not overlap
    for (let i = 0; i < speedBoxes.length; i++) {
      for (let j = i + 1; j < speedBoxes.length; j++) {
        const overlap = !(
          speedBoxes[i].x + speedBoxes[i].width <= speedBoxes[j].x ||
          speedBoxes[j].x + speedBoxes[j].width <= speedBoxes[i].x ||
          speedBoxes[i].y + speedBoxes[i].height <= speedBoxes[j].y ||
          speedBoxes[j].y + speedBoxes[j].height <= speedBoxes[i].y
        );
        expect(overlap).toBe(false);
      }
    }

    // For the 4 speed options additionally: compute each hit rect and assert no two overlap
    // Scroll the fieldset into view first so all hit rects are in a shared stable viewport frame
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

    for (let i = 0; i < speedResults.length; i++) {
      for (let j = i + 1; j < speedResults.length; j++) {
        expect(rectsOverlap(speedResults[i].hitRect, speedResults[j].hitRect)).toBe(false);
      }
    }

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
});

test.describe("1280 desktop layout sanity", () => {
  test.use({
    viewport: { width: 1280, height: 800 },
    hasTouch: false,
    isMobile: false,
  });

  test("four speed buttons visible and non-overlapping on desktop", async ({ page }) => {
    await page.goto("/settings");

    const speedFieldset = page.getByRole("group", { name: "讲课语速" });
    await expect(speedFieldset).toBeVisible();

    const speedButtons = [
      speedFieldset.getByRole("button", { name: "0.5×" }),
      speedFieldset.getByRole("button", { name: "1×（默认）" }),
      speedFieldset.getByRole("button", { name: "1.5×" }),
      speedFieldset.getByRole("button", { name: "2×" }),
    ];

    const boxes = [];
    for (const btn of speedButtons) {
      await expect(btn).toBeVisible();
      const box = await btn.boundingBox();
      expect(box).not.toBeNull();
      boxes.push(box!);
    }

    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const overlap = !(
          boxes[i].x + boxes[i].width <= boxes[j].x ||
          boxes[j].x + boxes[j].width <= boxes[i].x ||
          boxes[i].y + boxes[i].height <= boxes[j].y ||
          boxes[j].y + boxes[j].height <= boxes[i].y
        );
        expect(overlap).toBe(false);
      }
    }
  });

  test("home page 去设置 uses inset shadow with zero border width at 1280", async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.removeItem("algostage.byok");
      window.localStorage.clear();
    });
    await page.goto("/");

    const link = page.getByRole("link", { name: "去设置" });
    await expect(link).toBeVisible();

    const styles = await link.evaluate((el) => {
      const cs = window.getComputedStyle(el);
      return {
        top: parseFloat(cs.borderTopWidth),
        right: parseFloat(cs.borderRightWidth),
        bottom: parseFloat(cs.borderBottomWidth),
        left: parseFloat(cs.borderLeftWidth),
        boxShadow: cs.boxShadow,
      };
    });

    expect(styles.top).toBe(0);
    expect(styles.right).toBe(0);
    expect(styles.bottom).toBe(0);
    expect(styles.left).toBe(0);
    expect(styles.boxShadow).toContain("inset");

    const box = await link.boundingBox();
    expect(box).toBeTruthy();
    expect(box!.width).toBeGreaterThan(0);
    expect(box!.height).toBeGreaterThan(0);
  });
});
