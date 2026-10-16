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

/**
 * Scroll and the stage's top edge must stay put for 2 animation frames
 * before a box is measured and a drag starts. A layout shift between the
 * measure and the gesture lands the drag on the wrong pixels.
 */
async function waitScrollStill(page: Page) {
  // Predicate must return a boolean. A promise is truthy, so waitForFunction
  // would resolve on the first poll. polling: "raf" is the frame clock.
  await page.evaluate(() => {
    delete (window as unknown as { __askScrollStill?: unknown }).__askScrollStill;
  });
  await page.waitForFunction(
    () => {
      const win = window as unknown as {
        __askScrollStill?: { y: number; top: number; stable: number };
      };
      const stage = document.querySelector("[data-ask-stage]");
      if (!stage) {
        delete win.__askScrollStill;
        return false;
      }
      const y = window.scrollY;
      const top = stage.getBoundingClientRect().top;
      const prev = win.__askScrollStill;
      if (!prev) {
        win.__askScrollStill = { y, top, stable: 0 };
        return false;
      }
      const stable = y === prev.y && top === prev.top ? prev.stable + 1 : 0;
      win.__askScrollStill = { y, top, stable };
      if (stable >= 2) {
        delete win.__askScrollStill;
        return true;
      }
      return false;
    },
    undefined,
    { timeout: 3000, polling: "raf" },
  );
}

async function enterSelection(page: Page) {
  const button = entry(page);
  await expect(button).toBeVisible();
  await expect(button).toBeEnabled();
  await expect(button).not.toHaveAttribute("aria-disabled", "true");
  await button.click();
  await expect(page.locator("[data-ask-layer]")).toBeVisible();
  await expect(button).toHaveAttribute("aria-pressed", "true");
  await waitScrollStill(page);
}

