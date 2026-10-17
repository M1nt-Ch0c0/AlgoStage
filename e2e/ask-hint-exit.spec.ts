import { expect, test, type Page } from "@playwright/test";
import { ASK_CODE_MISS_HINT, ASK_EMPTY_HIT, ASK_RESIZE_HINT } from "@/lib/ask/ask-ui-text";

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
const layer = (page: Page) => page.locator("[data-ask-layer]");
const panel = (page: Page) => page.locator("[data-ask-panel]");

async function waitForEnteringScroll(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        let lastY = window.scrollY;
        let unchangedCount = 0;
        const start = performance.now();
        const check = () => {
          if (window.scrollY === lastY) {
            unchangedCount++;
            if (unchangedCount >= 6) {
              resolve();
              return;
            }
          } else {
            unchangedCount = 0;
            lastY = window.scrollY;
          }
          if (performance.now() - start >= 3000) {
            resolve();
            return;
          }
          requestAnimationFrame(check);
        };
        requestAnimationFrame(check);
      }),
  );
}

async function enterSelection(page: Page) {
  const button = entry(page).first();
  await expect(button).toBeEnabled();
  await expect(button).not.toHaveAttribute("aria-disabled", "true");
  await button.click();
  await expect(layer(page)).toBeVisible();
  await expect(button).toHaveAttribute("aria-pressed", "true");
  await waitForEnteringScroll(page);
}

async function triggerResizeHint(page: Page, w: number, h: number) {
  await page.setViewportSize({ width: w, height: h - 1 });
  await page.setViewportSize({ width: w, height: h });
  await expect(page.getByText(ASK_RESIZE_HINT)).toHaveCount(1);
  await expect(page.getByText(ASK_RESIZE_HINT)).toBeVisible();
}

async function exitBy(page: Page, how: "button" | "esc") {
  if (how === "button") {
    const exitButton = page.getByRole("button", { name: "退出圈选" });
    if (await exitButton.isVisible()) {
      await exitButton.click();
    } else {
      await page.locator("[data-ask-entry]").first().click();
    }
  } else {
    await page.keyboard.press("Escape");
  }
  await expect(layer(page)).toHaveCount(0);
}

async function reEnterBy(page: Page, re: "q" | "button") {
  if (re === "q") {
    await entry(page).first().focus();
    await page.keyboard.press("q");
  } else {
    await page.getByRole("button", { name: "圈选提问" }).click();
  }
  await expect(layer(page)).toBeVisible();
  await expect(panel(page)).toHaveCount(0);
  await waitForEnteringScroll(page);
}

async function expectNoHints(page: Page) {
  await expect(page.getByText(ASK_RESIZE_HINT)).toHaveCount(0);
  await expect(page.getByText(ASK_CODE_MISS_HINT)).toHaveCount(0);
  await expect(page.getByText(ASK_EMPTY_HIT)).toHaveCount(0);
}

async function findSpot(page: Page) {
  return page.evaluate(() => {
    const stage = document.querySelector("[data-ask-stage]") as HTMLElement | null;
    if (!stage) return null;
    const sr = stage.getBoundingClientRect();
    const boxes = [
      ...stage.querySelectorAll(
        "[data-ask-target], [data-ask-id], .monaco-editor, button, header, [data-ask-bottom-bar]",
      ),
    ].map((e) => e.getBoundingClientRect());
    let f: { x: number; y: number } | null = null;
    for (let y = Math.max(sr.top, 0) + 70; y < Math.min(sr.bottom, innerHeight) - 64 && !f; y += 8) {
      for (let x = sr.left + 4; x < sr.right - 64; x += 8) {
        if (!boxes.some((b) => b.left < x + 60 && b.right > x && b.top < y + 60 && b.bottom > y)) {
          f = { x, y };
          break;
        }
      }
    }
    return f;
  });
}

async function dragAt(page: Page, s: { x: number; y: number }) {
  await page.mouse.move(s.x + 5, s.y + 5);
  await page.mouse.down();
  await page.mouse.move(s.x + 30, s.y + 30, { steps: 5 });
  await page.mouse.move(s.x + 55, s.y + 55, { steps: 5 });
  await page.mouse.up();
}

async function dragViz(page: Page) {
  const viz = page.locator('[data-ask-stage] [data-ask-id="viz:s1"]').first();
  await viz.scrollIntoViewIfNeeded();
  await waitForEnteringScroll(page);
  await expect(viz).toBeInViewport();
  const b = (await viz.boundingBox())!;
  await page.mouse.move(b.x + 8, b.y + 8);
  await page.mouse.down();
  await page.mouse.move(b.x + Math.max(b.width - 8, 40), b.y + Math.max(Math.min(b.height - 8, 80), 36), { steps: 8 });
  await page.mouse.up();
}

