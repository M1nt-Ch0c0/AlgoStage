/**
 * Pointer hold on 取消. press() is synchronous from primary-button pointerdown.
 * wait() decides cancel vs send once the gesture or the hold timeout settles.
 * A session change drops the previous hold.
 */

export type CancelHoldResult = "cancel" | "send" | "send-held";

export type CancelHoldOptions = {
  setTimeout?: (callback: () => void, delayMs: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
};

export type CancelHold = {
  press: (session: number) => void;
  release: (inside: boolean) => void;
  leave: () => void;
  pointerCancel: () => void;
  isPending: (session: number) => boolean;
  /** A release already resolved this session and has not been consumed by wait. */
  latched: (session: number) => "cancel" | "send" | null;
  wait: (session: number, timeoutMs?: number) => Promise<CancelHoldResult>;
  onLateCancel: (cb: () => void) => void;
  reset: () => void;
};

type Phase = "idle" | "pending" | "sentWhileHeld";

type Latch = { session: number; outcome: "cancel" | "send" };

const DEFAULT_TIMEOUT_MS = 2000;

export function createCancelHold(options?: CancelHoldOptions): CancelHold {
  const schedule = options?.setTimeout ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const cancelTimer =
    options?.clearTimeout ??
    ((handle: unknown) => {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    });

  let pending = false;
  let boundSession: number | null = null;
  let phase: Phase = "idle";
  let timer: unknown = null;
  let waitResolve: ((result: CancelHoldResult) => void) | null = null;
  let waitSession: number | null = null;
  let latched: Latch | null = null;
  let lateCancel: (() => void) | null = null;

  function disarm() {
    if (timer == null) return;
    const handle = timer;
    timer = null;
    cancelTimer(handle);
  }

  function finishWait(result: CancelHoldResult) {
    const resolve = waitResolve;
    waitResolve = null;
    waitSession = null;
    disarm();
    resolve?.(result);
  }

  function clearHeld(invokeLate: boolean) {
    pending = false;
    phase = "idle";
    boundSession = null;
    if (invokeLate) lateCancel?.();
  }

  function endGesture(outcome: "cancel" | "send") {
    const sessionAtEnd = boundSession;
    pending = false;
    phase = "idle";
    boundSession = null;
    if (sessionAtEnd == null) return;
    latched = { session: sessionAtEnd, outcome };
    if (!waitResolve) return;
    if (waitSession === sessionAtEnd) {
      latched = null;
      finishWait(outcome);
      return;
    }
    finishWait("send");
  }

  function press(session: number) {
    if (waitResolve && waitSession !== session) {
      finishWait("send");
    }
    disarm();
    latched = null;
    pending = true;
    boundSession = session;
    phase = "pending";
  }

  function release(inside: boolean) {
    if (phase === "sentWhileHeld") {
      clearHeld(inside);
      return;
    }
    if (!pending) return;
    endGesture(inside ? "cancel" : "send");
  }

  function abandon() {
    if (phase === "sentWhileHeld") {
      clearHeld(false);
      return;
    }
    if (!pending) return;
    endGesture("send");
  }

  function isPending(session: number) {
    return pending && boundSession === session;
  }

  function latchedOutcome(session: number) {
    if (!latched || latched.session !== session) return null;
    return latched.outcome;
  }

  function wait(session: number, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<CancelHoldResult> {
    if (latched) {
      if (latched.session === session) {
        const outcome = latched.outcome;
        latched = null;
        return Promise.resolve(outcome);
      }
      return Promise.resolve("send");
    }
    if (!pending || boundSession !== session) {
      return Promise.resolve("send");
    }
    if (phase === "sentWhileHeld") {
      return Promise.resolve("send-held");
    }
    if (waitResolve) finishWait("send");
    return new Promise((resolve) => {
      waitResolve = resolve;
      waitSession = session;
      timer = schedule(() => {
        timer = null;
        if (!pending || boundSession !== session || phase !== "pending") return;
        phase = "sentWhileHeld";
        const resolveHeld = waitResolve;
        waitResolve = null;
        waitSession = null;
        resolveHeld?.("send-held");
      }, timeoutMs);
    });
  }

  function onLateCancel(cb: () => void) {
    lateCancel = cb;
  }

  function reset() {
    disarm();
    pending = false;
    boundSession = null;
    phase = "idle";
    latched = null;
    if (waitResolve) finishWait("send");
  }

  return {
    press,
    release,
    leave: abandon,
    pointerCancel: abandon,
    isPending,
    latched: latchedOutcome,
    wait,
    onLateCancel,
    reset,
  };
}
