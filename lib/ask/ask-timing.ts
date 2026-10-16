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
  | "workerReadyAt"
  | "cancelPointerUpAt"
  | "cancelPointerUpDispatchAt"
  | "cancelPaintAt";

export type AskTimingPhase =
  | "preCaptureMs"
  | "domToCanvasMs"
  | "postToWorkerMs"
  | "encodeMs"
  | "settleMs"
  | "preFetchMs"
  /** domToCanvas start → onCloneNode (clone tree and computed-style inlining). */
  | "captureCloneMs"
  /** onCloneNode → onEmbedNode (fonts and images embedded). */
  | "captureEmbedMs"
  /** onEmbedNode → onCreateForeignObjectSvg. */
  | "captureSvgMs"
  /** domToCanvas start → the call resolved (raster). */
  | "captureRasterMs";

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
  /**
   * event.timeStamp of the 取消 pointerup, on the performance.now() clock.
   * When the release is queued during a long task this is earlier than dispatch.
   */
  cancelPointerUpAt?: number;
  /**
   * performance.now() when the pointerup handler ran. Equals cancelPointerUpAt
   * when the main thread was free. The gap is the time the event sat queued.
   */
  cancelPointerUpDispatchAt?: number;
  /**
   * performance.now() at the animation frame after the cancelled or idle
   * state has rendered. cancelPaintAfterReleaseMs is this minus the release.
   * The release is the later of the event time and the dispatch time, so a
   * release delivered during a long task is measured from when the handler
   * ran, and a free-thread release is measured from the event itself.
   */
  cancelPaintAt?: number;
  /** Release → cancelPaintAt. See cancelPaintAt for which release clock. */
  cancelPaintAfterReleaseMs?: number;
  firstPointerDownTs?: number;
  /** submitAt → captureStart, which includes the pre-capture paint (one frame, then one macrotask). */
  preCaptureMs?: number;
  domToCanvasMs?: number;
  postToWorkerMs?: number;
  encodeMs?: number;
  settleMs?: number;
  preFetchMs?: number;
  /** domToCanvas start → onCloneNode. */
  captureCloneMs?: number;
  /** onCloneNode → onEmbedNode. */
  captureEmbedMs?: number;
  /** onEmbedNode → onCreateForeignObjectSvg. */
  captureSvgMs?: number;
  /** domToCanvas start → the call resolved. */
  captureRasterMs?: number;
  /** Elements under the capture container (`querySelectorAll("*")`). */
  captureSourceNodes?: number;
  /** Times modern-screenshot called onCloneEachNode. */
  captureClonedNodes?: number;
  /**
   * The canvas after crop and before encode. Set only when this probe object
   * already exists. The pixel harness compares it to a screenshot of the same
   * CSS rect. Absent from a page that never installs the probe.
   */
  captureCanvas?: HTMLCanvasElement;
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
 * Timing logs still read the gap from this instant. The cancel decision does not.
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
 * captureStage. The gap includes the frame and macrotask that paint the busy 取消 row.
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

/**
 * Which release clock the paint delta uses.
 * A release delivered during a long task has an event time well before the
 * handler runs; measuring from that time charges the stall to the paint.
 * Use the dispatch time in that case. When the thread was free, the event
 * time and the dispatch time agree and the event time is the release.
 */
export function cancelReleaseMark(probe: AskTimingProbe): number | undefined {
  const eventAt = probe.cancelPointerUpAt;
  const dispatchAt = probe.cancelPointerUpDispatchAt;
  if (eventAt == null && dispatchAt == null) return undefined;
  if (eventAt == null) return dispatchAt;
  if (dispatchAt == null) return eventAt;
  return Math.max(eventAt, dispatchAt);
}

/**
 * The panel calls this after the cancelled or idle state has committed.
 * The duration is the next animation frame after that paint, minus the
 * pointerup that released 取消. No-op until both marks exist.
 */
export function noteCancelPaint(): void {
  const probe = askTimingProbe();
  if (!probe) return;
  if (probe.cancelPaintAfterReleaseMs != null) return;
  const up = cancelReleaseMark(probe);
  const paint = probe.cancelPaintAt;
  if (up == null || paint == null) return;
  const duration = paint - up;
  if (!Number.isFinite(duration)) return;
  probe.cancelPaintAfterReleaseMs = duration;
}
