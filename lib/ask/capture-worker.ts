/**
 * One encode worker for the whole ask-selection session.
 * scheduleEncodeWorkerPrewarm() starts it when selection mode is entered,
 * on requestIdleCallback (or a timeout when idle callbacks are missing),
 * so new Worker() and the module load never run in the submit or capture
 * turn. encodeOffThread reuses the singleton. A failed prewarm falls back
 * to creating the worker on demand, and a missing Worker falls back to
 * main-thread encode.
 */

import { markAskTiming } from "./ask-timing";

let singleton: Worker | null = null;
let failed = false;
let prewarmHandle: number | null = null;
/** True once a prewarm has been queued for this selection session. */
let prewarmQueued = false;

type IdleHost = typeof globalThis & {
  requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
};

/** Idle callbacks live on window in the browser and on globalThis under tests. */
function idleHost(): IdleHost {
  return globalThis as IdleHost;
}

function workerUrl(): URL {
  return new URL("./capture-encode.worker.ts", import.meta.url);
}

/** performance.now() around new Worker(), so the probe can see boot cost. */
function createEncodeWorker(): Worker {
  markAskTiming("workerInitAt");
  const worker = new Worker(workerUrl(), { type: "module" });
  markAskTiming("workerReadyAt");
  return worker;
}

/**
 * Queue the singleton for when the browser is idle, after selection mode
 * is entered. Never call this from submit or capture: the creation and the
 * module fetch must not share a task with domToCanvas.
 * Returns the worker only when a previous prewarm already finished.
 */
export function scheduleEncodeWorkerPrewarm(): Worker | null {
  if (singleton) return singleton;
  if (failed || prewarmQueued) return null;
  if (typeof Worker !== "function") return null;
  prewarmQueued = true;
  const idle = idleHost();
  const run = () => {
    prewarmHandle = null;
    prewarmEncodeWorker();
  };
  if (typeof idle.requestIdleCallback === "function") {
    prewarmHandle = idle.requestIdleCallback(run, { timeout: 1000 });
    return null;
  }
  prewarmHandle = setTimeout(run, 0) as unknown as number;
  return null;
}

/** Start the singleton if Worker exists and a previous attempt did not fail. */
export function prewarmEncodeWorker(): Worker | null {
  if (singleton) return singleton;
  if (failed) return null;
  if (typeof Worker !== "function") return null;
  try {
    singleton = createEncodeWorker();
    singleton.addEventListener("error", () => {
      // A boot error means later captures should not keep this instance.
      singleton = null;
      failed = true;
    });
    return singleton;
  } catch {
    failed = true;
    return null;
  }
}

/**
 * The live singleton, or a fresh worker when prewarm did not run.
 * Returns null when Worker is missing or construction throws, which is the
 * main-thread encode fallback.
 */
export function acquireEncodeWorker(): Worker | null {
  if (singleton) return singleton;
  if (typeof Worker !== "function") return null;
  try {
    const worker = createEncodeWorker();
    singleton = worker;
    failed = false;
    return worker;
  } catch {
    return null;
  }
}

/** Drop the singleton after a worker error so the next capture can try again. */
export function retireEncodeWorker(worker: Worker): void {
  if (singleton === worker) singleton = null;
  try {
    worker.terminate();
  } catch {
    // Already gone.
  }
}

/** Test hook. Production leaves the worker up for the page lifetime. */
export function resetEncodeWorkerForTests(): void {
  if (singleton) {
    try {
      singleton.terminate();
    } catch {
      // Already gone.
    }
  }
  singleton = null;
  failed = false;
  prewarmQueued = false;
  if (prewarmHandle != null) {
    const idle = idleHost();
    if (typeof idle.cancelIdleCallback === "function") {
      idle.cancelIdleCallback(prewarmHandle);
    }
    clearTimeout(prewarmHandle);
    prewarmHandle = null;
  }
}
