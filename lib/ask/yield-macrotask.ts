/**
 * One macrotask so input queued during a main-thread stall (e.g. a 取消 click
 * during capture) runs before the caller continues.
 * Prefers scheduler.yield(); falls back to setTimeout(0).
 *
 * scheduler.yield is a prioritized continuation and can run ahead of input
 * already queued on the event loop. submit should use yieldToInput instead.
 */

type SchedulerYieldHost = {
  scheduler?: {
    yield?: () => Promise<unknown>;
  };
};

type InputScheduling = {
  isInputPending?: () => boolean;
};

function nextMacrotask(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function inputStillPending(): boolean {
  const nav = (globalThis as { navigator?: { scheduling?: InputScheduling } }).navigator;
  const scheduling = nav?.scheduling;
  const isInputPending = scheduling?.isInputPending;
  if (typeof isInputPending !== "function") return false;
  return isInputPending.call(scheduling) === true;
}

export function yieldMacrotask(): Promise<void> {
  const host = globalThis as typeof globalThis & SchedulerYieldHost;
  const yieldTurn = host.scheduler?.yield;
  if (typeof yieldTurn === "function") {
    return Promise.resolve(yieldTurn.call(host.scheduler)).then(() => undefined);
  }
  return nextMacrotask();
}

/**
 * Fixed wait after capture so input queued during the stall can reach the
 * renderer queue. yieldToInput only sees input already in that queue.
 */
export const ASK_INPUT_SETTLE_MS = 50;

export function settleInput(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ASK_INPUT_SETTLE_MS);
  });
}

/**
 * Let a frame and queued input run before deciding to send.
 * One extra macrotask per still-pending input check, at most three.
 */
export async function yieldToInput(): Promise<void> {
  const raf = globalThis.requestAnimationFrame;
  if (typeof raf === "function") {
    await new Promise<void>((resolve) => {
      raf(() => resolve());
    });
  }
  await nextMacrotask();
  for (let extra = 0; extra < 3; extra += 1) {
    if (!inputStillPending()) return;
    await nextMacrotask();
  }
}

