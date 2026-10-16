import { expect, test, type CDPSession, type Page, type Route } from "@playwright/test";

/**
 * 提问提交时「正在准备截图…」不把取消按钮顶下去；截图卡住时取消不发出提问请求。
 * 帮手从 e2e/ask-selection.spec.ts 原样复制，不 import（同 e2e/s4-capture-perf.spec.ts）。
 */

const CACHE_KEY = "a".repeat(40);
const SCRIPT_VERSION = "b".repeat(40);
const QUESTION = "这一步在做什么？";
const ANSWER_NARRATION = "把相同字母的词放进同一组。";

type StepOpts = { id?: string; narration?: string; viz?: boolean };

function step(opts: StepOpts = {}) {
  const id = opts.id ?? "s1";
  return {
    id,
    narration: opts.narration ?? "开局把词按字母分组",
    targets: [{ kind: "code-line", start: 1, end: 2 }],
    effects: [],
    dwellMs: 60_000,
    ...(opts.viz === false
      ? {}
      : { viz: { type: "array", state: { values: [1, 2, 3], highlight: [0] } } }),
  };
}

function lectureNdjson(options: {
  steps?: ReturnType<typeof step>[];
  askDisabledStepIds?: string[];
  withResult?: boolean;
}) {
  const steps = options.steps ?? [step(), step({ id: "s2", narration: "再写回结果" }), step({ id: "s3", narration: "返回分组" })];
  const lines = steps.map((item) => JSON.stringify({ type: "step", step: item }));
  if (options.withResult !== false) {
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
        askDisabledStepIds: options.askDisabledStepIds ?? [],
      }),
    );
  }
  return `${lines.join("\n")}\n`;
}

function askStream(stepId: string) {
  const segment = { id: "seg1", narration: ANSWER_NARRATION };
  const answer = {
    v: 1,
    id: "ans-e2e-sel",
    stepId,
    question: QUESTION,
    selection: {
      mode: "region",
      bbox: { x: 0, y: 0, width: 40, height: 40 },
      targets: [{ kind: "viz", id: `viz:${stepId}`, stepId, text: "可视化" }],
    },
    segments: [segment],
    createdAt: "2026-10-14T00:00:00.000Z",
  };
  return [
    JSON.stringify({ type: "start", answerId: answer.id, stepId, imageUsed: false }),
    JSON.stringify({ type: "segment", segment }),
    JSON.stringify({ type: "result", answer }),
  ].join("\n") + "\n";
}

async function fulfillJson(route: Route, body: unknown, delayMs = 0) {
  if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function mockSettings(page: Page, serverKeyDisabled: boolean, delayMs = 0) {
  await page.route("**/api/settings", (route) =>
    fulfillJson(route, { serverKeyDisabled, keySource: "env" }, delayMs),
  );
}

async function mockLecture(page: Page, body: string | (() => Promise<string> | string)) {
  await page.route("**/api/lecture", async (route) => {
    if (route.request().url().includes("/api/lecture/ask")) {
      await route.fallback();
      return;
    }
    const payload = typeof body === "function" ? await body() : body;
    await route.fulfill({
      status: 200,
      contentType: "application/x-ndjson",
      body: payload,
    });
  });
}

async function startGenerated(page: Page, ndjson = lectureNdjson({})) {
  await mockSettings(page, false);
  await mockLecture(page, ndjson);
  await page.goto("/problem/group-anagrams");
  await page.locator("header").getByRole("button", { name: "开始讲课", exact: true }).click();
  await expect(page.getByText("第 1 / 3 步")).toBeVisible();
}

const entry = (page: Page) => page.locator("[data-ask-entry]");

async function pauseLecture(page: Page) {
  const pause = page.locator("header").getByRole("button", { name: "暂停", exact: true });
  const resume = page.locator("header").getByRole("button", { name: "继续", exact: true });
  await expect(pause.or(resume)).toBeVisible();
  if (await pause.isVisible()) await pause.click();
  await expect(resume).toBeVisible();
}

async function enterSelection(page: Page) {
  const button = entry(page);
  await expect(button).toBeVisible();
  await expect(button).toBeEnabled();
  await expect(button).not.toHaveAttribute("aria-disabled", "true");
  await button.click();
  await expect(page.locator("[data-ask-layer]")).toBeVisible();
  await expect(button).toHaveAttribute("aria-pressed", "true");
}

async function dragOnStage(page: Page) {
  const stage = page.locator("[data-ask-stage]");
  const viz = stage.locator('[data-ask-id="viz:s1"]').first();
  await expect(viz).toBeVisible();
  const box = await viz.boundingBox();
  if (!box) throw new Error("viz target has no box");
  const startX = box.x + 8;
  const startY = box.y + 8;
  const endX = box.x + Math.max(box.width - 8, 40);
  const endY = box.y + Math.max(Math.min(box.height - 8, 80), 36);
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(endX, endY, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator("[data-ask-panel]")).toBeVisible();
}

async function openAskPanel(page: Page) {
  await startGenerated(page);
  await pauseLecture(page);
  await enterSelection(page);
  await dragOnStage(page);
  await page.locator("[data-ask-panel] [data-ask-question]").fill(QUESTION);
}

type AskHold = { release: () => void };

/** Hold /api/lecture/ask until the test releases it, so waiting stays on screen. */
async function routeHeldAsk(page: Page): Promise<AskHold> {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/lecture/ask", async (route) => {
    await gate;
    await route.fulfill({
      status: 200,
      contentType: "application/x-ndjson",
      body: askStream("s1"),
    });
  });
  return { release };
}