// 1280 视口用例
test.describe("1280 hint exit-clear", () => {
  const w = 1280;
  const h = 800;
  test.use({ viewport: { width: w, height: h } });

  for (const how of ["button", "esc"] as const) {
    for (const re of ["q", "button"] as const) {
      test(`C8 resize hint → exit(${how}) → re-enter(${re}) 无提示`, async ({ page }) => {
        await startGenerated(page);
        await enterSelection(page);
        await triggerResizeHint(page, w, h);
        await exitBy(page, how);
        await expectNoHints(page);
        await reEnterBy(page, re);
        await expectNoHints(page);
      });
    }
  }

  test("C8d resize 提示后框中有效内容 → 提示立刻消失、chip 正常", async ({ page }) => {
    await startGenerated(page);
    await enterSelection(page);
    await triggerResizeHint(page, w, h);
    await dragViz(page);
    await expectNoHints(page);
    await expect(panel(page)).toBeVisible();
    await expect(panel(page).locator("[data-ask-panel-label]")).toHaveText(/^已选：可视化 \d+ 处$/);
  });

  test("C8e resize 提示后再框空白 → 提示原位、仅 1 条、不闪", async ({ page }) => {
    await startGenerated(page);
    await enterSelection(page);
    await triggerResizeHint(page, w, h);

    const hint = page.getByText(ASK_RESIZE_HINT);
    const before = (await hint.boundingBox())!;

    await page.evaluate((text) => {
      const win = window as unknown as { __qaDetach: number; __qaMax: number };
      win.__qaDetach = 0;
      win.__qaMax = 0;
      const count = () =>
        [...document.querySelectorAll("body *")].filter(
          (e) => e.childElementCount === 0 && e.textContent?.includes(text),
        ).length;
      new MutationObserver(() => {
        const c = count();
        if (c === 0) win.__qaDetach++;
        win.__qaMax = Math.max(win.__qaMax, c);
      }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
    }, ASK_RESIZE_HINT);

    const spot = await findSpot(page);
    expect(spot).not.toBeNull();
    await dragAt(page, spot!);

    await expect(hint).toHaveCount(1);
    await expect(hint).toBeVisible();
    const after = (await hint.boundingBox())!;
    expect(Math.abs(after.x - before.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(1);

    const m = await page.evaluate(() => {
      const win = window as unknown as { __qaDetach: number; __qaMax: number };
      return { detach: win.__qaDetach, max: win.__qaMax };
    });
    expect(m.detach, "提示被拆掉过（闪）").toBe(0);
    expect(m.max, "同时出现多条").toBeLessThanOrEqual(1);
  });
});

// 390 视口用例（按 ask-selection.spec.ts 的 390 selection flow 写法）
test.describe("390 hint exit-clear (390 selection flow)", () => {
  const w = 390;
  const h = 844;
  test.use({ hasTouch: true, isMobile: true, viewport: { width: w, height: h } });

  for (const how of ["button", "esc"] as const) {
    for (const re of ["q", "button"] as const) {
      test(`C8 390: resize hint → exit(${how}) → re-enter(${re}) 无提示`, async ({ page }) => {
        await startGenerated(page);
        await enterSelection(page);
        await triggerResizeHint(page, w, h);
        await exitBy(page, how);
        await expectNoHints(page);
        await reEnterBy(page, re);
        await expectNoHints(page);
      });
    }
  }

  test("C8d 390: resize 提示后框中有效内容 → 提示立刻消失、chip 正常", async ({ page }) => {
    await startGenerated(page);
    await enterSelection(page);
    await triggerResizeHint(page, w, h);
    await dragViz(page);
    await expectNoHints(page);
    await expect(panel(page)).toBeVisible();
    await expect(panel(page).locator("[data-ask-panel-label]")).toHaveText(/^已选：可视化 \d+ 处$/);
  });

  test("C8e 390: resize 提示后再框空白 → 提示原位、仅 1 条、不闪", async ({ page }) => {
    await startGenerated(page);
    await enterSelection(page);
    await triggerResizeHint(page, w, h);

    const hint = page.getByText(ASK_RESIZE_HINT);
    const before = (await hint.boundingBox())!;

    await page.evaluate((text) => {
      const win = window as unknown as { __qaDetach: number; __qaMax: number };
      win.__qaDetach = 0;
      win.__qaMax = 0;
      const count = () =>
        [...document.querySelectorAll("body *")].filter(
          (e) => e.childElementCount === 0 && e.textContent?.includes(text),
        ).length;
      new MutationObserver(() => {
        const c = count();
        if (c === 0) win.__qaDetach++;
        win.__qaMax = Math.max(win.__qaMax, c);
      }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
    }, ASK_RESIZE_HINT);

    const spot = await findSpot(page);
    expect(spot).not.toBeNull();
    await dragAt(page, spot!);

    await expect(hint).toHaveCount(1);
    await expect(hint).toBeVisible();
    const after = (await hint.boundingBox())!;
    expect(Math.abs(after.x - before.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(1);

    const m = await page.evaluate(() => {
      const win = window as unknown as { __qaDetach: number; __qaMax: number };
      return { detach: win.__qaDetach, max: win.__qaMax };
    });
    expect(m.detach, "提示被拆掉过（闪）").toBe(0);
    expect(m.max, "同时出现多条").toBeLessThanOrEqual(1);
  });
});
