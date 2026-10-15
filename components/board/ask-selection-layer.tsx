/**
 * AskSelectionLayer · 盖在 data-ask-stage 上的画选层。
 * 单指/鼠标：位移 <8px，或规范化后任一边 <24px，走点选；否则走框选。
 * 第二指按下放弃当前框，按两指中点位移 scrollBy 最近可滚祖先。
 * 窗口 resize 只清选区（clearAskSelection），不关面板。
 * visualViewport resize 是软键盘，不清选区，留给提问抽屉去抬高。
 * Esc 在 selecting 调用 exitAsk；面板打开时（drafting 等）Esc 留给面板。
 */
"use client";

import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import { collectAskCandidates, relativeRect, summarizeSelection } from "@/lib/ask/collect-candidates";
import { hitTest, hitTestPoint, intersects, normalizeBBox } from "@/lib/ask/hit-test";
import {
  ASK_CODE_MISS_HINT,
  ASK_EMPTY_HIT,
  ASK_ENTERED_STATUS,
  ASK_LAYER_HINT,
  ASK_RESIZE_HINT,
  ASK_SHORTCUT_STEP,
  ASK_SHORTCUT_SUBTITLE,
  ASK_SHORTCUT_VIZ,
} from "@/lib/ask/ask-ui-text";
import { ASK_LIMITS, type AskBBox, type AskSelectionSummary, type AskTarget } from "@/lib/ask/types";
import { setAskCodeMissNotice } from "@/lib/ask/code-editor-registry";
import { usePlayerStore } from "@/lib/player/store";

/** 规范化后任一边短于这个值，按点选（中心点）处理。 */
const MIN_REGION_SIDE = 24;

const ACTIVE_PHASES = new Set(["selecting", "drafting", "error"]);

const SHORTCUTS = [
  { key: "subtitle", label: ASK_SHORTCUT_SUBTITLE },
  { key: "step", label: ASK_SHORTCUT_STEP },
  { key: "viz", label: ASK_SHORTCUT_VIZ },
] as const;

type ShortcutKey = (typeof SHORTCUTS)[number]["key"];

export interface AskSelectionLayerProps {
  stageRef?: RefObject<HTMLElement | null>;
  /** 优先使用；缺省时回落到 stageRef，再回落到 [data-ask-stage]。 */
  stage?: HTMLElement | null;
}

