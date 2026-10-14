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

function relativeRect(stage: HTMLElement, el: Element): AskBBox {
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
export function collectAskCandidates(stage: HTMLElement): AskCandidate[] {
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
  if (kinds.size === 1 && kinds.has("viz") && vizCount >= 1) {
    return cap(`已选：可视化 ${vizCount} 处`);
  }

  const parts: string[] = [];
  const subtitleCount = targets.filter((t) => t.kind === "subtitle").length;
  const stepCount = targets.filter((t) => t.kind === "step").length;
  if (subtitleCount > 0) parts.push(subtitleCount === 1 ? "当前字幕" : `字幕 ${subtitleCount}`);
  if (stepCount > 0) parts.push(stepCount === 1 ? "当前步骤" : `步骤 ${stepCount}`);
  if (vizCount > 0) parts.push(`可视化 ${vizCount} 处`);
  const other = targets.length - subtitleCount - stepCount - vizCount;
  if (other > 0) parts.push(`其他 ${other}`);
  if (parts.length === 0) return "已选：无";
  return cap(`已选：${parts.join(" · ")}`);
}
