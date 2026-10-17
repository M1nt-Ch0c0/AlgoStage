/**
 * Classify a drag origin and crop a code-origin capture to the code area.
 * Pure geometry: no DOM, no store. Rects are normalized; non-finite ones are skipped.
 */

import type { AskBBox, AskSelectionMode, AskTarget } from "@/lib/ask/types";
import { normalizeBBox } from "@/lib/ask/hit-test";

export type OriginKind = "code" | "viz" | "other";

function finiteBBox(b: AskBBox): boolean {
  return Number.isFinite(b.x) && Number.isFinite(b.y) && Number.isFinite(b.width) && Number.isFinite(b.height);
}

/** Inclusive on every edge: a point exactly on a border counts as inside. */
function pointInRect(point: { x: number; y: number }, rect: AskBBox): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  );
}

/**
 * Positive-area intersection of two normalized boxes, or null.
 * Touching edges (zero area) do not count.
 */
function positiveIntersection(a: AskBBox, b: AskBBox): AskBBox | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  const width = right - x;
  const height = bottom - y;
  if (width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

/**
 * Origin kind from the sample point and the current layout.
 * A point inside viz is viz even when a code rect also covers it: the code
 * container includes padding the viz block can sit in. Code wins only when
 * the point is in code and not in viz.
 */
export function classifyOrigin(
  point: { x: number; y: number },
  codeRects: AskBBox[],
  vizRects: AskBBox[],
): OriginKind {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return "other";
  let inCode = false;
  for (const raw of codeRects) {
    if (!finiteBBox(raw)) continue;
    if (pointInRect(point, normalizeBBox(raw))) {
      inCode = true;
      break;
    }
  }
  for (const raw of vizRects) {
    if (!finiteBBox(raw)) continue;
    if (pointInRect(point, normalizeBBox(raw))) return "viz";
  }
  return inCode ? "code" : "other";
}

/**
 * Keep only code targets when the drag started in the code area, and recompute mode
 * from the filtered count (0 or 1 → single, more than 1 → region).
 * viz and other origins return the hit unchanged.
 */
export function filterHitByOrigin<T extends { mode: AskSelectionMode; targets: AskTarget[] }>(
  hit: T,
  kind: OriginKind,
): { mode: AskSelectionMode; targets: AskTarget[] } {
  if (kind !== "code") return hit;
  const targets = hit.targets.filter((target) => target.kind === "code");
  return { mode: targets.length > 1 ? "region" : "single", targets };
}

/**
 * Intersection of `box` with the code area.
 * Several code rects contribute the bounding box of their individual intersections.
 * Null when no intersection has positive area.
 */
export function codeCaptureBox(box: AskBBox, codeRects: AskBBox[]): AskBBox | null {
  if (!finiteBBox(box)) return null;
  const normBox = normalizeBBox(box);
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  let found = false;
  for (const raw of codeRects) {
    if (!finiteBBox(raw)) continue;
    const hit = positiveIntersection(normBox, normalizeBBox(raw));
    if (!hit) continue;
    found = true;
    left = Math.min(left, hit.x);
    top = Math.min(top, hit.y);
    right = Math.max(right, hit.x + hit.width);
    bottom = Math.max(bottom, hit.y + hit.height);
  }
  if (!found) return null;
  const width = right - left;
  const height = bottom - top;
  if (width <= 0 || height <= 0) return null;
  return { x: left, y: top, width, height };
}

/**
 * Screenshot crop uses the code-area intersection when the selection recorded one.
 * The on-screen bbox is left as the user drew it.
 */
export function resolveCaptureSelection<T extends { bbox: AskBBox; captureBBox?: AskBBox }>(sel: T): T {
  if (!sel.captureBBox) return sel;
  return { ...sel, bbox: sel.captureBBox };
}