interface RubberBand {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface PointerSample {
  /** Stage-relative, includes stage scroll. Used for the rubber band. */
  x: number;
  y: number;
  /** Viewport client coordinates. Used for two-finger scroll deltas. */
  clientX: number;
  clientY: number;
}

function resolveStage(
  stage: HTMLElement | null | undefined,
  stageRef: RefObject<HTMLElement | null> | undefined,
): HTMLElement | null {
  if (stage) return stage;
  if (stageRef?.current) return stageRef.current;
  return document.querySelector<HTMLElement>("[data-ask-stage]");
}

function sampleAt(stage: HTMLElement, clientX: number, clientY: number): PointerSample {
  const rect = stage.getBoundingClientRect();
  return {
    x: clientX - rect.left + stage.scrollLeft,
    y: clientY - rect.top + stage.scrollTop,
    clientX,
    clientY,
  };
}

function bandFrom(origin: PointerSample, current: PointerSample): RubberBand {
  return {
    x: origin.x,
    y: origin.y,
    width: current.x - origin.x,
    height: current.y - origin.y,
  };
}

/** Nearest ancestor that can actually scroll, else the document scroller. */
export function findScrollable(start: HTMLElement | null): HTMLElement {
  let node: HTMLElement | null = start?.parentElement ?? null;
  while (node) {
    const style = getComputedStyle(node);
    const overflow = `${style.overflow}${style.overflowX}${style.overflowY}`;
    const canY = /(auto|scroll|overlay)/.test(overflow) && node.scrollHeight > node.clientHeight + 1;
    const canX = /(auto|scroll|overlay)/.test(overflow) && node.scrollWidth > node.clientWidth + 1;
    if (canY || canX) return node;
    node = node.parentElement;
  }
  const scrolling = document.scrollingElement;
  if (scrolling instanceof HTMLElement) return scrolling;
  return document.documentElement;
}

function shortcutId(stepId: string, key: ShortcutKey): string {
  return `${key}:${stepId}`;
}

function findByAskId(host: HTMLElement, id: string): HTMLElement | null {
  for (const el of host.querySelectorAll<HTMLElement>("[data-ask-id]")) {
    if (el.getAttribute("data-ask-id") !== id) continue;
    if (el.closest("[data-ask-exclude]") !== null) continue;
    return el;
  }
  return null;
}

/** Current step has a viz block or a viz cell. Excluded subtrees do not count. */
function stageHasViz(host: HTMLElement, stepId: string): boolean {
  if (!stepId) return false;
  for (const el of host.querySelectorAll<HTMLElement>('[data-ask-target="viz"]')) {
    if (el.closest("[data-ask-exclude]") !== null) continue;
    const id = el.getAttribute("data-ask-id") ?? "";
    const owner = el.getAttribute("data-ask-step-id") ?? "";
    if (owner === stepId || id === `viz:${stepId}` || id.startsWith(`viz:${stepId}:`)) return true;
  }
  return false;
}

function selectionFromElement(el: HTMLElement, stepId: string, key: ShortcutKey): AskSelectionSummary | null {
  const stage = el.closest<HTMLElement>("[data-ask-stage]") ?? el.parentElement;
  if (!stage) return null;
  const candidates = collectAskCandidates(stage);
  const id = el.getAttribute("data-ask-id") || shortcutId(stepId, key);
  const match = candidates.find((candidate) => candidate.target.id === id);
  if (match) return { mode: "single", bbox: match.rect, targets: [match.target] };
  const kind = (el.getAttribute("data-ask-target") || key) as AskTarget["kind"];
  const target: AskTarget = {
    kind,
    id,
    stepId: el.getAttribute("data-ask-step-id") || stepId,
    text: (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, ASK_LIMITS.targetTextMax),
  };
  return { mode: "single", bbox: { x: 0, y: 0, width: 0, height: 0 }, targets: [target] };
}

export default function AskSelectionLayer({ stageRef, stage }: AskSelectionLayerProps) {
  const askPhase = usePlayerStore((s) => s.askPhase);
  const selection = usePlayerStore((s) => s.selection);
  const currentIndex = usePlayerStore((s) => s.currentIndex);
  const steps = usePlayerStore((s) => s.steps);
  const setAskSelection = usePlayerStore((s) => s.setAskSelection);
  const clearAskSelection = usePlayerStore((s) => s.clearAskSelection);
  const exitAsk = usePlayerStore((s) => s.exitAsk);

  if (!ACTIVE_PHASES.has(askPhase)) return null;

  return (
    <AskSelectionLayerActive
      stageRef={stageRef}
      stage={stage}
      askPhase={askPhase}
      selection={selection}
      stepId={steps[currentIndex]?.id ?? ""}
      setAskSelection={setAskSelection}
      clearAskSelection={clearAskSelection}
      exitAsk={exitAsk}
    />
  );
}

function AskSelectionLayerActive({
  stageRef,
  stage,
  askPhase,
  selection,
  stepId,
  setAskSelection,
  clearAskSelection,
  exitAsk,
}: AskSelectionLayerProps & {
  askPhase: string;
  selection: AskSelectionSummary | null;
  stepId: string;
  setAskSelection: (selection: AskSelectionSummary) => void;
  clearAskSelection: () => void;
  exitAsk: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const pointersRef = useRef<Map<number, PointerSample>>(new Map());
  const originRef = useRef<PointerSample | null>(null);
  const drawingRef = useRef(false);
  const scrollModeRef = useRef(false);
  const suppressDrawRef = useRef(false);
  const lastMidRef = useRef<PointerSample | null>(null);
  const scrollDeltaRef = useRef({ x: 0, y: 0 });
  const scrollRafRef = useRef<number | null>(null);
  const announcedRef = useRef(false);

  const [rubberBand, setRubberBand] = useState<RubberBand | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [activeShortcut, setActiveShortcut] = useState(0);
  const [rovingIndex, setRovingIndex] = useState(0);
  const [reducedMotion, setReducedMotion] = useState(false);

  const getStage = useCallback(() => resolveStage(stage, stageRef), [stage, stageRef]);

  const visibleShortcuts = SHORTCUTS.filter((item) => {
    if (item.key !== "viz") return true;
    const host = getStage();
    return host ? stageHasViz(host, stepId) : false;
  });

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReducedMotion(mq.matches);
    const onChange = (event: MediaQueryListEvent) => setReducedMotion(event.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  // 进入圈选播报一次。优先写入页面已有的 role=status。
  useEffect(() => {
    if (announcedRef.current) return;
    announcedRef.current = true;
    const status = document.querySelector("[role=status]");
    if (status) status.textContent = ASK_ENTERED_STATUS;
  }, []);

  // 选中后把摘要写进同一个 status。
  useEffect(() => {
    if (!selection || selection.targets.length === 0) return;
    const status = document.querySelector("[role=status]");
    if (status) status.textContent = summarizeSelection(selection);
  }, [selection]);

  // 窗口 resize / 旋转：清选区，留在 selecting，保留草稿。不走 closeAskPanel。
  // visualViewport resize 是软键盘高度变化，不清选区，提问抽屉自己跟着抬。
  useEffect(() => {
    const onResize = () => {
      setRubberBand(null);
      drawingRef.current = false;
      originRef.current = null;
      setHint(ASK_RESIZE_HINT);
      setAskCodeMissNotice(null);
      clearAskSelection();
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      setAskCodeMissNotice(null);
    };
  }, [clearAskSelection]);

  // 进入 selecting 时焦点落到第一个捷径。
  useEffect(() => {
    if (askPhase !== "selecting") return;
    const first = rootRef.current?.querySelector<HTMLButtonElement>("[data-ask-shortcut]");
    first?.focus();
  }, [askPhase]);

  useEffect(() => {
    setActiveShortcut((index) => Math.min(index, Math.max(visibleShortcuts.length - 1, 0)));
  }, [visibleShortcuts.length]);

  const flushScroll = useCallback(() => {
    scrollRafRef.current = null;
    const delta = scrollDeltaRef.current;
    scrollDeltaRef.current = { x: 0, y: 0 };
    if (delta.x === 0 && delta.y === 0) return;
    const scroller = findScrollable(getStage());
    scroller.scrollBy({ left: -delta.x, top: -delta.y });
  }, [getStage]);

  const queueScroll = useCallback(
    (dx: number, dy: number) => {
      scrollDeltaRef.current.x += dx;
      scrollDeltaRef.current.y += dy;
      if (scrollRafRef.current != null) return;
      scrollRafRef.current = requestAnimationFrame(flushScroll);
    },
    [flushScroll],
  );

  const resetGesture = useCallback(() => {
    pointersRef.current.clear();
    originRef.current = null;
    drawingRef.current = false;
    scrollModeRef.current = false;
    suppressDrawRef.current = false;
    lastMidRef.current = null;
    setRubberBand(null);
    if (scrollRafRef.current != null) {
      cancelAnimationFrame(scrollRafRef.current);
      scrollRafRef.current = null;
    }
    scrollDeltaRef.current = { x: 0, y: 0 };
  }, []);

  const commitBand = useCallback(
    (origin: PointerSample, current: PointerSample) => {
      const host = getStage();
      if (!host) return;
      const dx = current.x - origin.x;
      const dy = current.y - origin.y;
      const raw = bandFrom(origin, current);
      const box = normalizeBBox(raw);
      const pointLike =
        Math.max(Math.abs(dx), Math.abs(dy)) < ASK_LIMITS.dragThresholdPx ||
        box.width < MIN_REGION_SIDE ||
        box.height < MIN_REGION_SIDE;
      const point = pointLike
        ? { x: box.x + box.width / 2, y: box.y + box.height / 2 }
        : null;

      const candidateBox = point
        ? { x: point.x, y: point.y, width: Math.max(box.width, 1), height: Math.max(box.height, 1) }
        : box;
      const candidates = collectAskCandidates(host, candidateBox);
      const hit = point ? hitTestPoint(point.x, point.y, candidates) : hitTest(box, candidates);

      const testBox =
        box.width === 0 || box.height === 0
          ? { x: box.x, y: box.y, width: Math.max(box.width, 1), height: Math.max(box.height, 1) }
          : box;
      let codeIntersected = false;
      for (const codeEl of host.querySelectorAll<HTMLElement>('[data-ask-target="code"]')) {
        if (codeEl.closest("[data-ask-exclude]") !== null) continue;
        const codeRect = relativeRect(host, codeEl);
        if (intersects(testBox, normalizeBBox(codeRect))) {
          codeIntersected = true;
          break;
        }
      }
      const codeCollected = hit.targets.some((t) => t.kind === "code");

      if (hit.targets.length === 0) {
        if (codeIntersected) {
          setHint(ASK_CODE_MISS_HINT);
        } else {
          setHint(ASK_EMPTY_HIT);
        }
        setAskCodeMissNotice(null);
        return;
      }

      setHint(null);
      if (codeIntersected && !codeCollected) {
        setAskCodeMissNotice(ASK_CODE_MISS_HINT);
      } else {
        setAskCodeMissNotice(null);
      }
      setAskSelection({ mode: hit.mode, bbox: box, targets: hit.targets });
    },
    [getStage, setAskSelection],
  );

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 && event.pointerType === "mouse") return;
    if ((event.target as Element | null)?.closest?.("[data-ask-entry]")) return;
    const host = getStage();
    if (!host) return;
    const sample = sampleAt(host, event.clientX, event.clientY);
    pointersRef.current.set(event.pointerId, sample);
    event.currentTarget.setPointerCapture(event.pointerId);

    if (pointersRef.current.size >= 2) {
      // 第二指：放弃当前框，进入滚动。不 hitTest。
      drawingRef.current = false;
      originRef.current = null;
      setRubberBand(null);
      scrollModeRef.current = true;
      suppressDrawRef.current = true;
      lastMidRef.current = clientMidpoint(pointersRef.current);
      return;
    }

    if (scrollModeRef.current || suppressDrawRef.current) return;
    originRef.current = sample;
    drawingRef.current = true;
    setRubberBand(bandFrom(sample, sample));
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!pointersRef.current.has(event.pointerId)) return;
    const host = getStage();
    if (!host) return;
    pointersRef.current.set(event.pointerId, sampleAt(host, event.clientX, event.clientY));

    if (scrollModeRef.current && pointersRef.current.size >= 2) {
      const mid = clientMidpoint(pointersRef.current);
      const prev = lastMidRef.current;
      lastMidRef.current = mid;
      if (prev) queueScroll(mid.x - prev.x, mid.y - prev.y);
      return;
    }

    if (!drawingRef.current || !originRef.current || suppressDrawRef.current) return;
    const current = pointersRef.current.get(event.pointerId);
    if (!current) return;
    setRubberBand(bandFrom(originRef.current, current));
  };

  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const wasDrawing = drawingRef.current && originRef.current != null && !scrollModeRef.current;
    const origin = originRef.current;
    const current = pointersRef.current.get(event.pointerId) ?? origin;
    pointersRef.current.delete(event.pointerId);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    if (scrollModeRef.current) {
      // 任一指抬起结束滚动；剩下的手指不再起新框。
      scrollModeRef.current = false;
      lastMidRef.current = null;
      drawingRef.current = false;
      originRef.current = null;
      setRubberBand(null);
      suppressDrawRef.current = pointersRef.current.size > 0;
      if (pointersRef.current.size === 0) suppressDrawRef.current = false;
      return;
    }

