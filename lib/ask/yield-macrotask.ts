/**
 * One macrotask so input queued during a main-thread stall (e.g. a 取消 click
 * during capture) runs before the caller continues.
 * Prefers scheduler.yield(); falls back to setTimeout(0), a real macrotask,
 * so a pointerdown already queued on this thread is dispatched first.
 * Then waits out the rest of ASK_INPUT_SETTLE_MS. A CDP press issued during
 * the stall can take ~40–90ms to reach the renderer under 4× CPU, and
 * isInputPending stays false until it arrives, so a yield loop never sees
 * it. The settle is the window that press uses to land before encode.
 * A caller that already has its answer passes done(). The settle timer is
 * still armed (a held macrotask holds both), but it is not awaited, and it
 * is cleared so it does not fire after the caller has moved on.
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

function nextMacrotask(delayMs = 0): { promise: Promise<void>; handle: ReturnType<typeof setTimeout> } {
  // The Promise executor runs synchronously, so the handle is assigned
  // before this function returns. Node's Timeout and the DOM number id
  // do not overlap, so the handle is not seeded with a numeric zero.
  let handle!: ReturnType<typeof setTimeout>;
  const promise = new Promise<void>((resolve) => {
    // Named so a test can tell this yield from the pre-capture paint timer.
    // The post-stall settle uses the same name: one release covers both.
    function askInputMacrotask() {
      resolve();
    }
    handle = setTimeout(askInputMacrotask, delayMs);
  });
  return { promise, handle };
}

function inputStillPending(): boolean {
  const nav = (globalThis as { navigator?: { scheduling?: InputScheduling } }).navigator;
  const scheduling = nav?.scheduling;
  const isInputPending = scheduling?.isInputPending;
  if (typeof isInputPending !== "function") return false;
  return isInputPending.call(scheduling) === true;
}

export async function yieldMacrotask(options?: {
  done?: () => boolean;
  /** Aborted when 取消 is decided. Ends the settle immediately. */
  signal?: AbortSignal;
}): Promise<void> {
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
  // A caller that already has its answer (the 取消 hit landed during the
  // stall) passes done(). The settle then stops: the remaining wait would
  // sit between that release and the close, which is the 390 cancel paint.
  // A release that lands while the settle timer is running aborts signal.
  // That ends the wait the same way, and the timer is cleared.
  const elapsed = (typeof performance !== "undefined" ? performance.now() : Date.now()) - started;
  const remaining = Math.max(0, ASK_INPUT_SETTLE_MS - Math.max(0, elapsed));
  const macrotask = nextMacrotask();
  const settle = remaining > 0 ? nextMacrotask(remaining) : null;
  await macrotask.promise;
  const decided = () => options?.done?.() === true || options?.signal?.aborted === true;
  if (decided()) {
    // The settle was armed in the same turn as the macrotask. A decided
    // cancel does not wait it out. Clear it so it is not still pending
    // after the panel has closed.
    if (settle) clearTimeout(settle.handle);
    return;
  }
  if (!settle) return;
  const signal = options?.signal;
  if (!signal) {
    await settle.promise;
    return;
  }
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    onAbort = () => resolve();
    signal.addEventListener("abort", onAbort, { once: true });
  });
  await Promise.race([settle.promise, aborted]);
  if (onAbort) signal.removeEventListener("abort", onAbort);
  if (decided()) clearTimeout(settle.handle);
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

/**
 * Two macrotasks and nothing after them. A 取消 issued during the capture
 * stall arrives as a CDP command first; that command enqueues the pointer
 * events, and those events run on the following turn. One macrotask resumes
 * before the events, so domToCanvas would start and the panel would stay up
 * for the whole raster. The second turn is the one the handlers run on.
 * Unlike yieldMacrotask, this does not arm the 120ms input settle: the
 * caller is about to start domToCanvas, and that settle would sit in front
 * of every capture. An abort that is already set, or that either turn
 * delivers, ends the wait. The caller reads signal.aborted after this returns.
 */
export async function yieldForQueuedInput(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  const host = globalThis as typeof globalThis & SchedulerYieldHost;
  const yieldTurn = host.scheduler?.yield;
  if (typeof yieldTurn === "function") {
    await Promise.resolve(yieldTurn.call(host.scheduler));
  }
  if (signal?.aborted) return;
  await nextMacrotask().promise;
  if (signal?.aborted) return;
  await nextMacrotask().promise;
}

export function settleInput(elapsedMs = 0): Promise<void> {
  const remaining = Math.max(0, ASK_INPUT_SETTLE_MS - Math.max(0, elapsedMs));
  if (remaining === 0) return Promise.resolve();
  return nextMacrotask(remaining).promise;
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
  await nextMacrotask().promise;
  for (let extra = 0; extra < 3; extra += 1) {
    if (!inputStillPending()) return;
    await nextMacrotask().promise;
  }
}

