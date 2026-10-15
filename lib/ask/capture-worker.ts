/**
 * One encode worker for the whole ask-selection session.
 * prewarmEncodeWorker() starts it when selection mode is entered, so the
 * first capture does not pay new Worker(). encodeOffThread reuses it.
 * A failed prewarm falls back to creating the worker on demand, and a
 * missing Worker falls back to main-thread encode.
 */

let singleton: Worker | null = null;
let failed = false;

function workerUrl(): URL {
  return new URL("./capture-encode.worker.ts", import.meta.url);
}

/** Start the singleton if Worker exists and a previous attempt did not fail. */
export function prewarmEncodeWorker(): Worker | null {
  if (singleton) return singleton;
  if (failed) return null;
  if (typeof Worker !== "function") return null;
  try {
    singleton = new Worker(workerUrl(), { type: "module" });
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
    const worker = new Worker(workerUrl(), { type: "module" });
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
}
