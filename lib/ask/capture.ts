/**
 * 屏幕区域截图与选区裁切 / Screen region capture and selection cropping.
 * Coordinates are container-relative CSS px, same as hitTest;
 * 400KB limit is measured as decoded bytes, consistent with M3 server check.
 */

import { ASK_LIMITS } from "@/lib/ask/types";
import type { AskBBox, AskSelection, AskTarget } from "@/lib/ask/types";
import { markAskPhase, markAskTiming, noteLongTaskEnded, notePreCapture } from "./ask-timing";
import { yieldForQueuedInput, yieldMacrotask } from "./yield-macrotask";
import { acquireEncodeWorker, retireEncodeWorker } from "./capture-worker";
import { intersects, normalizeBBox } from "./hit-test";
import type { EncodeRequest, EncodeResponse } from "./capture-encode";
import { resolveCaptureSelection } from "./origin-kind";

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
 * A node that carries this attribute, and the subtree under it, leaves the screenshot.
 * The selection layer root itself does not: it is a full-stage overlay, and dropping
 * it would drop the stage nodes stacked under it. The chrome inside it does carry
 * the attribute (gold selection border, dimming shadow, highlight outlines, rubber
 * band, hint, bottom bar). modern-screenshot copies a node's own box-shadow onto
 * the ancestor before the filter can drop the node, so that chrome is hidden on
 * the live element for the raster and restored in finally. The ask panel root
 * carries the attribute while the panel is open for capture (drafting, preparing,
 * error). While the panel is waiting, the root drops the attribute so the waiting
 * 取消 button has no excluded ancestor. Busy nodes (preparing row, waiting text,
 * the drafting 取消 button) stay marked too.
 */
export const CAPTURE_EXCLUDE_SELECTOR = "[data-ask-capture-exclude]";

/**
 * The node or an ancestor carries data-ask-capture-exclude.
 * Text nodes stay; only elements can opt out. An ancestor mark covers the
 * whole layer or panel, so selection chrome is excluded with the root.
 */
export function isCaptureExcluded(node: Node): boolean {
  return node instanceof Element && node.closest(CAPTURE_EXCLUDE_SELECTOR) !== null;
}

/**
 * Text nodes stay. iframe/video and data-ask-capture-exclude subtrees
 * (selection chrome, panel root, busy nodes) are dropped. Selection chrome
 * must not appear in the image. Other elements must hit the selection.
 * Layout is read only when not already decided.
 *
 * `.monaco-editor` is not dropped. Rejecting it collapses the code-board
 * flex child in the clone, so the viz sibling slides to the top of the
 * stage and the live selection crop lands on an empty band. The raster
 * hides each editor with visibility:hidden, which keeps the box and blanks
 * the glyphs. The board surface behind it still paints.
 *
 * A marked node returns FILTER_SKIP so the walk still enters its descendants.
 * FILTER_REJECT would hide every stage node stacked under a full-stage chrome
 * box (the selection's 9999px dimming shadow covers the stage). The render
 * filter still drops the marked node itself via isCaptureExcluded.
 */
function shouldDropCaptureNode(
  node: Node,
  containerRect: ClientRectLike,
  bbox: AskBBox,
): boolean | "skip" {
  if (!(node instanceof Element)) return false;
  if (isCaptureExcluded(node)) return "skip";
  const tag = node.tagName.toUpperCase();
  if (tag === "IFRAME" || tag === "VIDEO") return true;
  return !intersectsBBox(node.getBoundingClientRect(), containerRect, bbox);
}

const FILTER_REJECT = 2;
const FILTER_ACCEPT = 1;
const FILTER_SKIP = 3;

/**
 * Live spacer → clone. modern-screenshot clones with cloneNode(false) and
 * onCloneEachNode only receives the clone, so the height cannot travel on a
 * Map of live nodes. The attribute is set before the clone and removed in
 * the same finally as the chrome restore.
 */
const SPACER_HEIGHT_ATTR = "data-ask-capture-spacer-h";
/** Padding-top of a kept box whose top sits above the selection. */
const PAD_ABOVE_ATTR = "data-ask-capture-pad-above";