async function withCpuThrottle(page: Page, rate: number, run: () => Promise<void>) {
  const client = await page.context().newCDPSession(page);
  await client.send("Emulation.setCPUThrottlingRate", { rate });
  try {
    await run();
  } finally {
    await client.send("Emulation.setCPUThrottlingRate", { rate: 1 }).catch(() => {});
  }
}

async function boxCenter(page: Page, selector: string) {
  const box = await page.locator(selector).boundingBox();
  if (!box) throw new Error(`${selector} has no box`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, top: box.y };
}

async function pressAt(page: Page, x: number, y: number, touch: boolean) {
  if (touch) await page.touchscreen.tap(x, y);
  else await page.mouse.click(x, y);
}

type PointerClient = Pick<CDPSession, "send">;

function touchPoint(x: number, y: number) {
  return [{ x: Math.round(x), y: Math.round(y) }];
}

/** Touch goes through CDP Input.dispatchTouchEvent; mouse uses page.mouse. */
async function down(page: Page, client: PointerClient, x: number, y: number, touch: boolean) {
  if (touch) {
    await client.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: touchPoint(x, y),
    });
    return;
  }
  await page.mouse.move(x, y);
  await page.mouse.down();
}

async function up(page: Page, client: PointerClient, x: number, y: number, touch: boolean) {
  if (touch) {
    await client.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: touchPoint(x, y),
    });
    return;
  }
  await page.mouse.move(x, y);
  await page.mouse.up();
}

async function moveTo(page: Page, client: PointerClient, x: number, y: number, touch: boolean) {
  if (touch) {
    await client.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: touchPoint(x, y),
    });
    return;
  }
  await page.mouse.move(x, y);
}

/**
 * Stall tests run against the compile-time hook in lib/ask/capture.ts.
 * NEXT_PUBLIC_ASK_TEST_STALL_MS is inlined next to domToCanvas; unset builds
 * tree-shake the loop, so those tests skip instead of racing a short capture.
 */
const STALL_HOOK_MS = Number(process.env.NEXT_PUBLIC_ASK_TEST_STALL_MS);
const stallHookOn = Number.isFinite(STALL_HOOK_MS) && STALL_HOOK_MS > 0;

function requireStallHook() {
  test.skip(!stallHookOn, "requires NEXT_PUBLIC_ASK_TEST_STALL_MS (hook build, e.g. 1500)");
}

/** Resolves only when the main thread is free enough to run this evaluate. */
async function waitStallEnd(page: Page) {
  await page.evaluate(() => 0);
}

type StallArm = {
  __copyBeforePress?: string;
  __stallAttached?: boolean;
};

/**
 * Install before submit. The observer runs in the mutation task, which is
 * before the double rAF and the compile-time stall, and stores the preparing
 * row's text. The returned promise is that one evaluate: it resolves when the
 * row attaches, without a later renderer round-trip that would wait out the stall.
 */
async function armedForStall(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const win = window as unknown as StallArm;
        delete win.__copyBeforePress;
        win.__stallAttached = false;
        const existing = document.querySelector("[data-ask-capture-preparing]");
        const remember = (node: Element) => {
          if (win.__stallAttached) return;
          win.__stallAttached = true;
          win.__copyBeforePress = node.textContent ?? "";
          resolve();
        };
        if (existing) {
          remember(existing);
          return;
        }
        const observer = new MutationObserver(() => {
          const node = document.querySelector("[data-ask-capture-preparing]");
          if (!node) return;
          observer.disconnect();
          remember(node);
        });
        observer.observe(document.body, { childList: true, subtree: true, attributes: true });
      }),
  );
}