    if (wasDrawing && origin && current && pointersRef.current.size === 0) {
      drawingRef.current = false;
      originRef.current = null;
      setRubberBand(null);
      commitBand(origin, current);
      return;
    }

    if (pointersRef.current.size === 0) {
      drawingRef.current = false;
      originRef.current = null;
      suppressDrawRef.current = false;
      setRubberBand(null);
    }
  };

  const onPointerCancel = (event: PointerEvent<HTMLDivElement>) => {
    pointersRef.current.delete(event.pointerId);
    if (pointersRef.current.size === 0) resetGesture();
    else {
      drawingRef.current = false;
      originRef.current = null;
      setRubberBand(null);
      suppressDrawRef.current = true;
      scrollModeRef.current = false;
    }
  };

  const pickShortcut = (key: ShortcutKey) => {
    setAskCodeMissNotice(null);
    const host = getStage();
    if (!host || !stepId) return;
    const el = findByAskId(host, shortcutId(stepId, key));
    if (!el) return;
    const next = selectionFromElement(el, stepId, key);
    if (!next || next.targets.length === 0) {
      setHint(ASK_EMPTY_HIT);
      return;
    }
    setHint(null);
    setAskSelection(next);
  };

  const targets = (): HTMLElement[] => {
    const host = getStage();
    if (!host) return [];
    return [...host.querySelectorAll<HTMLElement>("[data-ask-target]")].filter(
      (el) => el.closest("[data-ask-exclude]") === null,
    );
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const key = event.key;
    // 只在圈选中吞掉 Esc。drafting|sending|streaming|error 留给面板 closeAskPanel。
    if (key === "Escape" && askPhase === "selecting") {
      event.preventDefault();
      event.stopPropagation();
      setAskCodeMissNotice(null);
      exitAsk();
      return;
    }
    const blocked = key === " " || key === "ArrowLeft" || key === "ArrowRight" || key === "ArrowUp" || key === "ArrowDown";
    if (blocked || key === "Enter" || key === "Tab") {
      event.stopPropagation();
    }
    if (key === " " || key === "ArrowLeft" || key === "ArrowRight") {
      event.preventDefault();
    }

    if (key === "Tab") {
      const count = visibleShortcuts.length;
      if (count === 0) return;
      event.preventDefault();
      const dir = event.shiftKey ? -1 : 1;
      const next = (activeShortcut + dir + count) % count;
      setActiveShortcut(next);
      const buttons = rootRef.current?.querySelectorAll<HTMLButtonElement>("[data-ask-shortcut]");
      buttons?.[next]?.focus();
      return;
    }

    if (key === "ArrowUp" || key === "ArrowDown" || key === "ArrowLeft" || key === "ArrowRight") {
      const nodes = targets();
      if (nodes.length === 0) return;
      event.preventDefault();
      const dir = key === "ArrowDown" || key === "ArrowRight" ? 1 : -1;
      const next = (rovingIndex + dir + nodes.length) % nodes.length;
      setRovingIndex(next);
      const node = nodes[next];
      if (node && !node.hasAttribute("tabindex")) node.tabIndex = -1;
      node?.focus();
      return;
    }

    if (key === "Enter") {
      const nodes = targets();
      const el = nodes[rovingIndex];
      if (!el) return;
      event.preventDefault();
      const host = getStage();
      if (!host) return;
      const id = el.getAttribute("data-ask-id") ?? "";
      const match = collectAskCandidates(host).find((candidate) => candidate.target.id === id);
      if (!match) {
        setHint(ASK_EMPTY_HIT);
        return;
      }
      setHint(null);
      setAskCodeMissNotice(null);
      setAskSelection({ mode: "single", bbox: match.rect, targets: [match.target] });
    }
  };

  const showShortcuts = askPhase === "selecting";
  const band = rubberBand ? normalizeBBox(rubberBand) : null;
  const selectedBox = selection && selection.targets.length > 0 ? normalizeBBox(selection.bbox) : null;
  const label = selection && selection.targets.length > 0 ? summarizeSelection(selection) : null;
  const labelBelow = selectedBox != null && selectedBox.y < 28;

  return (
    <div
      ref={rootRef}
      data-ask-layer
      role="application"
      aria-label="圈选区域"
      tabIndex={-1}
      className={`absolute inset-0 z-30 cursor-crosshair touch-none ${
        reducedMotion ? "" : "transition-opacity"
      }`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onKeyDown={onKeyDown}
    >
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex flex-col gap-1 p-2">
        <p className="text-xs text-chalk-100">{hint ?? ASK_LAYER_HINT}</p>
        {showShortcuts ? (
          <div role="group" aria-label="点选捷径" className="pointer-events-auto flex flex-wrap gap-1">
            {visibleShortcuts.map((item, index) => (
              <button
                key={item.key}
                type="button"
                data-ask-shortcut={item.key}
                tabIndex={index === activeShortcut ? 0 : -1}
                className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 rounded-full border border-board-600 bg-board-900/80 px-2 py-0.5 text-[10px] text-chalk-100"
                onClick={(event) => {
                  event.stopPropagation();
                  setActiveShortcut(index);
                  pickShortcut(item.key);
                }}
                onPointerDown={(event) => event.stopPropagation()}
              >
                {item.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {band && (band.width > 0 || band.height > 0) ? (
        <div
          data-ask-rubber
          className="pointer-events-none absolute border-2 border-dashed border-beam-gold shadow-[0_0_0_9999px_rgba(0,0,0,0.4)]"
          style={{ left: band.x, top: band.y, width: band.width, height: band.height }}
        />
      ) : null}

      {selectedBox ? (
        <div
          data-ask-selection
          className={`pointer-events-none absolute border-2 border-solid border-beam-gold ${
            band ? "" : "shadow-[0_0_0_9999px_rgba(0,0,0,0.4)]"
          }`}
          style={{
            left: selectedBox.x,
            top: selectedBox.y,
            width: selectedBox.width,
            height: selectedBox.height,
          }}
        >
          {label ? (
            <span
              data-ask-selection-label
              className={`absolute left-0 max-w-[16rem] truncate bg-board-900/90 px-1 text-[10px] text-beam-gold ${
                labelBelow ? "top-full mt-0.5" : "bottom-full mb-0.5"
              }`}
            >
              {label}
            </span>
          ) : null}
        </div>
      ) : null}

      <TargetOutlines stage={getStage()} ids={selection?.targets.map((target) => target.id) ?? []} />
    </div>
  );
}

/** Midpoint in client (viewport) coordinates, so scroll delta is independent of stage scroll. */
function clientMidpoint(pointers: Map<number, PointerSample>): PointerSample {
  let x = 0;
  let y = 0;
  let n = 0;
  for (const sample of pointers.values()) {
    x += sample.clientX;
    y += sample.clientY;
    n += 1;
  }
  if (n === 0) return { x: 0, y: 0, clientX: 0, clientY: 0 };
  return { x: x / n, y: y / n, clientX: x / n, clientY: y / n };
}

function TargetOutlines({ stage, ids }: { stage: HTMLElement | null; ids: string[] }) {
  if (!stage || ids.length === 0) return null;
  const wanted = new Set(ids);
  const boxes: { id: string; rect: AskBBox }[] = [];
  for (const candidate of collectAskCandidates(stage)) {
    if (!wanted.has(candidate.target.id)) continue;
    boxes.push({ id: candidate.target.id, rect: candidate.rect });
    wanted.delete(candidate.target.id);
  }
  return (
    <>
      {boxes.map((box) => (
        <div
          key={box.id}
          data-ask-highlight={box.id}
          className="pointer-events-none absolute border border-beam-gold"
          style={{ left: box.rect.x, top: box.rect.y, width: box.rect.width, height: box.rect.height }}
        />
      ))}
    </>
  );
}