/**
 * Blank Monaco and clear selection-chrome shadows for the raster. Returns
 * the undo.
 *
 * The filter drops chrome, but modern-screenshot reads computed style on the
 * live node first and paints box-shadow, border, and outline onto the
 * ancestor (or onto the last row of the crop). The selection's 9999px dim
 * is a box-shadow. The gold ring is a border. Clearing those inline values
 * removes that paint. display:none would too, and it also collapses the
 * stage column in the clone, so the viz slides up and the live crop misses
 * it. The panel is not touched here: the filter drops it.
 *
 * Monaco stays in the clone. visibility:hidden blanks the glyphs and keeps
 * the live box. display:none would collapse the code board.
 *
 * Restore runs in finally so a thrown raster still puts both back.
 */
/** Zero width and a transparent color. "none" alone still serializes a style. */
const CHROME_BORDER_CLEAR = "0px none transparent";
const CHROME_OUTLINE_CLEAR = "0px none transparent";

/**
 * The narration chalk caret (inline-block ~2×16 gold bar under the subtitle).
 * Class match first; computed width/height when Tailwind classes are absent.
 */
function isSubtitleChalkCaret(node: HTMLElement): boolean {
  const classes = node.classList;
  if (classes.contains("h-4") && classes.contains("w-[2px]")) return true;
  const view = node.ownerDocument?.defaultView;
  if (!view || typeof view.getComputedStyle !== "function") return false;
  const style = view.getComputedStyle(node);
  const width = Number.parseFloat(style.width);
  const height = Number.parseFloat(style.height);
  return (
    Number.isFinite(width) &&
    Number.isFinite(height) &&
    Math.abs(width - 2) <= 0.5 &&
    Math.abs(height - 16) <= 1
  );
}

/**
 * Uma 390 — stop caret-hop before the clone reads computed style so the gold
 * bar stays at rest (transform none). Do not nudge translateY: a +2px shift
 * lands the caret below the closed-panel baseline. Filter (drop-shadow) stays.
 * Returns the undo. Called beside hideCaptureChromeForRaster and restored
 * in the same finally.
 */
function freezeSubtitleCaretForRaster(container: HTMLElement): () => void {
  const spans = container.querySelectorAll('[data-ask-target="subtitle"] span');
  const previous: { el: HTMLElement; animation: string; transform: string; filter: string }[] = [];
  for (const node of spans) {
    if (!(node instanceof HTMLElement)) continue;
    if (!isSubtitleChalkCaret(node)) continue;
    previous.push({
      el: node,
      animation: node.style.animation,
      transform: node.style.transform,
      filter: node.style.filter,
    });
    node.style.animation = "none";
    node.style.transform = "none";
  }
  return () => {
    for (const item of previous) {
      item.el.style.animation = item.animation;
      item.el.style.transform = item.transform;
      item.el.style.filter = item.filter;
    }
  };
}

function hideCaptureChromeForRaster(container: HTMLElement): () => void {
  const marked = container.querySelectorAll(`[data-ask-layer] ${CAPTURE_EXCLUDE_SELECTOR}`);
  const previous: { el: HTMLElement; boxShadow: string; border: string; outline: string }[] = [];
  for (const node of marked) {
    if (!(node instanceof HTMLElement)) continue;
    previous.push({
      el: node,
      boxShadow: node.style.boxShadow,
      border: node.style.border,
      outline: node.style.outline,
    });
    // The gold ring is a 2px border (and sometimes an outline). modern-screenshot
    // copies the computed longhand onto an ancestor before the filter drops the
    // node. "none" still leaves a style keyword; a zero transparent border does not.
    node.style.boxShadow = "none";
    node.style.border = CHROME_BORDER_CLEAR;
    node.style.outline = CHROME_OUTLINE_CLEAR;
  }
  const editors = container.querySelectorAll(".monaco-editor");
  const editorPrevious: { el: HTMLElement; visibility: string }[] = [];
  for (const node of editors) {
    if (!(node instanceof HTMLElement)) continue;
    editorPrevious.push({ el: node, visibility: node.style.visibility });
    node.style.visibility = "hidden";
  }
  return () => {
    for (const item of previous) {
      item.el.style.boxShadow = item.boxShadow;
      item.el.style.border = item.border;
      item.el.style.outline = item.outline;
    }
    for (const item of editorPrevious) item.el.style.visibility = item.visibility;
  };
}

