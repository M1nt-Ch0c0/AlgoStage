import { describe, expect, test, vi } from "vitest";
import { createCancelHold } from "../lib/ask/cancel-hold";

function manualTimers() {
  let nextId = 1;
  const queue = new Map<number, () => void>();
  const cleared: unknown[] = [];
  return {
    cleared,
    setTimeout: (callback: () => void) => {
      const id = nextId;
      nextId += 1;
      queue.set(id, callback);
      return id;
    },
    clearTimeout: (handle: unknown) => {
      cleared.push(handle);
      queue.delete(handle as number);
    },
    pendingCount: () => queue.size,
    fire() {
      const jobs = [...queue.entries()];
      queue.clear();
      for (const [, job] of jobs) job();
    },
  };
}

function holdWith(timers: ReturnType<typeof manualTimers>) {
  return createCancelHold({
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
}

describe("createCancelHold", () => {
  test("press then release inside resolves wait as cancel", async () => {
    const timers = manualTimers();
    const hold = holdWith(timers);
    hold.press(1);
    expect(hold.isPending(1)).toBe(true);

    const pending = hold.wait(1);
    let settled = false;
    const result = pending.then((value) => {
      settled = true;
      return value;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    hold.release(true);
    await expect(result).resolves.toBe("cancel");
    expect(hold.isPending(1)).toBe(false);
    expect(timers.pendingCount()).toBe(0);
    expect(timers.cleared).toHaveLength(1);
  });

  test("release inside before wait still resolves cancel", async () => {
    const hold = createCancelHold();
    hold.press(4);
    hold.release(true);
    expect(hold.isPending(4)).toBe(false);
    await expect(hold.wait(4)).resolves.toBe("cancel");
  });

  test("leave resolves send", async () => {
    const timers = manualTimers();
    const hold = holdWith(timers);
    hold.press(1);
    const pending = hold.wait(1);
    hold.leave();
    await expect(pending).resolves.toBe("send");
    expect(hold.isPending(1)).toBe(false);
    expect(timers.pendingCount()).toBe(0);
  });

  test("pointerCancel resolves send", async () => {
    const timers = manualTimers();
    const hold = holdWith(timers);
    hold.press(1);
    const pending = hold.wait(1);
    hold.pointerCancel();
    await expect(pending).resolves.toBe("send");
    expect(hold.isPending(1)).toBe(false);
    expect(timers.pendingCount()).toBe(0);
  });

  test("release outside resolves send", async () => {
    const timers = manualTimers();
    const hold = holdWith(timers);
    hold.press(1);
    const pending = hold.wait(1);
    hold.release(false);
    await expect(pending).resolves.toBe("send");
    expect(hold.isPending(1)).toBe(false);
  });

  test("timeout while held resolves send-held and stays pending", async () => {
    const timers = manualTimers();
    const hold = holdWith(timers);
    hold.press(7);
    const pending = hold.wait(7, 2000);
    let settled = false;
    const result = pending.then((value) => {
      settled = true;
      return value;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(timers.pendingCount()).toBe(1);

    timers.fire();
    await expect(result).resolves.toBe("send-held");
    expect(hold.isPending(7)).toBe(true);
    expect(timers.pendingCount()).toBe(0);
  });

  test("late release inside invokes onLateCancel once", async () => {
    const timers = manualTimers();
    const hold = holdWith(timers);
    const late = vi.fn();
    hold.onLateCancel(late);
    hold.press(1);
    const pending = hold.wait(1);
    timers.fire();
    await expect(pending).resolves.toBe("send-held");

    hold.release(true);
    expect(late).toHaveBeenCalledTimes(1);
    expect(hold.isPending(1)).toBe(false);

    hold.release(true);
    expect(late).toHaveBeenCalledTimes(1);
  });

  test("late release outside does not call onLateCancel", async () => {
    const timers = manualTimers();
    const hold = holdWith(timers);
    const late = vi.fn();
    hold.onLateCancel(late);
    hold.press(1);
    const pending = hold.wait(1);
    timers.fire();
    await expect(pending).resolves.toBe("send-held");

    hold.release(false);
    expect(late).not.toHaveBeenCalled();
    expect(hold.isPending(1)).toBe(false);
  });

  test("leave and pointerCancel after send-held clear without onLateCancel", async () => {
    const timers = manualTimers();
    const hold = holdWith(timers);
    const late = vi.fn();
    hold.onLateCancel(late);

    hold.press(1);
    const first = hold.wait(1);
    timers.fire();
    await expect(first).resolves.toBe("send-held");
    hold.leave();
    expect(late).not.toHaveBeenCalled();
    expect(hold.isPending(1)).toBe(false);

    hold.press(1);
    const second = hold.wait(1);
    timers.fire();
    await expect(second).resolves.toBe("send-held");
    hold.pointerCancel();
    expect(late).not.toHaveBeenCalled();
    expect(hold.isPending(1)).toBe(false);
  });

  test("session mismatch resolves send and isPending is false for a different session", async () => {
    const timers = manualTimers();
    const hold = holdWith(timers);
    expect(hold.isPending(1)).toBe(false);
    hold.press(1);
    expect(hold.isPending(1)).toBe(true);
    expect(hold.isPending(2)).toBe(false);

    await expect(hold.wait(2)).resolves.toBe("send");
    expect(hold.isPending(1)).toBe(true);
    expect(timers.pendingCount()).toBe(0);

    const inflight = hold.wait(1);
    hold.press(2);
    await expect(inflight).resolves.toBe("send");
    expect(hold.isPending(1)).toBe(false);
    expect(hold.isPending(2)).toBe(true);
    expect(timers.pendingCount()).toBe(0);
  });

  test("reset clears timers and pending state", async () => {
    const timers = manualTimers();
    const hold = holdWith(timers);
    const late = vi.fn();
    hold.onLateCancel(late);
    hold.press(1);
    const pending = hold.wait(1, 2000);
    expect(timers.pendingCount()).toBe(1);

    hold.reset();
    expect(timers.pendingCount()).toBe(0);
    expect(timers.cleared).toHaveLength(1);
    expect(hold.isPending(1)).toBe(false);
    await expect(pending).resolves.toBe("send");

    timers.fire();
    expect(late).not.toHaveBeenCalled();
    expect(hold.isPending(1)).toBe(false);
  });
});
