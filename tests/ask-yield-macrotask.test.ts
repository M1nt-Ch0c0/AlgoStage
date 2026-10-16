import { afterEach, describe, expect, test, vi } from "vitest";
import { yieldForQueuedInput, yieldMacrotask } from "../lib/ask/yield-macrotask";

describe("yieldMacrotask", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  test("uses scheduler.yield when it is a function, then one macrotask", async () => {
    vi.useFakeTimers();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const yieldFn = vi.fn(() => gate);
    vi.stubGlobal("scheduler", { yield: yieldFn });

    let settled = false;
    const pending = yieldMacrotask().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(yieldFn).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);

    release();
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(120);
    await pending;
    expect(settled).toBe(true);
  });

  test("a decided cancel ends the settle after the macrotask", async () => {
    const delays: number[] = [];
    vi.stubGlobal("setTimeout", (callback: () => void, delayMs: number) => {
      delays.push(delayMs);
      if (delayMs === 0) callback();
      return delays.length;
    });
    vi.stubGlobal("scheduler", undefined);
    vi.stubGlobal("performance", { now: () => 1000 });

    await yieldMacrotask({ done: () => true });
    // The macrotask ran. The 120ms settle was scheduled and not awaited.
    expect(delays).toEqual([0, 120]);
  });

  test("an undecided press still waits out the settle", async () => {
    const delays: number[] = [];
    const pending: Array<() => void> = [];
    vi.stubGlobal("setTimeout", (callback: () => void, delayMs: number) => {
      delays.push(delayMs);
      pending.push(callback);
      return delays.length;
    });
    vi.stubGlobal("scheduler", undefined);
    vi.stubGlobal("performance", { now: () => 1000 });

    let settled = false;
    const running = yieldMacrotask({ done: () => false }).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(delays).toEqual([0, 120]);
    expect(settled).toBe(false);

    pending[0]?.();
    await Promise.resolve();
    expect(settled).toBe(false);

    pending[1]?.();
    await running;
    expect(settled).toBe(true);
  });

  test("after the macrotask, waits out the rest of the input settle", async () => {
    const delays: number[] = [];
    vi.stubGlobal("setTimeout", (callback: () => void, delayMs: number) => {
      delays.push(delayMs);
      callback();
      return delays.length;
    });
    vi.stubGlobal("scheduler", undefined);
    let now = 1000;
    vi.stubGlobal("performance", { now: () => now });

    await yieldMacrotask();
    // The macrotask is delay 0. The settle is whatever remains of 120ms.
    expect(delays[0]).toBe(0);
    expect(delays[1]).toBe(120);

    delays.length = 0;
    now = 2000;
    const yieldFn = vi.fn(() => {
      now += 20;
      return Promise.resolve();
    });
    vi.stubGlobal("scheduler", { yield: yieldFn });
    await yieldMacrotask();
    expect(yieldFn).toHaveBeenCalledTimes(1);
    expect(delays[0]).toBe(0);
    expect(delays[1]).toBe(100);
  });

  test("falls back to setTimeout(0) when scheduler.yield is absent", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("scheduler", undefined);

    let settled = false;
    const pending = yieldMacrotask().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(120);
    await pending;
    expect(settled).toBe(true);
  });
});

describe("yieldForQueuedInput", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  test("is two macrotasks and does not arm the 120ms settle", async () => {
    const delays: number[] = [];
    const pending: Array<() => void> = [];
    vi.stubGlobal("setTimeout", (callback: () => void, delayMs: number) => {
      delays.push(delayMs);
      pending.push(callback);
      return delays.length;
    });
    vi.stubGlobal("scheduler", undefined);

    let settled = false;
    const running = yieldForQueuedInput().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(delays).toEqual([0]);
    expect(settled).toBe(false);
    pending[0]?.();
    await Promise.resolve();
    expect(delays).toEqual([0, 0]);
    expect(settled).toBe(false);
    pending[1]?.();
    await running;
    expect(settled).toBe(true);
  });

  test("returns immediately when the signal is already aborted", async () => {
    const scheduled = vi.fn();
    vi.stubGlobal("setTimeout", scheduled);
    const controller = new AbortController();
    controller.abort();
    await yieldForQueuedInput(controller.signal);
    expect(scheduled).not.toHaveBeenCalled();
  });

  test("returns after the macrotask when the signal aborts during it", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("scheduler", undefined);
    const controller = new AbortController();
    let settled = false;
    const pending = yieldForQueuedInput(controller.signal).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    await pending;
    expect(settled).toBe(true);
    expect(controller.signal.aborted).toBe(true);
  });
});