/**
 * A computed background that paints something. "transparent" and rgba alpha 0
 * do not. Semi-transparent colors still count: the caller uses them as-is.
 */
function isPaintedBackground(color: string): boolean {
  const value = color.trim().toLowerCase();
  if (value === "" || value === "transparent") return false;
  const rgba = value.match(/^rgba?\(([^)]+)\)$/);
  if (!rgba) return true;
  const parts = rgba[1]!.split(/[\s,/]+/).filter((part) => part.length > 0);
  if (parts.length < 4) return true;
  const alpha = Number(parts[3]);
  // A non-numeric alpha (for example a percentage) is not "alpha 0".
  if (!Number.isFinite(alpha)) return true;
  return alpha > 0;
}

/**
 * Effective stage background for the screenshot. The cloned subtree often has
 * no opaque fill of its own (the code area and the stage are transparent), so
 * the first painted ancestor is what the user actually sees. Walks from `el`
 * through ancestors, then document.body and document.documentElement. Falls
 * back to the computed --color-board-950 on documentElement, else "#000".
 */
export function resolveStageBackground(el: Element): string {
  const seen = new Set<Element>();
  const chain: Element[] = [];
  for (let node: Element | null = el; node; node = node.parentElement) {
    chain.push(node);
    seen.add(node);
  }
  const doc = el.ownerDocument;
  const root = doc?.documentElement ?? null;
  const body = doc?.body ?? null;
  if (body && !seen.has(body)) chain.push(body);
  if (root && !seen.has(root)) chain.push(root);

  const view = doc?.defaultView;
  if (view && typeof view.getComputedStyle === "function") {
    for (const node of chain) {
      const color = view.getComputedStyle(node).backgroundColor;
      if (typeof color === "string" && isPaintedBackground(color)) return color;
    }
  }

  if (root && view && typeof view.getComputedStyle === "function") {
    const variable = view.getComputedStyle(root).getPropertyValue("--color-board-950").trim();
    if (variable) return variable;
  }
  return "#000";
}

/**
 * A flex/grid item that sits entirely above the selection and whose parent
 * does hit the selection. Dropping it collapses that column in the clone
 * (modern-screenshot does not copy used width/height), so the kept sibling
 * slides up and the live crop lands on an empty band. The code board is the
 * one that does this: it does not intersect a viz selection, and rejecting
 * it is what flattened the capture.
 *
 * A box beside the selection (the tutor column) overlaps the selection
 * vertically, so it is not a spacer. A box below the selection is not one
 * either: it does not move the crop.
 *
 * The subtitle card is `display:block`. Its header is a flex row that sits
 * entirely above a body selection. Rejecting it pulls the narration line up
 * by the header's height. A flex item of any other block (the viz card
 * header) is not a spacer: pinning that one shifts the cards down. Absolute
 * and fixed boxes are not spacers either.
 */
function isLayoutSpacer(node: Node, containerRect: ClientRectLike, bbox: AskBBox): boolean {
  if (!(node instanceof HTMLElement)) return false;
  const parent = node.parentElement;
  if (!parent) return false;
  const view = node.ownerDocument?.defaultView;
  if (!view || typeof view.getComputedStyle !== "function") return false;
  const parentStyle = view.getComputedStyle(parent);
  const ownStyle = view.getComputedStyle(node);
  // An out-of-flow box does not push the selection's siblings.
  const position = ownStyle.position || node.style.position;
  if (position === "absolute" || position === "fixed") return false;
  // Computed style is authoritative. A test DOM that does not resolve flex
  // still carries the inline display the page set, and that is enough to
  // know the parent is a column.
  const display = parentStyle.display === "flex" || parentStyle.display === "inline-flex" || parentStyle.display === "grid" || parentStyle.display === "inline-grid" || parentStyle.display === "block" || parentStyle.display === "flow-root"
    ? parentStyle.display
    : parent.style.display;
  const flexDirection = parentStyle.flexDirection === "column" || parentStyle.flexDirection === "column-reverse"
    ? parentStyle.flexDirection
    : parent.style.flexDirection || parentStyle.flexDirection;
  const column =
    (display === "flex" || display === "inline-flex") &&
    (flexDirection === "column" || flexDirection === "column-reverse");
  const grid = display === "grid" || display === "inline-grid";
  // Only the subtitle card. Its header is a flex row, and dropping it pulls
  // the narration line up. The same shape on the viz card must stay dropped:
  // pinning that header shifts the cards down by its own height.
  const subtitleCard =
    (display === "block" || display === "flow-root") &&
    parent.getAttribute("data-ask-target") === "subtitle";
  if (!column && !grid && !subtitleCard) return false;
  if (!intersectsBBox(parent.getBoundingClientRect(), containerRect, bbox)) return false;
  const rect = node.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return false;
  if (intersectsBBox(rect, containerRect, bbox)) return false;
  const bottom = rect.top - containerRect.top + rect.height;
  const norm = normalizeBBox(bbox);
  return bottom <= norm.y + 1;
}

