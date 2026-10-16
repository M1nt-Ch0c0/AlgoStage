/**
 * 屏幕区域截图与选区裁切 / Screen region capture and selection cropping.
 * Coordinates are container-relative CSS px, same as hitTest;
 * 400KB limit is measured as decoded bytes, consistent with M3 server check.
 */

import { ASK_LIMITS } from "@/lib/ask/types";
import type { AskBBox, AskSelection, AskTarget } from "@/lib/ask/types";
import { markAskPhase, markAskTiming, noteLongTaskEnded, notePreCapture } from "./ask-timing";
import { yieldMacrotask } from "./yield-macrotask";
import { acquireEncodeWorker, retireEncodeWorker } from "./capture-worker";
import { intersects, normalizeBBox } from "./hit-test";
import type { EncodeRequest, EncodeResponse } from "./capture-encode";

export const CAPTURE_FALLBACK_NOTICE = "没截到图，这次只发送选中的文字。";

export type CaptureFailReason =
  | "NO_CONTAINER"
  | "EMPTY_BBOX"
  | "IMPORT_FAILED"
  | "RENDER_FAILED"
  | "NO_CONTEXT"
  | "TOO_LARGE"
  | "TOO_MANY_NODES"
  | "TIMEOUT"
  | "ABORTED";

export type CaptureEncoder = "worker" | "main";

export type CapturePerfInfo = {
  encoder: CaptureEncoder;
  mime: "image/webp" | "image/jpeg";
  bytes: number;
  /** window.devicePixelRatio at capture time. */
  devicePixelRatio: number;
  /** The scale option passed to domToCanvas. */
  scale: number;
  /** Crop rect in canvas pixels. */
  crop: { x: number; y: number; w: number; h: number };
  /** domToCanvas output size, in pixels. */
  canvas: { width: number; height: number };
};

declare global {
  interface Window {
    /** Last successful capture, read by the S4 perf probe. */
    __s4Capture?: CapturePerfInfo;
  }
}

export type CaptureResult =
  | {
      ok: true;
      encoder: CaptureEncoder;
      image: { mime: "image/webp" | "image/jpeg"; dataBase64: string };
      bytes: number;
    }
  | {
      ok: false;
      reason: CaptureFailReason;
      fallbackText: string;
    };

/** Expose the encoder the S4 perf probe records. No-op outside the browser. */
export function noteCapturePerf(info: CapturePerfInfo): void {
  if (typeof window === "undefined") return;
  window.__s4Capture = info;
}

/** Geometry the perf probe prints next to the encoder. Scale is the domToCanvas option. */
function capturePerf(
  encoder: CaptureEncoder,
  mime: "image/webp" | "image/jpeg",
  bytes: number,
  crop: { x: number; y: number; w: number; h: number },
  canvas: { width: number; height: number },
): CapturePerfInfo {
  const ratio = typeof window !== "undefined" ? window.devicePixelRatio : 1;
  return {
    encoder,
    mime,
    bytes,
    devicePixelRatio: Number.isFinite(ratio) && ratio > 0 ? ratio : 1,
    scale: 1,
    crop: { x: crop.x, y: crop.y, w: crop.w, h: crop.h },
    canvas: { width: canvas.width, height: canvas.height },
  };
}

export const CAPTURE_DEFAULTS = {
  timeoutMs: 3000,
  maxBytes: 400 * 1024,
  maxLongSide: 1280,
  qualities: [0.85, 0.7, 0.55],
  downscaleFactor: 0.75,
  maxDownscales: 2,
  /** Kept elements above this skip rasterization and use the text fallback. */
  maxNodes: 1500,
} as const;

export function buildFallbackText(targets: AskTarget[]): string {
  const result: string[] = [];
  const limit = ASK_LIMITS.targetsMax;
  for (const target of targets.slice(0, limit)) {
    const raw = target.text?.trim();
    if (!raw) {
      continue;
    }
    const truncated =
      raw.length > ASK_LIMITS.targetTextMax
        ? raw.slice(0, ASK_LIMITS.targetTextMax)
        : raw;
    result.push(truncated);
  }
  return result.join("\n");
}

export function decodedBase64Bytes(b64: string): number {
  const len = b64.length;
  if (len === 0) {
    return 0;
  }
  let padding = 0;
  if (b64.endsWith("==")) {
    padding = 2;
  } else if (b64.endsWith("=")) {
    padding = 1;
  }
  return Math.max(0, Math.floor((len * 3) / 4) - padding);
}

