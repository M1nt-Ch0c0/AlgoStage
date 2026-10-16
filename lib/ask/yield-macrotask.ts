/**
 * One macrotask so input queued during a main-thread stall (e.g. a 取消 click
 * during capture) runs before the caller continues.
 * Prefers scheduler.yield(); falls back to setTimeout(0), a real macrotask,
 * so a pointerdown already queued on this thread is dispatched first.
 * Then waits out the rest of ASK_INPUT_SETTLE_MS. A CDP press issued during
 * the stall can take ~40–90ms to reach the renderer under 4× CPU, and
 * isInputPending stays false until it arrives, so a yield loop never sees
 * it. The settle is the window that press uses to land before encode.
 *
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

function nextMacrotask(delayMs = 0): Promise<void> {
  return new Promise((resolve) => {
    // Named so a test can tell this yield from the pre-capture paint timer.
    // The post-stall settle uses the same name: one release covers both.
    function askInputMacrotask() {
      resolve();
    }
    setTimeout(askInputMacrotask, delayMs);
  });
}

function inputStillPending(): boolean {
  const nav = (globalThis as { navigator?: { scheduling?: InputScheduling } }).navigator;
  const scheduling = nav?.scheduling;
  const isInputPending = scheduling?.isInputPending;
  if (typeof isInputPending !== "function") return false;
  return isInputPending.call(scheduling) === true;
}

export async function yieldMacrotask(): Promise<void> {
  const started = typeof performance !== "undefined" ? performance.now() : Date.now();
  const host = globalThis as typeof globalThis & SchedulerYieldHost;
  const yieldTurn = host.scheduler?.yield;
  if (typeof yieldTurn === "function") {
    // scheduler.yield can resume before a pointer event that was issued
    // during the stall reaches this thread.
    await Promise.resolve(yieldTurn.call(host.scheduler));
  }
  // A press dispatched by CDP during the stall is not in this thread yet,
  // and isInputPending is false until it arrives. The macrotask lets a press
  // already queued here run. The settle, scheduled in the same turn, is the
  // rest of the window that press uses to arrive before encode. Same timer
  // name, so a caller that holds the macrotask holds the settle too.
  const elapsed = (typeof performance !== "undefined" ? performance.now() : Date.now()) - started;
  const remaining = Math.max(0, ASK_INPUT_SETTLE_MS - Math.max(0, elapsed));
  const macrotask = nextMacrotask();
  const settle = remaining > 0 ? nextMacrotask(remaining) : Promise.resolve();
  await macrotask;
  await settle;
}

/**
 * Fixed wait after the capture long task so input queued during the stall
 * can reach the renderer queue. The budget is measured from longTaskEnd,
 * so time already spent yielding counts toward ASK_INPUT_SETTLE_MS.
 */
// A CDP press issued during the capture stall reached the renderer 34–97ms
// after longTaskEnd under 4× CPU (hook log, release-after-stall 1280).
// 50ms ended before that press, so encode and send ran first. 120ms covers
// the observed gap and still returns before the test's 150ms post-stall hold.
export const ASK_INPUT_SETTLE_MS = 120;

export function settleInput(elapsedMs = 0): Promise<void> {
  const remaining = Math.max(0, ASK_INPUT_SETTLE_MS - Math.max(0, elapsedMs));
  if (remaining === 0) return Promise.resolve();
  return nextMacrotask(remaining);
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