/** The observer promise, bounded like the old toBeAttached({ timeout: 15_000 }). */
async function waitArmed(attached: Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("[data-ask-capture-preparing] did not attach")),
      15_000,
    );
  });
  try {
    await Promise.race([attached, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Copy captured at attach time. Read only after the stall has ended. */
async function readCopyBeforePress(page: Page): Promise<string> {
  return page.evaluate(() => (window as unknown as StallArm).__copyBeforePress ?? "");
}

/**
 * The press must be inside the hook stall: its event time is before the
 * long task that contains the busy loop and domToCanvas.
 */
async function expectPressInsideStall(page: Page) {
  const timing = await page.evaluate(() => {
    const probe = (window as unknown as { __ASK_TIMING__?: { firstPointerDownTs?: number; longTaskEnd?: number } })
      .__ASK_TIMING__;
    return probe && typeof probe === "object" ? probe : null;
  });
  expect(timing?.firstPointerDownTs).toEqual(expect.any(Number));
  expect(timing?.longTaskEnd).toEqual(expect.any(Number));
  expect(timing!.firstPointerDownTs!).toBeLessThan(timing!.longTaskEnd!);
}

/**
 * Records any flash of ask chips, code-miss hint, waiting row, or error
 * (panel role=alert / data-ask-error, or the step-answer role=alert).
 * Real selectors from components/board/ask-panel.tsx and step-answers.tsx.
 */
async function installFlashObserver(page: Page) {
  await page.evaluate(() => {
    const selector = [
      "[data-ask-panel] [data-ask-chip]",
      "[data-ask-panel] [data-testid='ask-code-miss-hint']",
      "[data-ask-waiting]",
      "[data-ask-error]",
      "[data-testid='step-answers'] [role='alert']",
    ].join(", ");
    const flashes: string[] = [];
    const describe = (node: Node | null) => {
      if (!(node instanceof Element)) return;
      if (node.matches(selector)) flashes.push(node.getAttribute("data-ask-chip") ? "chip" : node.tagName);
      for (const el of node.querySelectorAll(selector)) {
        flashes.push(el.getAttribute("data-ask-chip") ? "chip" : el.tagName);
      }
    };
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) describe(node);
        if (record.type === "attributes") describe(record.target);
      }
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
    });
    (window as unknown as { __askFlash?: { flashes: string[]; stop: () => string[] } }).__askFlash = {
      flashes,
      stop: () => {
        observer.disconnect();
        return flashes;
      },
    };
  });
}

async function readFlashes(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const bag = (window as unknown as { __askFlash?: { stop: () => string[] } }).__askFlash;
    return bag ? bag.stop() : [];
  });
}

/**
 * Records add and remove of ask chips and the code-miss hint only.
 * Used by the natural (no-hook) cancel path.
 */
async function installChipHintObserver(page: Page) {
  await page.evaluate(() => {
    const selector = "[data-ask-chip], [data-testid='ask-code-miss-hint']";
    const changes: string[] = [];
    const label = (node: Node) => {
      if (!(node instanceof Element)) return null;
      if (node.matches("[data-ask-chip]")) return "chip";
      if (node.matches("[data-testid='ask-code-miss-hint']")) return "hint";
      return null;
    };
    const note = (node: Node, kind: "add" | "remove") => {
      // Closing the panel removes the chip subtree in one go. That is the
      // cancel, not a flicker of the chips while the panel stays up.
      if (kind === "remove" && node instanceof Element && node.matches("[data-ask-panel]")) return;
      const own = label(node);
      if (own) changes.push(`${kind}:${own}`);
      if (node instanceof Element) {
        for (const el of node.querySelectorAll(selector)) {
          const nested = label(el);
          if (nested) changes.push(`${kind}:${nested}`);
        }
      }
    };
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) note(node, "add");
        for (const node of record.removedNodes) note(node, "remove");
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    (window as unknown as { __askChipHint?: { stop: () => string[] } }).__askChipHint = {
      stop: () => {
        observer.disconnect();
        return changes;
      },
    };
  });
}

async function readChipHintChanges(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const bag = (window as unknown as { __askChipHint?: { stop: () => string[] } }).__askChipHint;
    return bag ? bag.stop() : [];
  });
}

/** closeAskPanel from a capture-stall cancel: panel unmounts, layer stays, submit is gone. */
async function expectClosedLikeCancel(page: Page) {
  await expect(page.locator("[data-ask-panel]")).toHaveCount(0, { timeout: 10_000 });
  await expect(page.locator("[data-ask-submit]")).toHaveCount(0);
  await expect(page.locator("[data-ask-layer]")).toBeVisible();
  await expect(page.locator("[data-ask-entry]")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("[data-ask-waiting]")).toHaveCount(0);
  await expect(page.locator("[data-ask-error]")).toHaveCount(0);
  await expect(page.locator("[data-testid='step-answers'] [role='alert']")).toHaveCount(0);
}

const STALL_TITLES = [
  "coordinate 取消 during capture stall",
  "held through capture stall",
  "press 取消 during stall",
  "hold 取消 past 2s",
  "forced stall",
];