async function dragOnStage(page: Page) {
  const stage = page.locator("[data-ask-stage]");
  const viz = stage.locator('[data-ask-id="viz:s1"]').first();
  await expect(viz).toBeVisible();
  await waitScrollStill(page);
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
 * A hook build sets NEXT_PUBLIC_ASK_TEST_BUILD=1 and
 * NEXT_PUBLIC_ASK_TEST_STALL_MS=1500. Next inlines both next to domToCanvas.
 * A release build (flag unset) tree-shakes the loop, so those tests skip
 * instead of racing a short capture.
 */
const STALL_HOOK_BUILD = process.env.NEXT_PUBLIC_ASK_TEST_BUILD === "1";
const STALL_HOOK_MS = Number(process.env.NEXT_PUBLIC_ASK_TEST_STALL_MS);
const stallHookOn = STALL_HOOK_BUILD && Number.isFinite(STALL_HOOK_MS) && STALL_HOOK_MS > 0;

function requireStallHook() {
  test.skip(
    !stallHookOn,
    "requires a hook build: NEXT_PUBLIC_ASK_TEST_BUILD=1 NEXT_PUBLIC_ASK_TEST_STALL_MS=1500",
  );
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
 * before the pre-capture paint and the compile-time stall, and stores the preparing
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
 * Date.now() captured before the pointer goes down. That is the issue time.
 * A read taken after down() awaits the stall and is not the issue time.
 * Kept on the test annotation so it does not round-trip to the renderer
 * while the main thread is inside the stall. Not compared with longTaskEnd
 * or sentAt.
 */
function notePressedAt(pressedAt: number) {
  test.info().annotations.push({ type: "pressedAt", description: String(pressedAt) });
}

/**
 * The press hit 取消. CDP stamps pointerdown.timeStamp when the renderer
 * dequeues the event, which is after the stall, so the decision is the hit
 * and not firstPointerDownTs compared with longTaskEnd. A hit that cancelled
 * before send leaves the panel closed and no ask. A hit that landed after
 * the fetch aborted the request.
 */
async function expectCancelHit(page: Page, askRequests: () => number, failed: () => string[]) {
  await expect
    .poll(() => (askRequests() === 0 || failed().length > 0 ? "settled" : "pending"), { timeout: 10_000 })
    .toBe("settled");
  await expect(page.getByText("播放回答")).toHaveCount(0);
  if (askRequests() > 0) {
    expect(failed().some((text) => /abort/i.test(text))).toBe(true);
  }
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
          await page.waitForTimeout(3000);
          expect(askRequests).toBe(0);
          await expectCancelHit(page, () => askRequests, () => []);
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
          // the pre-capture paint and the hook stall. A locator round-trip here would
          // block until the stall ended, and the press would miss it.
          await waitArmed(attached);
          await page.waitForTimeout(200);
          const pressedAt = Date.now();
          await down(page, client, cancelAt.x, cancelAt.y, touch);
          notePressedAt(pressedAt);
          await waitStallEnd(page);
          const copyBeforePress = await readCopyBeforePress(page);
          await expect(page.locator("[data-ask-cancel]")).toHaveAttribute("data-pressed", "");
          await expect(preparing).toHaveText(copyBeforePress);
          await page.waitForTimeout(150);
          await up(page, client, cancelAt.x, cancelAt.y, touch);
          await page.waitForTimeout(2500);
          expect(askRequests).toBe(0);
          await expectCancelHit(page, () => askRequests, () => []);
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
        const pressedAt = Date.now();
        await down(page, client, cancelAt.x, cancelAt.y, touch);
        notePressedAt(pressedAt);
        await waitStallEnd(page);
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
          const pressedAt = Date.now();
          await down(page, client, cancelAt.x, cancelAt.y, touch);
          notePressedAt(pressedAt);
          await waitStallEnd(page);
          const copyBeforePress = await readCopyBeforePress(page);
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
          const pressedAt = Date.now();
          await down(page, client, cancelAt.x, cancelAt.y, touch);
          notePressedAt(pressedAt);
          await page.waitForTimeout(150);
          await up(page, client, cancelAt.x, cancelAt.y, touch);
          await waitStallEnd(page);
        });

        await expectCancelHit(page, () => askRequests, () => failedTexts);
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

/** Capture-phase pointerdown record. ts is the renderer clock (event.timeStamp). */
type AskPointerDown = { ts: number; pointerType: string; inCancel: boolean };

/** Capture-phase pointerup record. ts is event.timeStamp. */
type AskPointerUp = { ts: number; inCancel: boolean };

/** One [data-ask-panel] insertion or removal. t is performance.now(). */
type AskPanelEvent = { type: "add" | "remove"; t: number };

type AskCancelProbe = {
  __askPointerDownTs?: AskPointerDown[];
  __askPointerUpTs?: AskPointerUp[];
  /** performance.now() when [data-ask-panel] first leaves the document. */
  __askPanelGoneAt?: number;
  /** Every add and remove of [data-ask-panel] from before submit until the test ends. */
  __askPanelEvents?: AskPanelEvent[];
};

/** True when a remove of [data-ask-panel] is followed later by an add. */
function panelWasReadded(seq: AskPanelEvent[]): boolean {
  let removed = false;
  for (const event of seq) {
    if (event.type === "remove") removed = true;
    else if (removed) return true;
  }
  return false;
}

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
        // 390 records the cancel pointerdown against the stall mark. That
        // mark exists only in a hook build; a release build has no interval
        // to assert against.
        if (width === 390) requireStallHook();
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

        // Capture-phase records for both pointerdowns and pointerups.
        // event.timeStamp is the renderer clock, which is what the stall
        // marks use. pointerType and inCancel (target inside [data-ask-cancel])
        // distinguish the cancel press from the submit press. The same
        // evaluate, still before the submit tap, installs a MutationObserver
        // and leaves it connected for the whole test. It records every add
        // and remove of [data-ask-panel] with performance.now(), and stamps
        // __askPanelGoneAt the first time the panel is absent. It does not
        // disconnect on that first removal: a later re-add stays in the
        // sequence. The close stamp is taken when the removal commits, not
        // when a later evaluate round-trips. Listeners are installed before
        // either gesture so the submit press is included.
        await page.evaluate(() => {
          const win = window as unknown as AskCancelProbe;
          win.__askPointerDownTs = [];
          win.__askPointerUpTs = [];
          delete win.__askPanelGoneAt;
          const events: AskPanelEvent[] = [];
          win.__askPanelEvents = events;
          const inCancel = (event: Event) =>
            !!(event.target instanceof Element && event.target.closest("[data-ask-cancel]"));
          document.addEventListener(
            "pointerdown",
            (event) => {
              win.__askPointerDownTs?.push({
                ts: event.timeStamp,
                pointerType: event.pointerType,
                inCancel: inCancel(event),
              });
            },
            true,
          );
          document.addEventListener(
            "pointerup",
            (event) => {
              win.__askPointerUpTs?.push({
                ts: event.timeStamp,
                inCancel: inCancel(event),
              });
            },
            true,
          );
          const notePanel = (node: Node, type: "add" | "remove") => {
            if (!(node instanceof Element)) return;
            // The panel itself, or the panel inside a removed/added ancestor.
            if (node.matches("[data-ask-panel]") || node.querySelector("[data-ask-panel]")) {
              events.push({ type, t: performance.now() });
            }
            node.querySelectorAll("[data-ask-panel]").forEach(() => {
              events.push({ type, t: performance.now() });
            });
          };
          const observer = new MutationObserver((records) => {
            for (const record of records) {
              for (const node of record.removedNodes) notePanel(node, "remove");
              for (const node of record.addedNodes) notePanel(node, "add");
            }
            // Once per callback, after every record in the batch: stamp the
            // first time the panel is gone, whether it was the removed node
            // or a descendant of one.
            if (win.__askPanelGoneAt == null && document.querySelector("[data-ask-panel]") == null) {
              win.__askPanelGoneAt = performance.now();
            }
          });
          observer.observe(document.body, { childList: true, subtree: true });
        });
        // Chips are already on screen. An add or a remove from here is a
        // flicker. The observer ignores a removal that is the whole panel
        // unmounting on a successful cancel.
        await installChipHintObserver(page);

        // Do not await the submit before the cancel, and do not use a fixed
        // delay. On 390, pressAt is touchscreen.tap and returns only after
        // the renderer dequeues it, which is after the capture stall. The
        // stall is a synchronous busy loop that marks ASK_TEST_STALL_HOOK at
        // its start, so an in-page read cannot see that mark until the loop
        // ends. A Node-side evaluate that loses a 40ms race means the main
        // thread is blocked and the stall is in progress: touchStart and
        // touchEnd are both queued in that turn, still without awaiting
        // submit. 1280 keeps mouse.down() in this turn and releases later.
        const submitted = pressAt(page, submitAt.x, submitAt.y, touch);
        if (width === 390) {
          const deadline = Date.now() + 5_000;
          let touchStarted: Promise<unknown> | undefined;
          let touchEnded: Promise<unknown> | undefined;
          while (Date.now() < deadline && !touchStarted) {
            const pending = page.evaluate(
              () => performance.getEntriesByName("ASK_TEST_STALL_HOOK", "mark").length,
            );
            let timer: ReturnType<typeof setTimeout> | undefined;
            const blocked = new Promise<"blocked">((resolve) => {
              timer = setTimeout(() => resolve("blocked"), 40);
            });
            const raced = await Promise.race([
              pending.then((length) => ({ kind: "eval" as const, length })),
              blocked.then(() => ({ kind: "blocked" as const })),
            ]);
            clearTimeout(timer);
            if (raced.kind === "eval") {
              if (raced.length > 0) {
                await submitted.catch(() => {});
                throw new Error(
                  `stall already ended before the cancel touchStart (ASK_TEST_STALL_HOOK mark count ${raced.length}); the 390 press missed the stall`,
                );
              }
              continue;
            }
            // 40ms won: the renderer main thread is blocked (stall in
            // progress). Queue touchStart and touchEnd in this turn, before
            // awaiting the evaluate that is still behind the busy loop.
            // Awaiting touchStart or submit would hold the release until the
            // stall ended. 1280 releases later with up().
            touchStarted = client.send("Input.dispatchTouchEvent", {
              type: "touchStart",
              touchPoints: touchPoint(cancelAt.x, cancelAt.y),
            });
            touchEnded = client.send("Input.dispatchTouchEvent", {
              type: "touchEnd",
              touchPoints: touchPoint(cancelAt.x, cancelAt.y),
            });
            await pending;
          }
          if (!touchStarted || !touchEnded) {
            await submitted.catch(() => {});
            throw new Error("renderer did not block on ASK_TEST_STALL_HOOK within 5s");
          }
          await Promise.all([submitted, touchStarted, touchEnded]);
        } else {
          const cancelDown = page.mouse.down();
          await Promise.all([submitted, cancelDown]);
        }

        if (width === 390) {
          // The removal observer stamps __askPanelGoneAt when the panel
          // leaves. Wait for that number before reading it. A timeout means
          // the panel never left; the assertion below then fails.
          await page
            .waitForFunction(
              () =>
                typeof (window as unknown as { __askPanelGoneAt?: unknown }).__askPanelGoneAt ===
                "number",
              undefined,
              { timeout: 2000, polling: "raf" },
            )
            .catch(() => {});
          const stamp = await page.evaluate(() => {
            const marks = performance.getEntriesByName("ASK_TEST_STALL_HOOK", "mark");
            const measures = performance.getEntriesByName("ASK_TEST_STALL_HOOK", "measure");
            const start = marks[0]?.startTime;
            const duration = measures[0]?.duration;
            const win = window as unknown as AskCancelProbe;
            return {
              start,
              duration,
              downs: win.__askPointerDownTs ?? [],
              ups: win.__askPointerUpTs ?? [],
              panelGoneAt: win.__askPanelGoneAt,
              events: win.__askPanelEvents ?? [],
            };
          });
          expect(stamp.start, "stall mark").toEqual(expect.any(Number));
          expect(stamp.duration, "stall measure").toBeGreaterThan(0);
          // downs[0] is the submit pointerdown, downs[1] is the cancel.
          const downs = stamp.downs;
          expect(downs[1].pointerType, "cancel pointerType").toBe("touch");
          expect(downs[1].inCancel, "cancel target").toBe(true);
          const cancelTs = downs[1].ts;
          expect(cancelTs, "cancel pointerdown timeStamp").toEqual(expect.any(Number));
          const stallStart = stamp.start as number;
          const stallEnd = stallStart + (stamp.duration as number);
          expect(cancelTs).toBeGreaterThanOrEqual(stallStart);
          expect(cancelTs).toBeLessThanOrEqual(stallEnd);
          // Close is the in-page removal stamp minus t0. t0 is the cancel
          // pointerup timeStamp, or stallEnd when that pointerup falls inside
          // [stallStart, stallEnd]. Both clocks are the renderer's. A
          // page.evaluate that starts after Node has awaited touchEnd measures
          // the Playwright round-trip instead of this gap.
          const cancelUp = stamp.ups.find((entry) => entry.inCancel);
          expect(cancelUp?.ts, "cancel pointerup timeStamp").toEqual(expect.any(Number));
          const release = cancelUp?.ts as number;
          expect(release).toBeGreaterThanOrEqual(cancelTs);
          expect(stamp.panelGoneAt, "panel removed during cancel").toEqual(expect.any(Number));
          const panelGoneAt = stamp.panelGoneAt as number;
          // Uma/Leo: t0 is the cancel pointerup timeStamp. When that stamp
          // falls inside [stallStart, stallEnd] the pointerup could not run
          // until the stall ended, so t0 is stallEnd. The render that runs
          // after the stall counts toward panelGoneAt - t0.
          const pointerUpInStall = release >= stallStart && release <= stallEnd;
          const t0 = pointerUpInStall ? stallEnd : release;
          const t0src = pointerUpInStall ? "stallEnd" : "pointerup";
          const paint = panelGoneAt - t0;
          const seq = stamp.events;
          console.log(
            `CANCEL390 round=${i} paint=${paint}ms t0=${t0src} release=${release} stallEnd=${stallEnd} events=${JSON.stringify(seq)}`,
          );
          expect(paint).toBeLessThan(100);
          // The press landed inside the stall, so the ask never goes out.
          expect(askRequests).toBe(0);
          expect(panelWasReadded(seq), `panel was removed and re-added: ${JSON.stringify(seq)}`).toBe(false);
          await expect(page.locator("[data-ask-panel]")).toHaveCount(0);
        }

        // 390 already released via touchEnd while the stall was in progress.
        // A second touchEnd has no active point. 1280 is still mouse-down.
        if (width !== 390) await up(page, client, cancelAt.x, cancelAt.y, touch);

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

        if (width === 390) {
          const seq = await page.evaluate(() => {
            const win = window as unknown as AskCancelProbe;
            return win.__askPanelEvents ?? [];
          });
          expect(panelWasReadded(seq), `panel was removed and re-added: ${JSON.stringify(seq)}`).toBe(false);
          await expect(page.locator("[data-ask-panel]")).toHaveCount(0);
        }

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

/**
 * Prod path (no stall hook). The ask response is held so the panel stays in
 * the waiting phase (request seen, no first token). 300ms later, press and
 * release 取消. The request aborts and the panel closes with no answer, no
 * red dot, and no error. cancelPaintAfterReleaseMs is pointerup → the next
 * frame after the cancelled state.
 */
function installWaitingPhaseCancel(width: number, touch: boolean, throttle: number) {
  const label = width === 1280 ? "Desktop" : "390";
  const cpu = throttle === 1 ? "normal CPU" : "4x CPU";

  test.describe(`waiting-phase cancel ${label} ${width} ${cpu}`, () => {
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

    test.beforeEach(async ({ page }) => {
      await page.addInitScript(() => {
        (window as unknown as { __ASK_TIMING__?: object }).__ASK_TIMING__ = {};
      });
    });

    for (let i = 1; i <= 6; i += 1) {
      test(`press 取消 300ms after the request is seen run ${i}`, async ({ page }) => {
        test.setTimeout(60_000);
        let askRequests = 0;
        let seen = false;
        let releaseHold = () => {};
        const hold = new Promise<void>((resolve) => {
          releaseHold = resolve;
        });
        let routeSawAbort = false;
        const failedTexts: string[] = [];
        page.on("requestfailed", (request) => {
          if (!request.url().includes("/api/lecture/ask")) return;
          failedTexts.push(request.failure()?.errorText ?? "");
        });
        await page.route("**/api/lecture/ask", async (route) => {
          askRequests += 1;
          seen = true;
          const request = route.request();
          try {
            await hold;
            if (request.failure()) {
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

        const client = await page.context().newCDPSession(page);
        try {
          if (throttle !== 1) {
            await client.send("Emulation.setCPUThrottlingRate", { rate: throttle });
          }
          await openAskPanel(page);
          const cancelAt = await boxCenter(page, "[data-ask-cancel]");
          const submitAt = await boxCenter(page, "[data-ask-submit]");
          if (!touch) await page.mouse.move(cancelAt.x, cancelAt.y);
          await pressAt(page, submitAt.x, submitAt.y, touch);
          await expect.poll(() => seen, { timeout: 15_000 }).toBe(true);
          await expect(page.locator("[data-ask-waiting]")).toBeVisible();
          await page.waitForTimeout(300);
          // 390: sample the selection box and the bottom chip bar on the cancel
          // frame (first rAF after pointerup/touchend) and the next 2 rAFs.
          if (width === 390) {
            await page.evaluate(() => {
              type Box = { x: number; y: number; width: number; height: number };
              const win = window as unknown as {
                __rects390?: { selection: Box | null; bar: Box | null }[];
              };
              delete win.__rects390;
              const read = (selector: string): Box | null => {
                const box = document.querySelector(selector)?.getBoundingClientRect();
                return box ? { x: box.x, y: box.y, width: box.width, height: box.height } : null;
              };
              const onEnd = () => {
                document.removeEventListener("pointerup", onEnd, true);
                document.removeEventListener("touchend", onEnd, true);
                const samples: { selection: Box | null; bar: Box | null }[] = [];
                const tick = () => {
                  samples.push({
                    selection: read("[data-ask-selection]"),
                    bar: read("[data-ask-bottom-bar]"),
                  });
                  if (samples.length < 3) requestAnimationFrame(tick);
                  else win.__rects390 = samples;
                };
                requestAnimationFrame(tick);
              };
              document.addEventListener("pointerup", onEnd, true);
              document.addEventListener("touchend", onEnd, true);
            });
          }
          await down(page, client, cancelAt.x, cancelAt.y, touch);
          await up(page, client, cancelAt.x, cancelAt.y, touch);
          if (width === 390) {
            type Box = { x: number; y: number; width: number; height: number };
            type Rects = { selection: Box | null; bar: Box | null }[];
            const readRects = () =>
              page.evaluate(() => {
                const win = window as unknown as { __rects390?: Rects };
                return win.__rects390 ?? null;
              });
            await expect.poll(readRects, { timeout: 2_000 }).not.toBeNull();
            const rects = await readRects();
            console.log(`RECTS390 ${JSON.stringify(rects)}`);
            expect(rects, "RECTS390 samples").toHaveLength(3);
            const near = (a: Box, b: Box) =>
              Math.abs(a.x - b.x) <= 0.5 &&
              Math.abs(a.y - b.y) <= 0.5 &&
              Math.abs(a.width - b.width) <= 0.5 &&
              Math.abs(a.height - b.height) <= 0.5;
            for (const key of ["selection", "bar"] as const) {
              const boxes = (rects ?? []).map((sample) => sample[key]);
              const [a, b, c] = boxes;
              expect(a != null && b != null && c != null, `${key} present on all 3 frames`).toBe(true);
              if (a && b && c) {
                expect(near(a, b) && near(a, c), `${key} rect stable across the cancel frames`).toBe(true);
              }
            }
          }

          await expect
            .poll(() => (failedTexts.length > 0 || routeSawAbort ? "aborted" : "pending"), { timeout: 10_000 })
            .toBe("aborted");
          expect(askRequests).toBe(1);
          expect(failedTexts.some((text) => /abort/i.test(text)) || routeSawAbort).toBe(true);
          await expectClosedLikeCancel(page);
          await expect(page.getByText(ANSWER_NARRATION)).toHaveCount(0);
          await expect(page.locator("[data-answer-mark]")).toHaveCount(0);
          await expect(page.getByText("播放回答")).toHaveCount(0);
          await expect(page.locator("[data-testid='ask-preview']")).toHaveCount(0);

          // pointerup → the frame after the cancelled state. The probe writes
          // it on that frame, so poll until the mark exists, then bound it.
          await expect
            .poll(
              () =>
                page.evaluate(() => {
                  const probe = (
                    window as unknown as { __ASK_TIMING__?: { cancelPaintAfterReleaseMs?: number } }
                  ).__ASK_TIMING__;
                  const ms = probe?.cancelPaintAfterReleaseMs;
                  return ms == null ? "pending" : ms <= 100 ? "ok" : `slow:${ms}`;
                }),
              { timeout: 2_000 },
            )
            .toBe("ok");
        } finally {
          releaseHold();
          if (throttle !== 1) {
            await client.send("Emulation.setCPUThrottlingRate", { rate: 1 }).catch(() => {});
          }
        }
      });
    }
  });
}

installWaitingPhaseCancel(1280, false, 1);
installWaitingPhaseCancel(390, true, 1);
installWaitingPhaseCancel(1280, false, 4);
installWaitingPhaseCancel(390, true, 4);

/**
 * 取消 must not move from the ask press through preparing, sending, and
 * waiting. The window ends when the answer starts streaming and the panel
 * closes; --ask-player-bar-h resets with that close.
 */
function installCancelStaysPut(width: number, touch: boolean) {
  const label = width === 1280 ? "Desktop" : "390";

  test.describe(`取消 stays put ${label} ${width}`, () => {
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

    test("取消 y stays within 1px from the ask press until the answer streams", async ({ page }) => {
      test.setTimeout(60_000);
      let releaseHold = () => {};
      const hold = new Promise<void>((resolve) => {
        releaseHold = resolve;
      });
      await page.route("**/api/lecture/ask", async (route) => {
        await hold;
        await route.fulfill({
          status: 200,
          contentType: "application/x-ndjson",
          body: askStream("s1"),
        });
      });

      await openAskPanel(page);
      // Stamp 取消's y on the ask pointerdown, and keep a frame-by-frame
      // record from that press until the answer is released.
      await page.evaluate(() => {
        const win = window as unknown as {
          __cancelYAtAskPress?: number;
          __cancelYs?: number[];
          __cancelRaf?: number;
        };
        win.__cancelYs = [];
        const sample = () => {
          const box = document.querySelector("[data-ask-panel] [data-ask-cancel]")?.getBoundingClientRect();
          if (box && box.height > 0) win.__cancelYs?.push(box.y);
        };
        document.addEventListener(
          "pointerdown",
          (event) => {
            const target = event.target;
            if (!(target instanceof Element) || !target.closest("[data-ask-submit]")) return;
            const box = document.querySelector("[data-ask-cancel]")?.getBoundingClientRect();
            if (box) win.__cancelYAtAskPress = box.y;
          },
          true,
        );
        const tick = () => {
          sample();
          win.__cancelRaf = requestAnimationFrame(tick);
        };
        win.__cancelRaf = requestAnimationFrame(tick);
      });

      const client = await page.context().newCDPSession(page);
      const submitAt = await boxCenter(page, "[data-ask-submit]");
      // 4× keeps the preparing row on screen long enough to sample. The y
      // check itself does not depend on the throttle.
      await client.send("Emulation.setCPUThrottlingRate", { rate: 4 });
      try {
        await down(page, client, submitAt.x, submitAt.y, touch);
        await up(page, client, submitAt.x, submitAt.y, touch);

        const yAtPress = await page.evaluate(
          () => (window as unknown as { __cancelYAtAskPress?: number }).__cancelYAtAskPress,
        );
        expect(yAtPress).toEqual(expect.any(Number));

        await expect(page.locator("[data-ask-capture-preparing]")).toBeVisible();
        await expect(page.locator("[data-ask-waiting]")).toBeVisible({ timeout: 15_000 });
        // Still waiting: the response is held, so no token has streamed.
        await page.waitForTimeout(200);

        const samples = await page.evaluate(() => {
          const win = window as unknown as { __cancelRaf?: number; __cancelYs?: number[] };
          if (win.__cancelRaf != null) cancelAnimationFrame(win.__cancelRaf);
          return win.__cancelYs ?? [];
        });
        expect(samples.length).toBeGreaterThan(0);
        const off = samples.filter((y) => Math.abs(y - (yAtPress as number)) > 1);
        expect(off, `取消 y left ${yAtPress} by more than 1px`).toEqual([]);

        const playerWhileOpen = await page.evaluate(() =>
          document.documentElement.style.getPropertyValue("--ask-player-bar-h").trim(),
        );
        if (width === 390) expect(Number.parseFloat(playerWhileOpen)).toBeGreaterThan(0);
      } finally {
        await client.send("Emulation.setCPUThrottlingRate", { rate: 1 }).catch(() => {});
      }

      releaseHold();
      await expect(page.locator("[data-ask-panel]")).toHaveCount(0, { timeout: 15_000 });
      const playerAfter = await page.evaluate(() =>
        document.documentElement.style.getPropertyValue("--ask-player-bar-h").trim(),
      );
      expect(playerAfter === "0px" || playerAfter === "").toBe(true);
    });
  });
}

installCancelStaysPut(1280, false);
installCancelStaysPut(390, true);

/**
 * 390 only. When the answer finishes and playing starts, 取消 (if it is
 * still on screen) and [data-ask-bottom-bar] (if it is still on screen)
 * each keep their y within 1px. The panel unmounts at playing, so the
 * closed state is what this asserts: no 取消, no bottom bar.
 */
function installPlayingTransitionStable() {
  test.describe("390 playing transition", () => {
    test.use({
      hasTouch: true,
      isMobile: true,
      deviceScaleFactor: 3,
      viewport: { width: 390, height: 844 },
    });

    test("取消 and the bottom bar keep their y when the answer finishes", async ({ page }) => {
      test.setTimeout(60_000);
      let releaseAnswer = () => {};
      const answer = new Promise<void>((resolve) => {
        releaseAnswer = resolve;
      });
      await page.route("**/api/lecture/ask", async (route) => {
        await answer;
        await route.fulfill({
          status: 200,
          contentType: "application/x-ndjson",
          body: askStream("s1"),
        });
      });

      await openAskPanel(page);
      const client = await page.context().newCDPSession(page);
      const submitAt = await boxCenter(page, "[data-ask-submit]");
      await down(page, client, submitAt.x, submitAt.y, true);
      await up(page, client, submitAt.x, submitAt.y, true);
      await expect(page.locator("[data-ask-waiting]")).toBeVisible({ timeout: 15_000 });

      // The answer has not been released. Stamp both boxes, then sample
      // every frame across the release.
      await page.evaluate(() => {
        const win = window as unknown as {
          __playYs?: { cancel: Array<number | null>; bar: Array<number | null> };
          __playRaf?: number;
        };
        win.__playYs = { cancel: [], bar: [] };
        const yOf = (selector: string) => {
          const box = document.querySelector(selector)?.getBoundingClientRect();
          if (!box || box.height <= 0) return null;
          return box.y;
        };
        const tick = () => {
          win.__playYs?.cancel.push(yOf("[data-ask-cancel]"));
          win.__playYs?.bar.push(yOf("[data-ask-bottom-bar]"));
          win.__playRaf = requestAnimationFrame(tick);
        };
        tick();
      });

      const before = await page.evaluate(() => {
        const yOf = (selector: string) => {
          const box = document.querySelector(selector)?.getBoundingClientRect();
          if (!box || box.height <= 0) return null;
          return box.y;
        };
        return { cancel: yOf("[data-ask-cancel]"), bar: yOf("[data-ask-bottom-bar]") };
      });

      releaseAnswer();
      await expect(page.getByText(ANSWER_NARRATION)).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText("播放回答")).toBeVisible({ timeout: 15_000 });

      const samples = await page.evaluate(() => {
        const win = window as unknown as {
          __playRaf?: number;
          __playYs?: { cancel: Array<number | null>; bar: Array<number | null> };
        };
        if (win.__playRaf != null) cancelAnimationFrame(win.__playRaf);
        return win.__playYs ?? { cancel: [], bar: [] };
      });

      // The panel is gone once playing starts, and the chip bar only exists
      // during selecting/drafting/error. Both stay absent through the
      // transition, so there is no y to hold. playing stays out of
      // ASK_OPEN_PHASES for that reason (see ask-player-bar-var.tsx).
      const present = (values: Array<number | null>) => values.filter((value) => value != null);
      const drifted = (values: number[], origin: number) =>
        values.filter((value) => Math.abs(value - origin) > 1);

      if (before.cancel == null) {
        expect(present(samples.cancel), "取消 appeared during playing").toEqual([]);
        await expect(page.locator("[data-ask-cancel]")).toHaveCount(0);
      } else {
        expect(present(samples.cancel).length).toBeGreaterThan(0);
        expect(drifted(present(samples.cancel), before.cancel)).toEqual([]);
      }

      if (before.bar == null) {
        expect(present(samples.bar), "bottom bar appeared during playing").toEqual([]);
        await expect(page.locator("[data-ask-bottom-bar]")).toHaveCount(0);
      } else {
        expect(present(samples.bar).length).toBeGreaterThan(0);
        expect(drifted(present(samples.bar), before.bar)).toEqual([]);
      }
    });
  });
}

installPlayingTransitionStable();
