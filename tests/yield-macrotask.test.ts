import { afterEach, describe, expect, test, vi } from "vitest";
import { ASK_INPUT_SETTLE_MS, settleInput, yieldMacrotask, yieldToInput } from "../lib/ask/yield-macrotask";

describe("yieldToInput", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function queue() {
    const jobs: Array<() => void> = [];
    vi.stubGlobal("setTimeout", (callback: () => void) => {
      jobs.push(callback);
      return jobs.length;
    });
    return {
      jobs,
      async flushNext() {
        const job = jobs.shift();
        job?.();
        await Promise.resolve();
        await Promise.resolve();
      },
    };
  }

  test("awaits requestAnimationFrame then one macrotask when input is not pending", async () => {
    const frames: Array<() => void> = [];
    const raf = vi.fn((callback: () => void) => {
      frames.push(callback);
      return 1;
    });
    vi.stubGlobal("requestAnimationFrame", raf);
    const pendingInput = vi.fn(() => false);
    vi.stubGlobal("navigator", { scheduling: { isInputPending: pendingInput } });
    const tasks = queue();

    let settled = false;
    const pending = yieldToInput().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(raf).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    expect(tasks.jobs).toHaveLength(0);

    frames.shift()?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(tasks.jobs).toHaveLength(1);
    expect(settled).toBe(false);

    await tasks.flushNext();
    await pending;
    expect(settled).toBe(true);
    expect(pendingInput).toHaveBeenCalledTimes(1);
    expect(tasks.jobs).toHaveLength(0);
  });

  test("skips requestAnimationFrame when it is unavailable", async () => {
    vi.stubGlobal("requestAnimationFrame", undefined);
    const pendingInput = vi.fn(() => false);
    vi.stubGlobal("navigator", { scheduling: { isInputPending: pendingInput } });
    const tasks = queue();

    let settled = false;
    const pending = yieldToInput().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(tasks.jobs).toHaveLength(1);
    expect(settled).toBe(false);

    await tasks.flushNext();
    await pending;
    expect(settled).toBe(true);
    expect(pendingInput).toHaveBeenCalledTimes(1);
  });

  test("does one extra macrotask when input is pending once", async () => {
    vi.stubGlobal("requestAnimationFrame", undefined);
    let checks = 0;
    const pendingInput = vi.fn(() => {
      checks += 1;
      return checks === 1;
    });
    vi.stubGlobal("navigator", { scheduling: { isInputPending: pendingInput } });
    const tasks = queue();

    let settled = false;
    const pending = yieldToInput().then(() => {
      settled = true;
    });
    await Promise.resolve();
    await tasks.flushNext();
    expect(settled).toBe(false);
    expect(pendingInput).toHaveBeenCalledTimes(1);
    expect(tasks.jobs).toHaveLength(1);

    await tasks.flushNext();
    await pending;
    expect(settled).toBe(true);
    expect(pendingInput).toHaveBeenCalledTimes(2);
    expect(tasks.jobs).toHaveLength(0);
  });

  test("does at most three extra macrotasks while input stays pending", async () => {
    vi.stubGlobal("requestAnimationFrame", undefined);
    const pendingInput = vi.fn(() => true);
    vi.stubGlobal("navigator", { scheduling: { isInputPending: pendingInput } });
    const tasks = queue();

    let settled = false;
    const pending = yieldToInput().then(() => {
      settled = true;
    });
    await Promise.resolve();

    await tasks.flushNext();
    await tasks.flushNext();
    await tasks.flushNext();
    expect(settled).toBe(false);
    expect(pendingInput).toHaveBeenCalledTimes(3);

    await tasks.flushNext();
    await pending;
    expect(settled).toBe(true);
    expect(pendingInput).toHaveBeenCalledTimes(3);
    expect(tasks.jobs).toHaveLength(0);
  });

  test("ignores a missing scheduling.isInputPending", async () => {
    vi.stubGlobal("requestAnimationFrame", undefined);
    vi.stubGlobal("navigator", {});
    const tasks = queue();

    let settled = false;
    const pending = yieldToInput().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(tasks.jobs).toHaveLength(1);
    await tasks.flushNext();
    await pending;
    expect(settled).toBe(true);
  });
});

describe("settleInput", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("waits ASK_INPUT_SETTLE_MS before resolving", async () => {
    expect(ASK_INPUT_SETTLE_MS).toBe(50);
    const delays: number[] = [];
    vi.stubGlobal("setTimeout", (callback: () => void, delayMs: number) => {
      delays.push(delayMs);
      callback();
      return 1;
    });
    await settleInput();
    expect(delays).toEqual([ASK_INPUT_SETTLE_MS]);
  });

  test("time already spent since the long task shortens the settle, and a spent budget waits nothing", async () => {
    const delays: number[] = [];
    vi.stubGlobal("setTimeout", (callback: () => void, delayMs: number) => {
      delays.push(delayMs);
      callback();
      return 1;
    });
    await settleInput(20);
    await settleInput(ASK_INPUT_SETTLE_MS);
    await settleInput(80);
    expect(delays).toEqual([30]);
  });
});

describe("yieldMacrotask", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("stays exported for existing callers and follows scheduler.yield with one macrotask", async () => {
    vi.useFakeTimers();
    const yieldFn = vi.fn(() => Promise.resolve());
    vi.stubGlobal("scheduler", { yield: yieldFn });
    const pending = yieldMacrotask();
    await Promise.resolve();
    await Promise.resolve();
    expect(yieldFn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(0);
    await pending;
  });
});