/**
 * Count elements modern-screenshot would keep. Subtrees whose root is dropped
 * are not entered. Stops once the count passes maxNodes.
 * Returns the dropped roots so the render filter can skip a second layout pass,
 * and the spacer boxes whose clone height has to be pinned.
 */
function collectDroppedRoots(
  container: HTMLElement,
  containerRect: ClientRectLike,
  bbox: AskBBox,
): { tooMany: boolean; dropped: Set<Node>; spacers: Map<Node, number>; pads: Map<Node, number> } {
  const dropped = new Set<Node>();
  const spacers = new Map<Node, number>();
  const pads = new Map<Node, number>();
  const limit = CAPTURE_DEFAULTS.maxNodes;
  let kept = 0;
  const doc = container.ownerDocument;
  if (!doc || typeof doc.createTreeWalker !== "function") {
    return { tooMany: false, dropped, spacers, pads };
  }
  const walker = doc.createTreeWalker(container, NodeFilter.SHOW_ELEMENT, {
    acceptNode(node: Node) {
      const drop = shouldDropCaptureNode(node, containerRect, bbox);
      // "skip" is a marked chrome node. Do not count it and do not reject
      // the subtree: stage content under the overlay still has to be kept.
      // The render filter drops the chrome node itself.
      if (drop === "skip") return FILTER_SKIP;
      // A column item above the selection stays, as an empty box. Rejecting
      // it collapses the column. Its descendants still drop.
      if (drop && isLayoutSpacer(node, containerRect, bbox) && node instanceof HTMLElement) {
        spacers.set(node, node.getBoundingClientRect().height);
        kept += 1;
        if (kept > limit) return FILTER_REJECT;
        return FILTER_SKIP;
      }
      if (drop) {
        dropped.add(node);
        return FILTER_REJECT;
      }
      if (node instanceof HTMLElement) {
        const pad = paddingAboveSelection(node, containerRect, bbox);
        if (pad > 0) pads.set(node, pad);
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
  return { tooMany: kept > limit, dropped, spacers, pads };
}

/**
 * Padding-top of the tutor section when that padding sits above the
 * selection. On a 390 subtitle crop the section's 16px padding is above the
 * line, and foreignObject drops the copied value. The viz card has padding
 * too, and doubling that one shifts the cards, so only this section is
 * recorded. A section whose top is inside the selection contributes nothing.
 */
function paddingAboveSelection(node: HTMLElement, containerRect: ClientRectLike, bbox: AskBBox): number {
  if (node.tagName !== "SECTION") return 0;
  if (!node.classList.contains("rounded-2xl")) return 0;
  const view = node.ownerDocument?.defaultView;
  if (!view || typeof view.getComputedStyle !== "function") return 0;
  const paddingTop = Number.parseFloat(view.getComputedStyle(node).paddingTop || "");
  if (!Number.isFinite(paddingTop) || paddingTop <= 0) return 0;
  const top = node.getBoundingClientRect().top - containerRect.top;
  const norm = normalizeBBox(bbox);
  const measured = Math.max(0, Math.min(paddingTop, norm.y - top));
  // Uma 390: offline dy=+1 on the closed-panel crop vs pre-encode. One extra
  // CSS px of pad-above shifts the subtitle glyphs onto that baseline.
  if (measured <= 0) return 0;
  return measured + 1;
}

/** Exported so the capture unit test can pair a live spacer with its clone. */
export const CAPTURE_SPACER_HEIGHT_ATTR = SPACER_HEIGHT_ATTR;

/**
 * modern-screenshot copies computed style but ignores width and height, and
 * a foreignObject lays `height` out as the content box. A content-box height
 * equal to the live border box put the viz 6px high. Adding the element's
 * own padding-bottom (the board's 6px) put it on the live crop. flex-basis
 * matches that content height so the column does not grow the item back.
 */
function pinClonedSpacer(cloned: HTMLElement, borderBoxHeight: number): void {
  const paddingBottom = Number.parseFloat(cloned.style.paddingBottom || "");
  const extra = Number.isFinite(paddingBottom) ? paddingBottom : 0;
  const content = Math.max(0, borderBoxHeight + extra);
  cloned.style.setProperty("box-sizing", "content-box", "important");
  cloned.style.setProperty("height", `${content}px`, "important");
  cloned.style.setProperty("min-height", "0px", "important");
  cloned.style.setProperty("max-height", `${content}px`, "important");
  cloned.style.setProperty("flex-grow", "0", "important");
  cloned.style.setProperty("flex-shrink", "0", "important");
  cloned.style.setProperty("flex-basis", `${content}px`, "important");
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
  selection: Pick<AskSelection, "bbox" | "targets"> & { captureBBox?: AskBBox },
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
  const sel = resolveCaptureSelection(selection);
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
          // The real fallback a caller sees is this 3s budget plus up to
          // 120ms: the settle below is ASK_INPUT_SETTLE_MS, the same wait
          // encode uses before it continues.
          if (signal) {
            await yieldMacrotask({ done: () => signal.aborted });
            // The yield returns when the macrotask runs or when the signal
            // is already aborted. A cancel queued behind this timeout
            // (setTimeout(0) registered after the timer) has not run yet:
            // the post-capture settle is already waiting its own macrotask,
            // so the abort is the timer after this one. Yield again, and
            // once more if that abort is still behind, before TIMEOUT wins.
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
      const spacers = walk.spacers;
      const pads = walk.pads;
      let canvas: HTMLCanvasElement;
      try {
        // Compile-time stall. Next inlines a NEXT_PUBLIC_ value only when it
        // is set, and drops this block when the flag is not "1". An unset
        // flag is left as a runtime read, so a release build sets both to
        // "" (next.config env) and the marker string is gone. The loop is
        // synchronous and shares the domToCanvas task; the call is the next
        // statement. A hook build keeps the mark name as a string literal.
        // Hook build: NEXT_PUBLIC_ASK_TEST_BUILD=1 NEXT_PUBLIC_ASK_TEST_STALL_MS=1500
        let stalled = false;
        if (process.env.NEXT_PUBLIC_ASK_TEST_BUILD === "1" && process.env.NEXT_PUBLIC_ASK_TEST_STALL_MS) {
          performance.mark("ASK_TEST_STALL_HOOK");
          const ms = Number(process.env.NEXT_PUBLIC_ASK_TEST_STALL_MS);
          const t = performance.now();
          while (performance.now() - t < ms) {
            /* busy */
          }
          // End of the same stall. The 390 cancel spec measures the cancel
          // pointerdown against [ASK_TEST_STALL_HOOK, ASK_TEST_STALL_HOOK_END].
          performance.mark("ASK_TEST_STALL_HOOK_END");
          performance.measure(
            "ASK_TEST_STALL_HOOK",
            "ASK_TEST_STALL_HOOK",
            "ASK_TEST_STALL_HOOK_END",
          );
          stalled = true;
        }
        // One input yield before raster. A 取消 queued during the stall is
        // not in this thread yet: the CDP command lands on the next
        // macrotask and the pointer events follow, measured 34–97ms after
        // the thread frees under 4× CPU. Two macrotasks miss that tail and
        // raster starts, so the panel stays up for the whole raster. After
        // the stall, wait the same settle encode uses and stop the moment
        // the signal aborts, which skips domToCanvas. With no stall the
        // press is already queued, so one two-macrotask yield is enough and
        // the happy path does not pay the settle. The post-raster
        // beforeEncode yield stays. No signal (the capture unit tests) has
        // nothing that can abort, so it does not wait.
        if (signal) {
          await (stalled
            ? yieldMacrotask({ signal, done: () => signal.aborted })
            : yieldForQueuedInput(signal));
          if (signal.aborted) return abortedResult();
          if (timedOut) return timeoutResult();
        }
        // Segment the domToCanvas task. modern-screenshot 4.7 calls
        // onCloneEachNode per cloned node, onCloneNode once the clone tree
        // (including computed-style inlining) is built, onEmbedNode after
        // fonts and images are embedded, and onCreateForeignObjectSvg once
        // the svg exists. Durations are relative to this call. markAskPhase
        // no-ops unless the probe is installed. The node counts are not
        // durations, so they are written on that same probe.
        const domToCanvasStartedAt = performance.now();
        let cloneDoneAt = domToCanvasStartedAt;
        let embedDoneAt = domToCanvasStartedAt;
        let clonedNodes = 0;
        const probe = typeof window !== "undefined" ? window.__ASK_TIMING__ : undefined;
        if (probe && typeof probe === "object") {
          probe.captureSourceNodes = container.querySelectorAll("*").length;
        }
        // Clear chrome shadow, border, and outline, and blank Monaco before
        // the clone reads computed style. The filter still drops the chrome.
        // Restore in finally, including when domToCanvas throws, so the
        // selection and the editor come back.
        const restoreExcluded = hideCaptureChromeForRaster(container);
        let restoreCaret: () => void = () => {};
        let rendered: HTMLCanvasElement | null = null;
        try {
          // Uma 390: freeze the chalk caret beside the chrome clear, before
          // the clone reads computed style. Same finally restores it.
          restoreCaret = freezeSubtitleCaretForRaster(container);
          // Stamp after chrome is hidden and before the clone reads the node.
          // The finally below clears it even when the raster throws.
          for (const [node, height] of spacers) {
            if (node instanceof Element) node.setAttribute(SPACER_HEIGHT_ATTR, String(height));
          }
          for (const [node, pad] of pads) {
            if (node instanceof Element) node.setAttribute(PAD_ABOVE_ATTR, String(pad));
          }
          rendered = await mod.domToCanvas(container, {
            font: false,

            scale: 1,
            features: { restoreScrollPosition: false },
            // The stage and the code area are transparent. modern-screenshot
            // otherwise leaves those pixels clear, so the sent image is almost
            // entirely alpha 0 once the panel overlay is excluded. Fill with
            // the background the user sees behind the stage.
            backgroundColor: resolveStageBackground(container),
            // Drop marked chrome (selection border, highlights, rubber band, bar,
            // panel, busy nodes). The pre-walk skips those nodes without
            // rejecting the subtree, so this check is what keeps the chrome
            // itself out. iframe and video stay dropped in the pre-walk.
            // Monaco is kept and blanked in place (visibility:hidden). A
            // column item that sits above the selection (the code board on a
            // viz crop) is also kept: dropping it collapses the column.
            // Its height is pinned in onCloneEachNode. Descendants of that
            // item stay dropped, so the board paints as an empty box.
            filter: (node) =>
              (node instanceof Element && node.hasAttribute(SPACER_HEIGHT_ATTR)) ||
              (!dropped.has(node) && !isCaptureExcluded(node)),
            timeout: remaining,
            width: rect.width,
            height: rect.height,
            onCloneEachNode: (cloned: Node) => {
              clonedNodes += 1;
              if (!(cloned instanceof HTMLElement)) return;
              const padRaw = cloned.getAttribute(PAD_ABOVE_ATTR);
              if (padRaw !== null) {
                const pad = Number(padRaw);
                cloned.removeAttribute(PAD_ABOVE_ATTR);
                // copyCssStyles already wrote padding-top. foreignObject
                // ignores that copy on a flex section whose top is above the
                // crop. Writing the same number again is a no-op. Adding the
                // measured amount, with priority, is what puts the line back.
                if (Number.isFinite(pad) && pad > 0) {
                  const current = Number.parseFloat(cloned.style.paddingTop || "");
                  const next = (Number.isFinite(current) ? current : 0) + pad;
                  cloned.style.setProperty("padding-top", `${next}px`, "important");
                }
              }
              const raw = cloned.getAttribute(SPACER_HEIGHT_ATTR);
              if (raw !== null) {
                const height = Number(raw);
                cloned.removeAttribute(SPACER_HEIGHT_ATTR);
                if (Number.isFinite(height) && height > 0) pinClonedSpacer(cloned, height);
              }
            },
            onCloneNode: () => {
              cloneDoneAt = performance.now();
              markAskPhase("captureCloneMs", cloneDoneAt - domToCanvasStartedAt);
            },
            onEmbedNode: () => {
              embedDoneAt = performance.now();
              markAskPhase("captureEmbedMs", embedDoneAt - cloneDoneAt);
            },
            onCreateForeignObjectSvg: () => {
              markAskPhase("captureSvgMs", performance.now() - embedDoneAt);
            },
          });
        } finally {
          restoreCaret();
          restoreExcluded();
          for (const node of spacers.keys()) {
            if (node instanceof Element) node.removeAttribute(SPACER_HEIGHT_ATTR);
          }
          for (const node of pads.keys()) {
            if (node instanceof Element) node.removeAttribute(PAD_ABOVE_ATTR);
          }
        }
        markAskPhase("captureRasterMs", performance.now() - domToCanvasStartedAt);
        if (probe && typeof probe === "object") {
          probe.captureClonedNodes = clonedNodes;
        }
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
      // The selection bbox is fractional CSS px. drawImage samples integer
      // device pixels, so floor the origin and ceil the far edge. The pixel
      // harness screenshots this same integer rect at scale "css".
      const cropX = Math.max(0, Math.floor(crop.x));
      const cropY = Math.max(0, Math.floor(crop.y));
      const cropRight = Math.min(canvas.width, Math.ceil(crop.x + crop.width));
      const cropBottom = Math.min(canvas.height, Math.ceil(crop.y + crop.height));
      const cropW = Math.max(0, cropRight - cropX);
      const cropH = Math.max(0, cropBottom - cropY);

      if (cropW <= 0 || cropH <= 0) {
        return { ok: false, reason: "EMPTY_BBOX", fallbackText };
      }

      const cropRect = { x: cropX, y: cropY, w: cropW, h: cropH };
      // Uma 390: a 1px gold-ring remnant still lands on the last crop row after
      // the live border clear (modern-screenshot copies longhands onto an
      // ancestor). Copy the row above over it so the fill matches the crop's
      // board (not board-950 from resolveStageBackground). Only when that last
      // row is a flat near-gold band (not real content).
      {
        const rowH = Math.max(1, Math.round(scaleY));
        const ctx = canvas.getContext("2d");
        if (ctx && cropW > 0 && cropH >= rowH * 2) {
          const y = cropBottom - rowH;
          const sample = ctx.getImageData(cropX, y, Math.min(cropW, 32), rowH).data;
          let flat = true;
          const r0 = sample[0]!, g0 = sample[1]!, b0 = sample[2]!;
          // Gold remnant is olive (~52,56,38), not chalk and not the open board.
          const looksGold =
            r0 > 40 && r0 < 80 && g0 > 40 && g0 < 80 && b0 > 25 && b0 < 55 &&
            Math.abs(r0 - g0) < 15;
          for (let i = 4; i < sample.length; i += 4) {
            if (
              Math.abs(sample[i]! - r0) > 6 ||
              Math.abs(sample[i + 1]! - g0) > 6 ||
              Math.abs(sample[i + 2]! - b0) > 6
            ) {
              flat = false;
              break;
            }
          }
          if (flat && looksGold) {
            ctx.drawImage(
              canvas,
              cropX,
              y - rowH,
              cropW,
              rowH,
              cropX,
              y,
              cropW,
              rowH,
            );
          }
        }
      }
      // Test-only. The probe object is installed by the harness before
      // submit. A page that never sets it (including a release build) does
      // not allocate or keep the pre-encode canvas.
      const canvasProbe = typeof window !== "undefined" ? window.__ASK_TIMING__ : undefined;
      if (canvasProbe && typeof canvasProbe === "object" && cropW > 0 && cropH > 0) {
        const preEncode = document.createElement("canvas");
        preEncode.width = cropW;
        preEncode.height = cropH;
        const preCtx = preEncode.getContext("2d");
        if (preCtx) {
          preCtx.drawImage(canvas, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);
          canvasProbe.captureCanvas = preEncode;
        }
      }
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

