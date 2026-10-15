/**
 * Capture timing probe. Records only when a test has set window.__ASK_TIMING__
 * to an object. Production (and any page that never sets it) is a no-op.
 * Durations are performance.now() deltas. firstPointerDownTs is event.timeStamp.
 */

export type AskTimingMark =
  | "submitAt"
  | "captureStart"
  | "longTaskEnd"
  | "sentAt"
  | "cancelUnmountAt"
  | "workerInitAt"
  | "workerReadyAt";

export type AskTimingPhase =
  | "preCaptureMs"
  | "domToCanvasMs"
  | "postToWorkerMs"
  | "encodeMs"
  | "settleMs"
  | "preFetchMs";

export type AskTimingProbe = {
  /** performance.now() at the submit handler entry. */
  submitAt?: number;
  captureStart?: number;
  longTaskEnd?: number;
  sentAt?: number;
  cancelUnmountAt?: number;
  /** performance.now() just before new Worker() for the encode worker. */
  workerInitAt?: number;
  /** performance.now() just after new Worker() returns. */
  workerReadyAt?: number;
  firstPointerDownTs?: number;
  /** submitAt → captureStart, which includes the pre-capture double rAF. */
  preCaptureMs?: number;
  domToCanvasMs?: number;
  postToWorkerMs?: number;
  encodeMs?: number;
  settleMs?: number;
  preFetchMs?: number;
};

declare global {
  interface Window {
    __ASK_TIMING__?: AskTimingProbe;
  }
}

function now(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

/** The live probe, or null when timing is not enabled. */
export function askTimingProbe(): AskTimingProbe | null {
  if (typeof window === "undefined") return null;
  const probe = window.__ASK_TIMING__;
  if (probe == null || typeof probe !== "object") return null;
  return probe;
}

export function isAskTimingEnabled(): boolean {
  return askTimingProbe() !== null;
}

/** Stamp a point in time. Later calls do not overwrite an existing mark. */
export function markAskTiming(mark: AskTimingMark, at = now()): void {
  const probe = askTimingProbe();
  if (!probe) return;
  if (probe[mark] != null) return;
  probe[mark] = at;
}

/**
 * performance.now() when domToCanvas returned, kept even when the probe is off.
 * The post-capture settle measures its 50ms budget from this instant.
 */
let longTaskEndedAt: number | null = null;

export function noteLongTaskEnded(at = now()): void {
  longTaskEndedAt = at;
}

/** Milliseconds since noteLongTaskEnded, or 0 when capture has not marked it. */
export function msSinceLongTaskEnd(at = now()): number {
  if (longTaskEndedAt == null) return 0;
  return Math.max(0, at - longTaskEndedAt);
}

/** Test hook. Production only writes the mark from capture. */
export function resetLongTaskEndForTests(): void {
  longTaskEndedAt = null;
}

/** Record the first 取消 pointerdown timeStamp. Later presses do not replace it. */
export function markAskPointerDown(timeStamp: number): void {
  const probe = askTimingProbe();
  if (!probe) return;
  if (probe.firstPointerDownTs != null) return;
  if (!Number.isFinite(timeStamp)) return;
  probe.firstPointerDownTs = timeStamp;
}

/** Record a phase duration in milliseconds. Later calls do not overwrite it. */
export function markAskPhase(phase: AskTimingPhase, durationMs: number): void {
  const probe = askTimingProbe();
  if (!probe) return;
  if (probe[phase] != null) return;
  if (!Number.isFinite(durationMs)) return;
  probe[phase] = durationMs;
}

/**
 * submitAt is the submit handler entry. captureStart is the start of
 * captureStage. The gap includes the double rAF that paints the busy 取消 row.
 * No-op until both marks exist, and a later call does not overwrite it.
 */
export function notePreCapture(): void {
  const probe = askTimingProbe();
  if (!probe) return;
  if (probe.preCaptureMs != null) return;
  const submitAt = probe.submitAt;
  const captureStart = probe.captureStart;
  if (submitAt == null || captureStart == null) return;
  const duration = captureStart - submitAt;
  if (!Number.isFinite(duration)) return;
  probe.preCaptureMs = duration;
}
