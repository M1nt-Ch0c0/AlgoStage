/**
 * Read data-ask-* marks inside a stage into AskCandidate[].
 * Pure DOM read: no React, no writes.
 */
import { ASK_LIMITS } from "@/lib/ask/types";
import type {
  AskBBox,
  AskCandidate,
  AskSelectionSummary,
  AskTarget,
  AskTargetKind,
} from "@/lib/ask/types";
import { getCodeEditorHandle } from "@/lib/ask/code-editor-registry";
import { intersects, normalizeBBox } from "@/lib/ask/hit-test";

const KINDS: ReadonlySet<string> = new Set<AskTargetKind>([
  "subtitle",
  "step",
  "code",
  "viz",
  "handout",
]);

const SUMMARY_MAX = 24;

function isKind(value: string): value is AskTargetKind {
  return KINDS.has(value);
}

function collapseText(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, ASK_LIMITS.targetTextMax);
}

function parseVizIndex(raw: string | null): number | undefined {
  if (raw === null || raw.trim() === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return undefined;
  return n;
}

function synthesizeId(kind: AskTargetKind, stepId: string | undefined, vizIndex: number | undefined): string {
  const step = stepId ?? "";
  if (kind === "viz") {
    if (vizIndex !== undefined) return `viz:${step}:${vizIndex}`;
    return `viz:${step}`;
  }
  if (kind === "subtitle") return `subtitle:${step}`;
  if (kind === "step") return `step:${step}`;
  return `${kind}:${step}`;
}

export function relativeRect(stage: HTMLElement, el: Element): AskBBox {
  const sr = stage.getBoundingClientRect();
  const er = el.getBoundingClientRect();
  return {
    x: er.left - sr.left + stage.scrollLeft,
    y: er.top - sr.top + stage.scrollTop,
    width: er.width,
    height: er.height,
  };
}

function finiteRect(rect: AskBBox): boolean {
  return (
    Number.isFinite(rect.x) &&
    Number.isFinite(rect.y) &&
    Number.isFinite(rect.width) &&
    Number.isFinite(rect.height)
  );
}

/** Collect ask targets inside `stage`, in DOM order. Skips data-ask-exclude subtrees. */
export function collectAskCandidates(stage: HTMLElement, box?: AskBBox): AskCandidate[] {
  const nodes = stage.querySelectorAll("[data-ask-target]");
  const out: AskCandidate[] = [];
  for (const el of nodes) {
    if (el.closest("[data-ask-exclude]") !== null) continue;
    const kindRaw = el.getAttribute("data-ask-target") ?? "";
    if (!isKind(kindRaw)) continue;
    const rect = relativeRect(stage, el);
    if (!finiteRect(rect)) continue;

    const stepIdAttr = el.getAttribute("data-ask-step-id");
    const stepId = stepIdAttr && stepIdAttr.length > 0 ? stepIdAttr : undefined;
    const vizIndex = kindRaw === "viz" ? parseVizIndex(el.getAttribute("data-ask-viz-index")) : undefined;
    const idAttr = el.getAttribute("data-ask-id");
    const id = idAttr && idAttr.length > 0 ? idAttr : synthesizeId(kindRaw, stepId, vizIndex);

    if (kindRaw === "code") {
      const handle = getCodeEditorHandle(el);
      const normRect = normalizeBBox(rect);

      if (box) {
        const normBox = normalizeBBox(box);
        const effectiveBox =
          normBox.width === 0 || normBox.height === 0
            ? { x: normBox.x, y: normBox.y, width: Math.max(normBox.width, 1), height: Math.max(normBox.height, 1) }
            : normBox;

        const isIntersecting = intersects(effectiveBox, normRect);
        if (!isIntersecting) {
          // (4) box does not intersect the code element -> no code target at all
          continue;
        }

        let codeRange: { startLine: number; endLine: number } | undefined;
        let text: string;

        if (handle) {
          const sr = stage.getBoundingClientRect();
          const intersectTop = Math.max(effectiveBox.y, normRect.y);
          const intersectBottom = Math.min(effectiveBox.y + effectiveBox.height, normRect.y + normRect.height);
          const clientTop = intersectTop + sr.top - stage.scrollTop;
          const clientBottom = intersectBottom + sr.top - stage.scrollTop;

          const range = handle.getLineRangeForClientBox(clientTop, clientBottom);
          if (range) {
            // (1) intersects and handle returns a range
            codeRange = { startLine: range.startLine, endLine: range.endLine };
            text = handle.getLinesText(range.startLine, range.endLine).slice(0, ASK_LIMITS.targetTextMax);
          } else {
            // (2) intersects but range is null
            const full = handle.getFullText();
            text = (full || (el.textContent ?? "")).slice(0, ASK_LIMITS.targetTextMax);
          }
        } else {
          text = (el.textContent ?? "").slice(0, ASK_LIMITS.targetTextMax);
        }

        // (3) intersects but can't get any code text (empty) -> no code target
        if (!text || text.length === 0) {
          continue;
        }

        const target: AskTarget = {
          kind: "code",
          id,
          ...(stepId !== undefined ? { stepId } : {}),
          ...(codeRange !== undefined ? { codeRange } : {}),
          text,
        };
        out.push({ target, rect });
        continue;
      }

      // No box specified (shortcuts, roving focus, outlines)
      const full = handle ? handle.getFullText() : (el.textContent ?? "");
      const text = full.slice(0, ASK_LIMITS.targetTextMax);
      if (!text || text.length === 0) {
        continue;
      }

      const target: AskTarget = {
        kind: "code",
        id,
        ...(stepId !== undefined ? { stepId } : {}),
        text,
      };
      out.push({ target, rect });
      continue;
    }

    const target: AskTarget = {
      kind: kindRaw,
      id,
      ...(stepId !== undefined ? { stepId } : {}),
      text: collapseText(el.textContent ?? ""),
    };
    if (kindRaw === "viz" && vizIndex !== undefined) {
      target.vizHit = { structure: "array", indices: [vizIndex] };
    }
    out.push({ target, rect });
  }
  return out;
}

export function collectAskCandidatesInBox(stage: HTMLElement, box: AskBBox): AskCandidate[] {
  return collectAskCandidates(stage, box);
}

function cap(text: string): string {
  const chars = Array.from(text);
  if (chars.length <= SUMMARY_MAX) return text;
  return chars.slice(0, SUMMARY_MAX).join("");
}

/**
 * Short selection label, at most 24 Unicode code points.
 * Single subtitle → 「已选：当前字幕」; single step → 「已选：当前步骤」;
 * viz-only → 「已选：可视化 N 处」; empty → 「已选：无」.
 */
export function summarizeSelection(sel: AskSelectionSummary): string {
  const targets = sel.targets;
  if (targets.length === 0) return "已选：无";

  const kinds = new Set(targets.map((t) => t.kind));
  const vizCount = targets.filter((t) => t.kind === "viz").length;

  if (kinds.size === 1 && kinds.has("subtitle") && targets.length === 1) {
    return "已选：当前字幕";
  }
  if (kinds.size === 1 && kinds.has("step") && targets.length === 1) {
    return "已选：当前步骤";
  }
  if (kinds.size === 1 && kinds.has("code") && targets.length === 1) {
    const code = targets[0];
    if (code.codeRange) {
      return cap(`已选：代码第 ${code.codeRange.startLine}–${code.codeRange.endLine} 行`);
    }
    return "已选：当前代码";
  }
  if (kinds.size === 1 && kinds.has("viz") && vizCount >= 1) {
    return cap(`已选：可视化 ${vizCount} 处`);
  }

  const parts: string[] = [];
  const subtitleCount = targets.filter((t) => t.kind === "subtitle").length;
  const stepCount = targets.filter((t) => t.kind === "step").length;
  const codeTargets = targets.filter((t) => t.kind === "code");
  if (subtitleCount > 0) parts.push(subtitleCount === 1 ? "当前字幕" : `字幕 ${subtitleCount}`);
  if (stepCount > 0) parts.push(stepCount === 1 ? "当前步骤" : `步骤 ${stepCount}`);
  if (codeTargets.length > 0) {
    const firstCode = codeTargets[0];
    const codeLabel = firstCode.codeRange
      ? `代码第 ${firstCode.codeRange.startLine}–${firstCode.codeRange.endLine} 行`
      : "当前代码";
    parts.push(codeLabel);
  }
  if (vizCount > 0) parts.push(`可视化 ${vizCount} 处`);
  const other = targets.length - subtitleCount - stepCount - codeTargets.length - vizCount;
  if (other > 0) parts.push(`其他 ${other}`);
  if (parts.length === 0) return "已选：无";
  return cap(`已选：${parts.join(" · ")}`);
}
