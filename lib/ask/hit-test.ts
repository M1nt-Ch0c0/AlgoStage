import { ASK_LIMITS } from "@/lib/ask/types";
import type { AskBBox, AskCandidate, AskSelectionMode, AskTarget } from "@/lib/ask/types";

function finiteBBox(b: AskBBox): boolean {
  return Number.isFinite(b.x) && Number.isFinite(b.y) && Number.isFinite(b.width) && Number.isFinite(b.height);
}

/** Flip a negative width or height so the box stays in place and both sides are >= 0. */
export function normalizeBBox(b: AskBBox): AskBBox {
  let { x, y, width, height } = b;
  if (width < 0) {
    x += width;
    width = -width;
  }
  if (height < 0) {
    y += height;
    height = -height;
  }
  return { x, y, width, height };
}

/** True only when the overlap has strictly positive area on both axes. Touching edges do not count. */
export function intersects(a: AskBBox, b: AskBBox): boolean {
  const left = Math.max(a.x, b.x);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const top = Math.max(a.y, b.y);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return right - left > 0 && bottom - top > 0;
}

/**
 * Expand any side shorter than `min` around the rect center.
 * The input is normalized first. Default min is ASK_LIMITS.minTouchPx (44).
 */
export function expandToMinTouch(r: AskBBox, min: number = ASK_LIMITS.minTouchPx): AskBBox {
  const box = normalizeBBox(r);
  let { x, y, width, height } = box;
  if (width < min) {
    x -= (min - width) / 2;
    width = min;
  }
  if (height < min) {
    y -= (min - height) / 2;
    height = min;
  }
  return { x, y, width, height };
}

function emptySingle(): { mode: "single"; targets: AskTarget[] } {
  return { mode: "single", targets: [] };
}

/**
 * Point hit. Exact hits use a half-open rect (includes the left and top edges,
 * excludes the right and bottom). Among exact hits, the smallest area wins
 * (first candidate on a tie). With no exact hit, the same half-open test runs
 * against expandToMinTouch rects and the nearest center wins (first on a tie).
 * Candidates whose rect has a non-finite number are skipped. Non-finite x/y
 * returns an empty single selection.
 */
export function hitTestPoint(
  x: number,
  y: number,
  candidates: readonly AskCandidate[],
): { mode: "single"; targets: AskTarget[] } {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return emptySingle();

  let best: AskCandidate | undefined;
  let bestArea = Infinity;
  for (const candidate of candidates) {
    if (!finiteBBox(candidate.rect)) continue;
    const rect = normalizeBBox(candidate.rect);
    const right = rect.x + rect.width;
    const bottom = rect.y + rect.height;
    if (x >= rect.x && x < right && y >= rect.y && y < bottom) {
      const area = rect.width * rect.height;
      if (best === undefined || area < bestArea) {
        best = candidate;
        bestArea = area;
      }
    }
  }
  if (best) return { mode: "single", targets: [best.target] };

  let nearest: AskCandidate | undefined;
  let nearestDist = Infinity;
  for (const candidate of candidates) {
    if (!finiteBBox(candidate.rect)) continue;
    const rect = expandToMinTouch(candidate.rect);
    const right = rect.x + rect.width;
    const bottom = rect.y + rect.height;
    if (x >= rect.x && x < right && y >= rect.y && y < bottom) {
      const cx = rect.x + rect.width / 2;
      const cy = rect.y + rect.height / 2;
      const dist = Math.hypot(x - cx, y - cy);
      if (nearest === undefined || dist < nearestDist) {
        nearest = candidate;
        nearestDist = dist;
      }
    }
  }
  if (!nearest) return emptySingle();
  return { mode: "single", targets: [nearest.target] };
}

/**
 * Region hit. A non-finite bbox returns an empty single selection.
 * After normalize, a side shorter than dragThresholdPx is treated as a point
 * at the box center. Otherwise every candidate whose normalized rect overlaps
 * the box (positive area) is kept, in original order, deduped by target.id
 * (first wins), and capped at targetsMax. Zero hits → single []; one → single;
 * more than one → region.
 */
export function hitTest(
  bbox: AskBBox,
  candidates: readonly AskCandidate[],
): { mode: AskSelectionMode; targets: AskTarget[] } {
  if (!finiteBBox(bbox)) return emptySingle();
  const box = normalizeBBox(bbox);
  if (box.width < ASK_LIMITS.dragThresholdPx || box.height < ASK_LIMITS.dragThresholdPx) {
    return hitTestPoint(box.x + box.width / 2, box.y + box.height / 2, candidates);
  }

  const seen = new Set<string>();
  const targets: AskTarget[] = [];
  for (const candidate of candidates) {
    if (!finiteBBox(candidate.rect)) continue;
    const rect = normalizeBBox(candidate.rect);
    if (!intersects(box, rect)) continue;
    if (seen.has(candidate.target.id)) continue;
    seen.add(candidate.target.id);
    targets.push(candidate.target);
    if (targets.length >= ASK_LIMITS.targetsMax) break;
  }
  if (targets.length > 1) return { mode: "region", targets };
  return { mode: "single", targets };
}
