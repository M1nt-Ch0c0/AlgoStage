/**
 * One macrotask so input queued during a main-thread stall (e.g. a 取消 click
 * during capture) runs before the caller continues.
 * Prefers scheduler.yield(); falls back to setTimeout(0), a real macrotask,
 * so a pointerdown already queued on this thread is dispatched first.
 *
 * scheduler.yield is a prioritized continuation and can run ahead of input
 * that has not reached the renderer queue yet. A press that has been
 * dispatched into this thread's queue is visible after this one yield.
 * The cancel decision is the 取消 hit flag that yield lets the listener set,
 * not a timestamp compared with sentAt.
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
    // Named so a test can tell this yield from the pre-capture paint timer.
    function askInputMacrotask() {
      resolve();
    }
    setTimeout(askInputMacrotask, 0);
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
    // scheduler.yield can resume before a pointer event that was issued
    // during the stall reaches this thread. A real macrotask after it lets
    // that pointerdown run, so a 取消 held across the stall is seen before
    // encode and send.
    return Promise.resolve(yieldTurn.call(host.scheduler)).then(() => nextMacrotask());
  }
  return nextMacrotask();
}

/**
 * Fixed wait after the capture long task so input queued during the stall
 * can reach the renderer queue. The budget is measured from longTaskEnd,
 * so time already spent yielding counts toward the 50ms.
 */
export const ASK_INPUT_SETTLE_MS = 50;

export function settleInput(elapsedMs = 0): Promise<void> {
  const remaining = Math.max(0, ASK_INPUT_SETTLE_MS - Math.max(0, elapsedMs));
  if (remaining === 0) return Promise.resolve();
  return new Promise((resolve) => {
    setTimeout(resolve, remaining);
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

