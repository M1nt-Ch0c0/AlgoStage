/**
 * 屏幕区域截图与选区裁切 / Screen region capture and selection cropping.
 * Coordinates are container-relative CSS px, same as hitTest;
 * 400KB limit is measured as decoded bytes, consistent with M3 server check.
 */

import { ASK_LIMITS } from "@/lib/ask/types";
import type { AskBBox, AskSelection, AskTarget } from "@/lib/ask/types";
import { markAskPhase, markAskTiming } from "./ask-timing";
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
  | "TIMEOUT";

export type CaptureEncoder = "worker" | "main";

export type CapturePerfInfo = {
  encoder: CaptureEncoder;
  mime: "image/webp" | "image/jpeg";
  bytes: number;
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

/** Let the preparing line paint before import and domToCanvas. */
export function yieldTwoFrames(): Promise<void> {
  const raf = globalThis.requestAnimationFrame;
  if (typeof raf !== "function") {
    return new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }
  return new Promise((resolve) => {
    raf(() => {
      raf(() => {
        resolve();
      });
    });
  });
}

function yieldEncodeTurn(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

/**
 * Text nodes stay. iframe/video and the whole .monaco-editor subtree are dropped.
 * Other elements must hit the selection. Layout is read only when not already decided.
 */
function shouldDropCaptureNode(
  node: Node,
  containerRect: ClientRectLike,
  bbox: AskBBox,
): boolean {
  if (!(node instanceof Element)) return false;
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

  let worker: Worker;
  try {
    worker = new Worker(new URL("./capture-encode.worker.ts", import.meta.url), {
      type: "module",
    });
  } catch {
    return "FALLBACK";
  }

  const webp = true;
  let outW = Math.max(
    1,
    Math.round(crop.w * Math.min(1, CAPTURE_DEFAULTS.maxLongSide / Math.max(crop.w, crop.h))),
  );
  let outH = Math.max(
    1,
    Math.round(crop.h * Math.min(1, CAPTURE_DEFAULTS.maxLongSide / Math.max(crop.w, crop.h))),
  );

  const finish = () => {
    worker.terminate();
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
    return "FALLBACK";
  } finally {
    finish();
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
  opts?: { timeoutMs?: number; maxBytes?: number },
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

    let timedOut = false;
    const startedAt = Date.now();

    const timeoutPromise = new Promise<CaptureResult>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        resolve({ ok: false, reason: "TIMEOUT", fallbackText });
      }, timeoutMs);
    });

    const timeoutResult = (): CaptureResult => ({
      ok: false,
      reason: "TIMEOUT",
      fallbackText,
    });

    const doCapture = async (): Promise<CaptureResult> => {
      markAskTiming("captureStart");
      await yieldTwoFrames();
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
        const rendered = await mod.domToCanvas(container, {
          font: false,
          scale: 1,
          features: { restoreScrollPosition: false },
          filter: (node) => !dropped.has(node),
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
      markAskTiming("longTaskEnd");
      markAskPhase("domToCanvasMs", performance.now() - startedAt);

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
          noteCapturePerf({ encoder: "worker", mime: off.mime, bytes: off.bytes });
          return encoded;
        }
      }

      const main = await encodeOnMainThread(canvas, cropRect, maxBytes, isTimedOut);
      if (timedOut) return timeoutResult();
      if (!main) return timeoutResult();
      if (!main.ok) return { ...main, fallbackText };
      noteCapturePerf({ encoder: "main", mime: main.image.mime, bytes: main.bytes });
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