function isStallTest(title: string) {
  return STALL_TITLES.some((part) => title.includes(part));
}

/** One JSON line plus a Playwright attachment. Assertions are unchanged. */
async function dumpAskTiming(page: Page, title: string, status: string) {
  const timing = await page
    .evaluate(() => {
      const probe = (window as unknown as { __ASK_TIMING__?: unknown }).__ASK_TIMING__;
      return probe && typeof probe === "object" ? probe : null;
    })
    .catch(() => null);
  const line = JSON.stringify({ title, status, timing });
  console.log(`ASK_TIMING ${line}`);
  await test.info().attach("ask-timing", {
    body: Buffer.from(`${line}\n`),
    contentType: "application/json",
  });
}

function installStatusStability(width: number, touch: boolean) {
  const label = width === 1280 ? "Desktop" : "390";

  test.describe(`${label} ${width}`, () => {
    test.use(
      width === 1280
        ? { viewport: { width: 1280, height: 800 } }
        : {
            hasTouch: true,
            isMobile: true,
            deviceScaleFactor: 3,
            viewport: { width: 390, height: 844 },
          },
    );

    test.beforeEach(async ({ page }, info) => {
      if (!isStallTest(info.title)) return;
      await page.addInitScript(() => {
        (window as unknown as { __ASK_TIMING__?: object }).__ASK_TIMING__ = {};
      });
    });

    test.afterEach(async ({ page }, info) => {
      if (!isStallTest(info.title)) return;
      await dumpAskTiming(page, info.title, info.status ?? "unknown");
    });

    test("取消 y equal in idle/preparing/streaming", async ({ page }) => {
      const held = await routeHeldAsk(page);
      try {
        await openAskPanel(page);
        const cancel = page.locator("[data-ask-cancel]");
        const idleBox = await cancel.boundingBox();
        if (!idleBox) throw new Error("取消 has no box");
        const idleY = idleBox.y;

        const submit = await boxCenter(page, "[data-ask-submit]");
        const client = await page.context().newCDPSession(page);
        await client.send("Emulation.setCPUThrottlingRate", { rate: 4 });
        try {
          await pressAt(page, submit.x, submit.y, touch);
          await expect(page.locator("[data-ask-capture-preparing]")).toBeVisible();
          const preparing = await cancel.boundingBox();
          if (!preparing) throw new Error("取消 has no box while preparing");
          expect(Math.abs(preparing.y - idleY)).toBeLessThanOrEqual(0.5);
        } finally {
          await client.send("Emulation.setCPUThrottlingRate", { rate: 1 }).catch(() => {});
        }

        await expect(page.locator("[data-ask-waiting]")).toBeVisible();
        const waiting = await cancel.boundingBox();
        if (!waiting) throw new Error("取消 has no box while waiting");
        expect(Math.abs(waiting.y - idleY)).toBeLessThanOrEqual(0.5);
      } finally {
        held.release();
      }
    });

    for (let i = 1; i <= 10; i += 1) {
      test(`coordinate 取消 during capture stall sends no ask run ${i}`, async ({ page }) => {
        requireStallHook();
        let askRequests = 0;
        await page.route("**/api/lecture/ask", async (route) => {
          askRequests += 1;
          await route.fulfill({
            status: 200,
            contentType: "application/x-ndjson",
            body: askStream("s1"),
          });
        });
        await openAskPanel(page);

        const cancelAt = await boxCenter(page, "[data-ask-cancel]");
        const submitAt = await boxCenter(page, "[data-ask-submit]");
        // Already on the button, so the press is not a second trip across the page.
        if (!touch) await page.mouse.move(cancelAt.x, cancelAt.y);
        const attached = armedForStall(page);
        await withCpuThrottle(page, 4, async () => {
          await pressAt(page, submitAt.x, submitAt.y, touch);
          await waitArmed(attached);
          // Node-side wait: the press lands inside the hook stall, after the
          // preparing row is on screen and before the main thread is free.
          await page.waitForTimeout(200);
          await pressAt(page, cancelAt.x, cancelAt.y, touch);
          await waitStallEnd(page);
          await expectPressInsideStall(page);
          await page.waitForTimeout(3000);
          expect(askRequests).toBe(0);
        });
      });
    }

    if (touch) {
      test("touch drag starting on 取消 does not cancel", async ({ page }) => {
        let askRequests = 0;
        let release = () => {};
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        await page.route("**/api/lecture/ask", async (route) => {
          askRequests += 1;
          await gate;
          await route.fulfill({
            status: 200,
            contentType: "application/x-ndjson",
            body: askStream("s1"),
          });
        });
        try {
          await openAskPanel(page);
          const submitAt = await boxCenter(page, "[data-ask-submit]");
          await pressAt(page, submitAt.x, submitAt.y, true);
          await expect(page.locator("[data-ask-capture-preparing]")).toBeVisible();

          const cancelAt = await boxCenter(page, "[data-ask-cancel]");
          const client = await page.context().newCDPSession(page);
          const touchPoint = (x: number, y: number) => [{ x: Math.round(x), y: Math.round(y), id: 0 }];
          await client.send("Input.dispatchTouchEvent", {
            type: "touchStart",
            touchPoints: touchPoint(cancelAt.x, cancelAt.y),
          });
          for (const step of [1, 2, 3, 4]) {
            await client.send("Input.dispatchTouchEvent", {
              type: "touchMove",
              touchPoints: touchPoint(cancelAt.x, cancelAt.y - step * 15),
            });
          }
          await client.send("Input.dispatchTouchEvent", {
            type: "touchEnd",
            touchPoints: touchPoint(cancelAt.x, cancelAt.y - 60),
          });

          await expect.poll(() => askRequests).toBe(1);
          await expect(page.locator("[data-ask-panel]")).toBeVisible();
          await expect(page.locator("[data-ask-waiting]")).toBeVisible();
        } finally {
          release();
        }
      });
    }

    if (!touch) {
      test("mouse down on 取消, drag out, release does not cancel", async ({ page }) => {
        const held = await routeHeldAsk(page);
        try {
          await openAskPanel(page);
          const submitAt = await boxCenter(page, "[data-ask-submit]");
          await page.mouse.click(submitAt.x, submitAt.y);
          await expect(page.locator("[data-ask-capture-preparing]")).toBeVisible();

          const cancelAt = await boxCenter(page, "[data-ask-cancel]");
          await page.mouse.move(cancelAt.x, cancelAt.y);
          await page.mouse.down();
          await page.mouse.move(cancelAt.x + 80, cancelAt.y, { steps: 6 });
          await page.mouse.up();

          await expect(page.locator("[data-ask-waiting]")).toBeVisible();
          await expect(page.locator("[data-ask-panel]")).toBeVisible();
        } finally {
          held.release();
        }
      });

      test("keyboard Enter cancels once", async ({ page }) => {
        const held = await routeHeldAsk(page);
        try {
          await openAskPanel(page);
          const submit = page.locator("[data-ask-submit]");
          await submit.click();
          await expect(page.locator("[data-ask-waiting]")).toBeVisible();

          const cancel = page.locator("[data-ask-cancel]");
          await cancel.focus();
          await page.keyboard.press("Enter");

          await expect(page.locator("[data-ask-waiting]")).toHaveCount(0);
          await expect(page.locator("[data-ask-panel]")).toBeVisible();
          await expect(page.locator("[data-ask-panel] [data-ask-question]")).toHaveValue(QUESTION);
          await expect(page.locator("[data-ask-submit]")).toBeEnabled();
          await expect(page.locator("[data-ask-submit]")).not.toHaveAttribute("aria-disabled", "true");
          await expect(page.locator("[data-ask-layer]")).toBeVisible();
          await expect(page.locator("[data-ask-entry]")).toHaveAttribute("aria-pressed", "true");
          await page.waitForTimeout(400);
          await expect(page.locator("[data-ask-waiting]")).toHaveCount(0);
          await expect(page.locator("[data-ask-panel]")).toBeVisible();
          await expect(page.locator("[data-ask-layer]")).toBeVisible();
        } finally {
          held.release();
        }
      });

      test("keyboard Space cancels once", async ({ page }) => {
        const held = await routeHeldAsk(page);
        try {
          await openAskPanel(page);
          const submit = page.locator("[data-ask-submit]");
          await submit.click();
          await expect(page.locator("[data-ask-waiting]")).toBeVisible();

          const cancel = page.locator("[data-ask-cancel]");
          await cancel.focus();
          await page.keyboard.press("Space");

          await expect(page.locator("[data-ask-waiting]")).toHaveCount(0);
          await expect(page.locator("[data-ask-panel]")).toBeVisible();
          await expect(page.locator("[data-ask-panel] [data-ask-question]")).toHaveValue(QUESTION);
          await expect(page.locator("[data-ask-submit]")).toBeEnabled();
          await expect(page.locator("[data-ask-submit]")).not.toHaveAttribute("aria-disabled", "true");
          await expect(page.locator("[data-ask-layer]")).toBeVisible();
          await expect(page.locator("[data-ask-entry]")).toHaveAttribute("aria-pressed", "true");
          await page.waitForTimeout(400);
          await expect(page.locator("[data-ask-waiting]")).toHaveCount(0);
          await expect(page.locator("[data-ask-panel]")).toBeVisible();
          await expect(page.locator("[data-ask-layer]")).toBeVisible();
        } finally {
          held.release();
        }
      });
    }

    if (touch) {
      test("press then drag off 取消 does not cancel", async ({ page }) => {
        const held = await routeHeldAsk(page);
        try {
          await openAskPanel(page);
          const submitAt = await boxCenter(page, "[data-ask-submit]");
          await page.touchscreen.tap(submitAt.x, submitAt.y);
          await expect(page.locator("[data-ask-capture-preparing]")).toBeVisible();

          const cancel = page.locator("[data-ask-cancel]");
          const box = await cancel.boundingBox();
          if (!box) throw new Error("取消 has no box");
          const centerX = box.x + box.width / 2;
          const centerY = box.y + box.height / 2;
          const outsideX = box.x + box.width + 80;
          const client = await page.context().newCDPSession(page);
          const touchPoint = (x: number, y: number) => [{ x: Math.round(x), y: Math.round(y), id: 0 }];
          await client.send("Input.dispatchTouchEvent", {
            type: "touchStart",
            touchPoints: touchPoint(centerX, centerY),
          });
          await client.send("Input.dispatchTouchEvent", {
            type: "touchMove",
            touchPoints: touchPoint(outsideX, centerY),
          });
          await client.send("Input.dispatchTouchEvent", {
            type: "touchEnd",
            touchPoints: touchPoint(outsideX, centerY),
          });

          await expect(page.locator("[data-ask-waiting]")).toBeVisible();
          await expect(page.locator("[data-ask-panel]")).toBeVisible();
        } finally {
          held.release();
        }
      });
    }

    // One CDP session drives both CPU throttle and (on touch) dispatchTouchEvent.
    async function withStallSession(page: Page, run: (client: PointerClient) => Promise<void>) {
      const client = await page.context().newCDPSession(page);
      await client.send("Emulation.setCPUThrottlingRate", { rate: 4 });
      try {
        await run(client);
      } finally {
        await client.send("Emulation.setCPUThrottlingRate", { rate: 1 }).catch(() => {});
      }
    }

    for (let i = 1; i <= 10; i += 1) {
      test(`取消 held through capture stall, released 150ms after stall on button sends no ask run ${i}`, async ({
        page,
      }) => {
        requireStallHook();
        test.setTimeout(60_000);
        let askRequests = 0;
        await page.route("**/api/lecture/ask", async (route) => {
          askRequests += 1;
          await route.fulfill({
            status: 200,
            contentType: "application/x-ndjson",
            body: askStream("s1"),
          });
        });
        await openAskPanel(page);

        const cancelAt = await boxCenter(page, "[data-ask-cancel]");
        const submitAt = await boxCenter(page, "[data-ask-submit]");
        // Already on the button, so down()'s move is not a second trip across the page.
        if (!touch) await page.mouse.move(cancelAt.x, cancelAt.y);
        const attached = armedForStall(page);
        await withStallSession(page, async (client) => {
          await pressAt(page, submitAt.x, submitAt.y, touch);
          const preparing = page.locator("[data-ask-capture-preparing]");
          // The observer resolves on the mutation that attaches the row, before
          // the double rAF and the hook stall. A locator round-trip here would
          // block until the stall ended, and the press would miss it.
          await waitArmed(attached);
          await page.waitForTimeout(200);
          await down(page, client, cancelAt.x, cancelAt.y, touch);
          await waitStallEnd(page);
          const copyBeforePress = await readCopyBeforePress(page);
          await expectPressInsideStall(page);
          await expect(page.locator("[data-ask-cancel]")).toHaveAttribute("data-pressed", "");
          await expect(preparing).toHaveText(copyBeforePress);
          await page.waitForTimeout(150);
          await up(page, client, cancelAt.x, cancelAt.y, touch);
          await page.waitForTimeout(2500);
          expect(askRequests).toBe(0);
          await expect(page.locator("[data-ask-waiting]")).toHaveCount(0);
        });
      });
    }

    test("press 取消 during stall, slide off, release sends normally", async ({ page }) => {
      requireStallHook();
      test.setTimeout(60_000);
      let askRequests = 0;
      await page.route("**/api/lecture/ask", async (route) => {
        askRequests += 1;
        await route.fulfill({
          status: 200,
          contentType: "application/x-ndjson",
          body: askStream("s1"),
        });
      });
      await openAskPanel(page);

      const cancelAt = await boxCenter(page, "[data-ask-cancel]");
      const submitAt = await boxCenter(page, "[data-ask-submit]");
      const slideY = cancelAt.y - 120;
      expect(slideY).toBeGreaterThanOrEqual(1);
      expect(slideY).toBeLessThan(cancelAt.top);
      if (!touch) await page.mouse.move(cancelAt.x, cancelAt.y);

      const attached = armedForStall(page);
      await withStallSession(page, async (client) => {
        await pressAt(page, submitAt.x, submitAt.y, touch);
        await waitArmed(attached);
        await page.waitForTimeout(200);
        await down(page, client, cancelAt.x, cancelAt.y, touch);
        await waitStallEnd(page);
        await expectPressInsideStall(page);
        await moveTo(page, client, cancelAt.x, slideY, touch);
        await up(page, client, cancelAt.x, slideY, touch);
      });

      await expect.poll(() => askRequests, { timeout: 15_000 }).toBe(1);
      await expect(page.getByText(ANSWER_NARRATION)).toBeVisible({ timeout: 15_000 });
    });

    test("hold 取消 past 2s timeout sends, then release on button aborts", async ({ page }) => {
      requireStallHook();
      test.setTimeout(60_000);
      let askRequests = 0;
      let parkedRelease = () => {};
      const parked = new Promise<void>((resolve) => {
        parkedRelease = resolve;
      });
      let routeSawAbort = false;
      const failedTexts: string[] = [];
      page.on("requestfailed", (request) => {
        if (!request.url().includes("/api/lecture/ask")) return;
        failedTexts.push(request.failure()?.errorText ?? "");
      });
      await page.route("**/api/lecture/ask", async (route) => {
        askRequests += 1;
        const request = route.request();
        try {
          // Hold the response until the route is aborted or the test releases it.
          await parked;
          await route.fulfill({
            status: 200,
            contentType: "application/x-ndjson",
            body: askStream("s1"),
          });
        } catch {
          routeSawAbort = true;
        }
        if (request.failure()) routeSawAbort = true;
      });

      try {
        await openAskPanel(page);
        const cancelAt = await boxCenter(page, "[data-ask-cancel]");
        const submitAt = await boxCenter(page, "[data-ask-submit]");
        if (!touch) await page.mouse.move(cancelAt.x, cancelAt.y);

        const attached = armedForStall(page);
        await withStallSession(page, async (client) => {
          await pressAt(page, submitAt.x, submitAt.y, touch);
          const preparing = page.locator("[data-ask-capture-preparing]");
          await waitArmed(attached);
          await page.waitForTimeout(200);
          await down(page, client, cancelAt.x, cancelAt.y, touch);
          await waitStallEnd(page);
          const copyBeforePress = await readCopyBeforePress(page);
          await expectPressInsideStall(page);
          await page.waitForTimeout(2600);
          expect(askRequests).toBe(1);
          // ask-panel.tsx has no answer-dot marker. Waiting is [data-ask-waiting];
          // an in-flight answer body is [data-testid=ask-preview] in step-answers.tsx.
          await expect(page.locator("[data-ask-waiting]")).toHaveCount(0);
          await expect(page.locator("[data-testid='ask-preview']")).toHaveCount(0);
          await expect(page.locator("[data-ask-cancel]")).toHaveAttribute("data-pressed", "");
          await expect(preparing).toHaveText(copyBeforePress);

          await installFlashObserver(page);
          await up(page, client, cancelAt.x, cancelAt.y, touch);
        });

        await expect.poll(() => failedTexts.length, { timeout: 10_000 }).toBeGreaterThan(0);
        expect(failedTexts.some((text) => /abort/i.test(text)) || routeSawAbort).toBe(true);
        await expect(page.getByText(ANSWER_NARRATION)).toHaveCount(0);
        await expect(page.locator("[data-ask-error]")).toHaveCount(0);
        await expect(page.locator("[data-testid='step-answers'] [role='alert']")).toHaveCount(0);
        expect(await readFlashes(page)).toEqual([]);
        await expectClosedLikeCancel(page);
      } finally {
        parkedRelease();
      }
    });

    for (let i = 1; i <= 10; i += 1) {
      test(`forced stall: 取消 pressed mid-stall sends no ask run ${i}`, async ({ page }) => {
        requireStallHook();
        test.setTimeout(60_000);
        let askRequests = 0;
        const failedTexts: string[] = [];
        page.on("requestfailed", (request) => {
          if (!request.url().includes("/api/lecture/ask")) return;
          failedTexts.push(request.failure()?.errorText ?? "");
        });
        await page.route("**/api/lecture/ask", async (route) => {
          askRequests += 1;
          await new Promise((resolve) => {
            setTimeout(resolve, 15_000);
          });
          if (route.request().failure()) return;
          await route.fulfill({
            status: 200,
            contentType: "application/x-ndjson",
            body: askStream("s1"),
          });
        });
        await openAskPanel(page);

        const cancelAt = await boxCenter(page, "[data-ask-cancel]");
        const submitAt = await boxCenter(page, "[data-ask-submit]");
        if (!touch) await page.mouse.move(cancelAt.x, cancelAt.y);
        const attached = armedForStall(page);
        await withStallSession(page, async (client) => {
          await pressAt(page, submitAt.x, submitAt.y, touch);
          // The press lands inside the compile-time stall (ASK_TEST_STALL_HOOK),
          // which runs in the same task as domToCanvas. The attach wait is the
          // observer installed before submit; no renderer round-trip follows it.
          await waitArmed(attached);
          await page.waitForTimeout(200);
          await down(page, client, cancelAt.x, cancelAt.y, touch);
          await page.waitForTimeout(150);
          await up(page, client, cancelAt.x, cancelAt.y, touch);
          await waitStallEnd(page);
          await expectPressInsideStall(page);
        });

        await expect.poll(
          () => (askRequests === 0 || failedTexts.length > 0 ? "closed" : "pending"),
          { timeout: 10_000 },
        ).toBe("closed");
        await expect(page.getByText("播放回答")).toHaveCount(0);
        await expect(page.getByText(ANSWER_NARRATION)).toHaveCount(0);
        await expect(page.locator("[data-ask-error]")).toHaveCount(0);
        await expect(page.locator("[data-testid='step-answers'] [role='alert']")).toHaveCount(0);
        await expect(page.locator("[data-answer-mark]")).toHaveCount(0);
      });
    }
  });
}

