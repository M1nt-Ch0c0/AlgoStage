/**
 * One macrotask so input queued during a main-thread stall (e.g. a 取消 click
 * during capture) runs before the caller continues.
 * Prefers scheduler.yield(); falls back to setTimeout(0).
 */

type SchedulerYieldHost = {
  scheduler?: {
    yield?: () => Promise<unknown>;
  };
};

export function yieldMacrotask(): Promise<void> {
  const host = globalThis as typeof globalThis & SchedulerYieldHost;
  const yieldTurn = host.scheduler?.yield;
  if (typeof yieldTurn === "function") {
    return Promise.resolve(yieldTurn.call(host.scheduler)).then(() => undefined);
  }
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}