export function toCropRect(
  bbox: AskBBox,
  scaleX: number,
  scaleY: number,
): AskBBox {
  const norm = normalizeBBox(bbox);
  return {
    x: norm.x * scaleX,
    y: norm.y * scaleY,
    width: norm.width * scaleX,
    height: norm.height * scaleY,
  };
}

type ClientRectLike = Pick<DOMRect, "left" | "top" | "width" | "height">;

/**
 * Element rect and bbox are both container-relative CSS px.
 * Touching edges do not count; bbox is normalized first.
 */
export function intersectsBBox(
  rect: ClientRectLike,
  containerRect: ClientRectLike,
  bbox: AskBBox,
): boolean {
  return intersects(
    {
      x: rect.left - containerRect.left,
      y: rect.top - containerRect.top,
      width: rect.width,
      height: rect.height,
    },
    normalizeBBox(bbox),
  );
}

function yieldEncodeTurn(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

/**
 * Only nodes that carry this attribute (and their subtree) leave the screenshot.
 * The ask panel root and the selection layer root do not carry it: the highlight
 * and the selection box stay. The preparing row, the 取消 button, and the
 * waiting text opt out explicitly.
 */
export const CAPTURE_EXCLUDE_SELECTOR = "[data-ask-capture-exclude]";

/**
 * The node or an ancestor carries data-ask-capture-exclude.
 * Text nodes stay; only elements can opt out.
 */
export function isCaptureExcluded(node: Node): boolean {
  return node instanceof Element && node.closest(CAPTURE_EXCLUDE_SELECTOR) !== null;
}

/**
 * Text nodes stay. iframe/video, the whole .monaco-editor subtree, and
 * data-ask-capture-exclude subtrees are dropped.
 * Other elements must hit the selection. Layout is read only when not already decided.
 */
function shouldDropCaptureNode(
  node: Node,
  containerRect: ClientRectLike,
  bbox: AskBBox,
): boolean {
  if (!(node instanceof Element)) return false;
  if (isCaptureExcluded(node)) return true;
  if (node.closest(".monaco-editor") !== null) return true;
  const tag = node.tagName.toUpperCase();
  if (tag === "IFRAME" || tag === "VIDEO") return true;
  return !intersectsBBox(node.getBoundingClientRect(), containerRect, bbox);
}

const FILTER_REJECT = 2;
const FILTER_ACCEPT = 1;

/**
 * Count elements modern-screenshot would keep. Subtrees whose root is dropped
 * are not entered. Stops once the count passes maxNodes.
 * Returns the dropped roots so the render filter can skip a second layout pass.
 */
function collectDroppedRoots(
  container: HTMLElement,
  containerRect: ClientRectLike,
  bbox: AskBBox,
): { tooMany: boolean; dropped: Set<Node> } {
  const dropped = new Set<Node>();
  const limit = CAPTURE_DEFAULTS.maxNodes;
  let kept = 0;
  const doc = container.ownerDocument;
  if (!doc || typeof doc.createTreeWalker !== "function") {
    return { tooMany: false, dropped };
  }
  const walker = doc.createTreeWalker(container, NodeFilter.SHOW_ELEMENT, {
    acceptNode(node: Node) {
      if (shouldDropCaptureNode(node, containerRect, bbox)) {
        dropped.add(node);
        return FILTER_REJECT;
      }
      kept += 1;
      if (kept > limit) return FILTER_REJECT;
      return FILTER_ACCEPT;
    },
  });
  // Walk only to populate `dropped` and `kept`. The root itself is not visited.
  while (walker.nextNode()) {
    if (kept > limit) break;
  }
  return { tooMany: kept > limit, dropped };
}

type EncodeOk = {
  ok: true;
  mime: "image/webp" | "image/jpeg";
  dataBase64: string;
  bytes: number;
};

function canEncodeOffThread(): boolean {
  return (
    typeof Worker === "function" &&
    typeof OffscreenCanvas === "function" &&
    typeof createImageBitmap === "function"
  );
}


/**
 * Crop + scale on the main thread via createImageBitmap, then encode in a
 * module worker. The main thread asks again with a smaller size when the
 * worker reports the blob is still over maxBytes. WebP stays on for those
 * retries; only the worker itself drops it when the browser cannot encode WebP.
 */
export async function encodeOffThread(
  canvas: HTMLCanvasElement,
  crop: { x: number; y: number; w: number; h: number },
  maxBytes: number,
  timedOut: () => boolean,
): Promise<EncodeOk | "TOO_LARGE" | "FALLBACK"> {
  if (!canEncodeOffThread()) return "FALLBACK";

  const worker = acquireEncodeWorker();
  if (!worker) return "FALLBACK";

  const webp = true;
  let outW = Math.max(
    1,
    Math.round(crop.w * Math.min(1, CAPTURE_DEFAULTS.maxLongSide / Math.max(crop.w, crop.h))),
  );
  let outH = Math.max(
    1,
    Math.round(crop.h * Math.min(1, CAPTURE_DEFAULTS.maxLongSide / Math.max(crop.w, crop.h))),
  );

  const retire = () => {
    retireEncodeWorker(worker);
  };

  try {
    for (let attempt = 0; attempt <= CAPTURE_DEFAULTS.maxDownscales; attempt++) {
      if (timedOut()) return "FALLBACK";
      if (attempt > 0) {
        outW = Math.max(1, Math.round(outW * CAPTURE_DEFAULTS.downscaleFactor));
        outH = Math.max(1, Math.round(outH * CAPTURE_DEFAULTS.downscaleFactor));
      }

      const bitmap = await createImageBitmap(canvas, crop.x, crop.y, crop.w, crop.h, {
        resizeWidth: outW,
        resizeHeight: outH,
      });
      if (timedOut()) {
        bitmap.close?.();
        return "FALLBACK";
      }

      const request: EncodeRequest = {
        bitmap,
        qualities: CAPTURE_DEFAULTS.qualities,
        maxBytes,
        webp,
      };
      let postedAt = 0;
      const response = await new Promise<EncodeResponse>((resolve, reject) => {
        const onMessage = (event: MessageEvent<EncodeResponse>) => {
          cleanup();
          resolve(event.data);
        };
        const onError = (event: ErrorEvent) => {
          cleanup();
          reject(event.error ?? new Error(event.message || "worker error"));
        };
        const onMessageError = () => {
          cleanup();
          reject(new Error("worker messageerror"));
        };
        const poll = setInterval(() => {
          if (timedOut()) {
            cleanup();
            reject(new Error("timeout"));
          }
        }, 50);
        const cleanup = () => {
          clearInterval(poll);
          worker.removeEventListener("message", onMessage);
          worker.removeEventListener("error", onError);
          worker.removeEventListener("messageerror", onMessageError);
        };
        worker.addEventListener("message", onMessage);
        worker.addEventListener("error", onError);
        worker.addEventListener("messageerror", onMessageError);
        postedAt = performance.now();
        worker.postMessage(request, [bitmap]);
        markAskPhase("postToWorkerMs", performance.now() - postedAt);
      });
      if (postedAt > 0) markAskPhase("encodeMs", performance.now() - postedAt);

      if (response.ok) {
        return {
          ok: true,
          mime: response.mime,
          dataBase64: response.base64,
          bytes: response.bytes,
        };
      }
      if ("tooLarge" in response && response.tooLarge) {
        continue;
      }
      return "FALLBACK";
    }
    return "TOO_LARGE";
  } catch {
    retire();
    return "FALLBACK";
  }
}

async function encodeOnMainThread(
  canvas: HTMLCanvasElement,
  crop: { x: number; y: number; w: number; h: number },
  maxBytes: number,
  timedOut: () => boolean,
): Promise<CaptureResult | null> {
  const longSide = Math.max(crop.w, crop.h);
  const initialScale = Math.min(1, CAPTURE_DEFAULTS.maxLongSide / longSide);
  let outW = Math.max(1, Math.round(crop.w * initialScale));
  let outH = Math.max(1, Math.round(crop.h * initialScale));
  let webpSupported = true;

  for (let attempt = 0; attempt <= CAPTURE_DEFAULTS.maxDownscales; attempt++) {
    if (timedOut()) return null;
    if (attempt > 0) {
      await yieldEncodeTurn();
      if (timedOut()) return null;
      outW = Math.max(1, Math.round(outW * CAPTURE_DEFAULTS.downscaleFactor));
      outH = Math.max(1, Math.round(outH * CAPTURE_DEFAULTS.downscaleFactor));
    }

    const outCanvas = document.createElement("canvas");
    outCanvas.width = outW;
    outCanvas.height = outH;
    const ctx = outCanvas.getContext("2d");
    if (!ctx) return { ok: false, reason: "NO_CONTEXT", fallbackText: "" };
    ctx.drawImage(canvas, crop.x, crop.y, crop.w, crop.h, 0, 0, outW, outH);

    for (let qi = 0; qi < CAPTURE_DEFAULTS.qualities.length; qi++) {
      if (qi > 0) {
        await yieldEncodeTurn();
        if (timedOut()) return null;
      }
      const q = CAPTURE_DEFAULTS.qualities[qi]!;
      let mime: "image/webp" | "image/jpeg" = "image/webp";
      let url: string;
      if (webpSupported) {
        url = outCanvas.toDataURL("image/webp", q);
        if (!url.startsWith("data:image/webp")) {
          webpSupported = false;
          mime = "image/jpeg";
          url = outCanvas.toDataURL("image/jpeg", q);
        }
      } else {
        mime = "image/jpeg";
        url = outCanvas.toDataURL("image/jpeg", q);
      }
      const base64 = url.slice(url.indexOf(",") + 1);
      const bytes = decodedBase64Bytes(base64);
      if (bytes <= maxBytes) {
        return { ok: true, encoder: "main", image: { mime, dataBase64: base64 }, bytes };
      }
    }
  }
  return { ok: false, reason: "TOO_LARGE", fallbackText: "" };
}

export async function captureStage(
  container: HTMLElement | null,
  sel: Pick<AskSelection, "bbox" | "targets">,
  opts?: {
    timeoutMs?: number;
    maxBytes?: number;
    signal?: AbortSignal;
    /**
     * Called when domToCanvas returns, before encode. submit starts its one
     * macrotask here, so the timer is queued after the long task and a
     * pointerdown queued during it is dispatched first. The returned promise
     * is awaited before encode, and signal can abort encode. Capture tests
     * omit it.
     */
    beforeEncode?: () => Promise<void>;
  },
): Promise<CaptureResult> {
  const fallbackText = buildFallbackText(sel.targets);

  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    if (!container) {
      return { ok: false, reason: "NO_CONTAINER", fallbackText };
    }

    const normBox = normalizeBBox(sel.bbox);
    if (normBox.width <= 0 || normBox.height <= 0) {
      return { ok: false, reason: "EMPTY_BBOX", fallbackText };
    }

    const timeoutMs = opts?.timeoutMs ?? CAPTURE_DEFAULTS.timeoutMs;
    const maxBytes = opts?.maxBytes ?? CAPTURE_DEFAULTS.maxBytes;
    const signal = opts?.signal;
    const beforeEncode = opts?.beforeEncode;

    let timedOut = false;
    const startedAt = Date.now();
    const captureStartedAt = performance.now();

    const timeoutPromise = new Promise<CaptureResult>((resolve) => {
      timer = setTimeout(() => {
        void (async () => {
          // The hook stall is one synchronous task. This timer runs when
          // that task ends, and a 取消 issued during the stall is still
          // 34–97ms from the renderer under 4× CPU. Resolving TIMEOUT on
          // this turn wins Promise.race and the ask is sent. The same
          // input settle encode uses lets that press abort first. No
          // signal means nothing can abort, so the timeout stands.
          if (signal) {
            await yieldMacrotask({ done: () => signal.aborted });
            // The yield returns when the macrotask runs or when the signal
            // is already aborted. A cancel queued behind this timeout
            // (setTimeout(0) registered after the timer) has not run yet.
            // One more macrotask lets that abort land before TIMEOUT wins.
            if (!signal.aborted) await yieldMacrotask({ done: () => signal.aborted });
            if (signal.aborted) {
              resolve(abortedResult());
              return;
            }
          }
          timedOut = true;
          resolve({ ok: false, reason: "TIMEOUT", fallbackText });
        })();
      }, timeoutMs);
    });

    const timeoutResult = (): CaptureResult => ({
      ok: false,
      reason: "TIMEOUT",
      fallbackText,
    });

    const abortedResult = (): CaptureResult => ({
      ok: false,
      reason: "ABORTED",
      fallbackText,
    });

    const doCapture = async (): Promise<CaptureResult> => {
      markAskTiming("captureStart");
      notePreCapture();
      // The busy 取消 row is painted by yieldPaintFrames() in the submit
      // handler: one animation frame, then one macrotask, and then capture
      // starts. A second paint here would run in the same turn as
      // domToCanvas when the outer frame has already flushed, which folds
      // worker setup and this listener turn into the long task the probe
      // attributes to render.
      if (timedOut) return timeoutResult();

      let mod: typeof import("modern-screenshot");
      try {
        mod = await import("modern-screenshot");
      } catch {
        return { ok: false, reason: "IMPORT_FAILED", fallbackText };
      }
      if (timedOut) return timeoutResult();

      const rect = container.getBoundingClientRect();
      const walk = collectDroppedRoots(container, rect, normBox);
      if (walk.tooMany) {
        return { ok: false, reason: "TOO_MANY_NODES", fallbackText };
      }
      const remaining = timeoutMs - (Date.now() - startedAt);
      if (remaining <= 0) return timeoutResult();

      const dropped = walk.dropped;
      let canvas: HTMLCanvasElement;
      try {
        // Compile-time stall. Next inlines a NEXT_PUBLIC_ value only when it
        // is set, and drops this block when the flag is not "1". An unset
        // flag is left as a runtime read, so a release build sets both to
        // "" (next.config env) and the marker string is gone. The loop is
        // synchronous and shares the domToCanvas task; the call is the next
        // statement. A hook build keeps the mark name as a string literal.
        // Hook build: NEXT_PUBLIC_ASK_TEST_BUILD=1 NEXT_PUBLIC_ASK_TEST_STALL_MS=1500
        if (process.env.NEXT_PUBLIC_ASK_TEST_BUILD === "1" && process.env.NEXT_PUBLIC_ASK_TEST_STALL_MS) {
          performance.mark("ASK_TEST_STALL_HOOK");
          const ms = Number(process.env.NEXT_PUBLIC_ASK_TEST_STALL_MS);
          const t = performance.now();
          while (performance.now() - t < ms) {
            /* busy */
          }
        }
        const rendered = await mod.domToCanvas(container, {
          font: false,
          scale: 1,
          features: { restoreScrollPosition: false },
          // Exclude only an explicitly marked node and the subtree under it.
          // The pre-walk already drops those roots; this second check covers
          // a node modern-screenshot still visits (the marked node itself).
          filter: (node) => !dropped.has(node) && !isCaptureExcluded(node),
          timeout: remaining,
          width: rect.width,
          height: rect.height,
        });
        if (timedOut) return timeoutResult();
        if (!rendered || typeof rendered.getContext !== "function") {
          return { ok: false, reason: "RENDER_FAILED", fallbackText };
        }
        canvas = rendered;
      } catch {
        return { ok: false, reason: "RENDER_FAILED", fallbackText };
      }
      const longTaskEndedAt = performance.now();
      noteLongTaskEnded(longTaskEndedAt);
      markAskTiming("longTaskEnd", longTaskEndedAt);
      markAskPhase("domToCanvasMs", longTaskEndedAt - captureStartedAt);

      // The stall is the task that just ended. One yield before encode, and
      // only one: submit's beforeEncode starts the macrotask now
      // (scheduler.yield, else setTimeout(0)) and does not yield again after
      // this returns. A caller that passes neither (the capture tests) gets
      // that same one macrotask here. A pointerdown queued during the stall
      // is dispatched during the yield; an abort then skips encode.
      const yieldForInput = beforeEncode ? beforeEncode() : signal ? Promise.resolve() : yieldMacrotask();
      await yieldForInput;
      if (signal?.aborted) return abortedResult();
      if (timedOut) return timeoutResult();

      const scaleX =
        Number.isFinite(rect.width) && rect.width > 0
          ? canvas.width / rect.width
          : 1;
      const scaleY =
        Number.isFinite(rect.height) && rect.height > 0
          ? canvas.height / rect.height
          : 1;

      const crop = toCropRect(sel.bbox, scaleX, scaleY);
      const cropX = Math.max(0, crop.x);
      const cropY = Math.max(0, crop.y);
      const cropRight = Math.min(canvas.width, crop.x + crop.width);
      const cropBottom = Math.min(canvas.height, crop.y + crop.height);
      const cropW = Math.max(0, cropRight - cropX);
      const cropH = Math.max(0, cropBottom - cropY);

      if (cropW <= 0 || cropH <= 0) {
        return { ok: false, reason: "EMPTY_BBOX", fallbackText };
      }

      const cropRect = { x: cropX, y: cropY, w: cropW, h: cropH };
      const isTimedOut = () => timedOut;

      if (canEncodeOffThread()) {
        const off = await encodeOffThread(canvas, cropRect, maxBytes, isTimedOut);
        if (timedOut) return timeoutResult();
        if (off === "TOO_LARGE") {
          return { ok: false, reason: "TOO_LARGE", fallbackText };
        }
        if (off !== "FALLBACK") {
          const encoded = {
            ok: true as const,
            encoder: "worker" as const,
            image: { mime: off.mime, dataBase64: off.dataBase64 },
            bytes: off.bytes,
          };
          noteCapturePerf(capturePerf("worker", off.mime, off.bytes, cropRect, canvas));
          return encoded;
        }
      }

      const main = await encodeOnMainThread(canvas, cropRect, maxBytes, isTimedOut);
      if (timedOut) return timeoutResult();
      if (!main) return timeoutResult();
      if (!main.ok) return { ...main, fallbackText };
      noteCapturePerf(capturePerf("main", main.image.mime, main.bytes, cropRect, canvas));
      return main;
    };

    return await Promise.race([doCapture(), timeoutPromise]);
  } catch {
    return { ok: false, reason: "RENDER_FAILED", fallbackText };
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

