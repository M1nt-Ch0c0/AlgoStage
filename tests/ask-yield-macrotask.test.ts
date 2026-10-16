import { afterEach, describe, expect, test, vi } from "vitest";
import { yieldMacrotask } from "../lib/ask/yield-macrotask";

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
    await pending;
    expect(settled).toBe(true);
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
    await pending;
    expect(settled).toBe(true);
  });
});