installStatusStability(1280, false);
installStatusStability(390, true);

/**
 * Prod path (no stall hook). Press 取消 within 150ms of submit and release
 * on the button. Either cancel wins before send, or the request is aborted
 * with no 回答中, no reminder red dot, and no chip/hint flicker.
 */
function installNaturalCancel(width: number, touch: boolean) {
  const label = width === 1280 ? "Desktop" : "390";

  test.describe(`natural cancel ${label} ${width}`, () => {
    test.use(
      width === 1280
        ? { viewport: { width: 1280, height: 800 } }
        : {
            hasTouch: true,
            isMobile: true,
            deviceScaleFactor: 3,
            viewport: { width: 390, height: 844 },
          },
    );

    for (let i = 1; i <= 10; i += 1) {
      test(`press 取消 within 150ms of submit run ${i}`, async ({ page }) => {
        test.setTimeout(60_000);
        let askRequests = 0;
        let routeSawAbort = false;
        const failedTexts: string[] = [];
        page.on("requestfailed", (request) => {
          if (!request.url().includes("/api/lecture/ask")) return;
          failedTexts.push(request.failure()?.errorText ?? "");
        });
        await page.route("**/api/lecture/ask", async (route) => {
          askRequests += 1;
          try {
            await new Promise((resolve) => {
              setTimeout(resolve, 15_000);
            });
            if (route.request().failure()) {
              routeSawAbort = true;
              return;
            }
            await route.fulfill({
              status: 200,
              contentType: "application/x-ndjson",
              body: askStream("s1"),
            });
          } catch {
            routeSawAbort = true;
          }
        });

        await openAskPanel(page);
        const cancelAt = await boxCenter(page, "[data-ask-cancel]");
        const submitAt = await boxCenter(page, "[data-ask-submit]");
        const client = await page.context().newCDPSession(page);
        if (!touch) await page.mouse.move(cancelAt.x, cancelAt.y);

        const submittedAt = Date.now();
        await pressAt(page, submitAt.x, submitAt.y, touch);
        // After submit: the chips are already on screen, so an add or a
        // remove from here is a flicker. The observer ignores a removal
        // that is the whole panel unmounting on a successful cancel.
        await installChipHintObserver(page);
        await down(page, client, cancelAt.x, cancelAt.y, touch);
        const pressedAt = Date.now();
        expect(pressedAt - submittedAt).toBeLessThanOrEqual(150);
        await up(page, client, cancelAt.x, cancelAt.y, touch);

        // Either the press cancelled before send, or the request went out and
        // was aborted. A request that stays in flight is neither.
        await expect
          .poll(
            () => (askRequests === 0 || failedTexts.length > 0 || routeSawAbort ? "settled" : "pending"),
            { timeout: 10_000 },
          )
          .toBe("settled");

        await expect(page.getByText("回答中")).toHaveCount(0);
        await expect(page.locator("[data-answer-mark]")).toHaveCount(0);
        await expect(page.getByText(ANSWER_NARRATION)).toHaveCount(0);
        expect(await readChipHintChanges(page)).toEqual([]);

        if (askRequests === 0) {
          await expectClosedLikeCancel(page);
          return;
        }
        expect(failedTexts.some((text) => /abort/i.test(text)) || routeSawAbort).toBe(true);
      });
    }
  });
}

installNaturalCancel(1280, false);
installNaturalCancel(390, true);
