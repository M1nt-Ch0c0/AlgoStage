/**
 * 屏幕区域截图与选区裁切 / Screen region capture and selection cropping.
 * Coordinates are container-relative CSS px, same as hitTest;
 * 400KB limit is measured as decoded bytes, consistent with M3 server check.
 */

import { ASK_LIMITS } from "@/lib/ask/types";
import type { AskBBox, AskSelection, AskTarget } from "@/lib/ask/types";
import { normalizeBBox } from "./hit-test";

export const CAPTURE_FALLBACK_NOTICE = "没截到图，这次只发送选中的文字。";

export type CaptureFailReason =
  | "NO_CONTAINER"
  | "EMPTY_BBOX"
  | "IMPORT_FAILED"
  | "RENDER_FAILED"
  | "NO_CONTEXT"
  | "TOO_LARGE"
  | "TIMEOUT";

export type CaptureResult =
  | {
      ok: true;
      image: { mime: "image/webp" | "image/jpeg"; dataBase64: string };
      bytes: number;
    }
  | {
      ok: false;
      reason: CaptureFailReason;
      fallbackText: string;
    };

export const CAPTURE_DEFAULTS = {
  timeoutMs: 3000,
  maxBytes: 400 * 1024,
  maxLongSide: 1280,
  qualities: [0.85, 0.7, 0.55],
  downscaleFactor: 0.75,
  maxDownscales: 2,
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

    const timeoutPromise = new Promise<CaptureResult>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        resolve({ ok: false, reason: "TIMEOUT", fallbackText });
      }, timeoutMs);
    });

    const doCapture = async (): Promise<CaptureResult> => {
      let mod: typeof import("modern-screenshot");
      try {
        mod = await import("modern-screenshot");
      } catch {
        return { ok: false, reason: "IMPORT_FAILED", fallbackText };
      }
      if (timedOut) {
        return { ok: false, reason: "TIMEOUT", fallbackText };
      }

      let canvas: HTMLCanvasElement;
      try {
        const rendered = await mod.domToCanvas(container);
        if (timedOut) {
          return { ok: false, reason: "TIMEOUT", fallbackText };
        }
        if (!rendered || typeof rendered.getContext !== "function") {
          return { ok: false, reason: "RENDER_FAILED", fallbackText };
        }
        canvas = rendered;
      } catch {
        return { ok: false, reason: "RENDER_FAILED", fallbackText };
      }

      const rect = container.getBoundingClientRect();
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

      const longSide = Math.max(cropW, cropH);
      const initialScale = Math.min(1, CAPTURE_DEFAULTS.maxLongSide / longSide);
      let outW = Math.max(1, Math.round(cropW * initialScale));
      let outH = Math.max(1, Math.round(cropH * initialScale));

      let webpSupported = true;
      for (
        let attempt = 0;
        attempt <= CAPTURE_DEFAULTS.maxDownscales;
        attempt++
      ) {
        if (attempt > 0) {
          outW = Math.max(
            1,
            Math.round(outW * CAPTURE_DEFAULTS.downscaleFactor),
          );
          outH = Math.max(
            1,
            Math.round(outH * CAPTURE_DEFAULTS.downscaleFactor),
          );
        }

        const outCanvas = document.createElement("canvas");
        outCanvas.width = outW;
        outCanvas.height = outH;
        const ctx = outCanvas.getContext("2d");
        if (!ctx) {
          return { ok: false, reason: "NO_CONTEXT", fallbackText };
        }

        ctx.drawImage(canvas, cropX, cropY, cropW, cropH, 0, 0, outW, outH);

        for (const q of CAPTURE_DEFAULTS.qualities) {
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
            return {
              ok: true,
              image: { mime, dataBase64: base64 },
              bytes,
            };
          }
        }
      }

      return { ok: false, reason: "TOO_LARGE", fallbackText };
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
