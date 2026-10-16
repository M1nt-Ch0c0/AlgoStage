/**
 * AskSelectionLayer · 盖在 data-ask-stage 上的画选层。
 * 单指/鼠标：位移 <8px，或规范化后任一边 <24px，走点选；否则走框选。
 * 第二指按下放弃当前框，按两指中点位移 scrollBy 最近可滚祖先。
 * 窗口 resize 只清选区（clearAskSelection），不关面板。
 * visualViewport resize 是软键盘，不清选区，留给提问抽屉去抬高。
 * Esc 由窗口级单一监听处理（捕获阶段）：drafting/error 先关面板，selecting 再退出。
 * sending/streaming 与 0.3.1 一样不响应 Esc（不关面板、不退出、不取消请求）。
 * 面板外的输入框 / contenteditable 不抢 Esc。圈选期间 Monaco 内的 Esc 同样按阶段退出，避免编辑器吞掉按键。
 */
"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import { isTypingTarget } from "@/lib/player/keyboard";
import { collectAskCandidates, relativeRect, summarizeSelection } from "@/lib/ask/collect-candidates";
import { hitTest, hitTestPoint, intersects, normalizeBBox } from "@/lib/ask/hit-test";
import {
  ASK_CODE_MISS_HINT,
  ASK_EMPTY_HIT,
  ASK_ENTERED_STATUS,
  ASK_EXIT_LABEL,
  ASK_LAYER_HINT,
  ASK_RESIZE_HINT,
  ASK_SHORTCUT_STEP,
  ASK_SHORTCUT_SUBTITLE,
  ASK_SHORTCUT_VIZ,
} from "@/lib/ask/ask-ui-text";
import { ASK_LIMITS, type AskBBox, type AskSelectionSummary, type AskTarget } from "@/lib/ask/types";
import { setAskCodeMissNotice } from "@/lib/ask/code-editor-registry";
import { askCancelGhostUntil, finishAskCancelSync } from "@/lib/ask/ask-cancel";
import { setAskOpenSource } from "@/lib/ask/ask-open-source";
import {
  applyAskSelectingRootVars,
  computeBottomOcclusion,
  getAskBottomObstacle,
  invalidateAskMeasureCache,
  measureAskElementHeight,
  measureAskPlayerBarHeight,
  sharedAskMeasureCache,
  writeAskRootVars,
  type OcclusionParts,
} from "@/lib/ask/ask-occlusion";
import { scheduleEncodeWorkerPrewarm } from "@/lib/ask/capture-worker";
import { usePlayerStore } from "@/lib/player/store";
import { useIsMobile } from "./use-is-mobile";

/** 规范化后任一边短于这个值，按点选（中心点）处理。 */
const MIN_REGION_SIDE = 24;

const ACTIVE_PHASES = new Set(["selecting", "drafting", "error"]);
/**
 * Shell stays mounted through waiting so a sending/streaming → selecting
 * cancel can focus the chip in that same commit. Encode prewarm stays on
 * ACTIVE_PHASES. Esc stays on ESCAPE_PHASES (not registered while waiting).
 */
const LAYER_MOUNTED_PHASES = new Set(["selecting", "drafting", "error", "sending", "streaming"]);
/** 窗口级 Esc 覆盖的阶段。sending/streaming/playing 仍留给原来的流程，不在这里处理。 */
const ESCAPE_PHASES = new Set(["selecting", "drafting", "error"]);

export type AskEscapeAction = "close-panel" | "exit" | "ignore";

export interface AskEscapeModifiers {
  composing: boolean;
  defaultPrevented: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}

/** 圈选期间 Monaco 会在目标阶段吞掉 Esc，这里把它当成面板内目标，按阶段处理。 */
function isMonacoTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(".monaco-editor") !== null;
}

/**
 * 圈选期间 Esc 的唯一决策。
 * 面板外的输入控件留给控件自己；提问框（面板内 textarea）与 Monaco 按阶段关面板或退出。
 * idle/playing/done 一律忽略，Monaco 保持编辑器自己的 Esc。
 * sending/streaming 与 0.3.1 一样忽略：不关面板、不退出、不取消请求。
 */
export function resolveAskEscape(
  phase: string,
  target: EventTarget | null,
  modifiers: AskEscapeModifiers,
): AskEscapeAction {
  if (modifiers.composing || modifiers.defaultPrevented) return "ignore";
  if (modifiers.ctrlKey || modifiers.metaKey || modifiers.altKey) return "ignore";
  if (phase === "idle" || phase === "playing" || phase === "done") return "ignore";
  if (phase === "sending" || phase === "streaming") return "ignore";
  const insidePanel = target instanceof Element && target.closest("[data-ask-panel]") !== null;
  const inMonaco = isMonacoTarget(target);
  if (isTypingTarget(target) && !insidePanel && !inMonaco) return "ignore";
  if (phase === "drafting" || phase === "error") return "close-panel";
  if (phase === "selecting") return "exit";
  return "ignore";
}

/**
 * 比较两次滚动位置快照是否一致。
 */
function isSameScrollPositions(
  a: { windowY: number; ancestorTops: number[] } | null,
  b: { windowY: number; ancestorTops: number[] },
): boolean {
  if (!a) return false;
  if (a.windowY !== b.windowY) return false;
  if (a.ancestorTops.length !== b.ancestorTops.length) return false;
  for (let i = 0; i < a.ancestorTops.length; i++) {
    if (a.ancestorTops[i] !== b.ancestorTops[i]) return false;
  }
  return true;
}

/**
 * 实时判断进入滚动是否仍在进行中。
 * 仅当追踪器激活，且当前滚动位置与上次记录不同或最近一次滚动变化在约 50ms（节流 CPU 下帧间隔可能超过 20ms）以内时，才视为正在滚动。
 */
export function isEnteringScrollInFlight(
  trackerActive: boolean,
  lastPositions: { windowY: number; ancestorTops: number[] } | null,
  currentPositions: { windowY: number; ancestorTops: number[] },
  lastChangeTime: number,
  now: number,
): boolean {
  if (!trackerActive) return false;
  const posChanged = lastPositions != null && !isSameScrollPositions(lastPositions, currentPositions);
  const recentChange = now - lastChangeTime <= 50;
  return posChanged || recentChange;
}

/**
 * 检查元素是否完全处于视口中（考虑底部栏遮挡）。
 * 视口顶部为 0，可用底部为 innerHeight - bottomBarHeight。
 */
export function isElementFullyInView(
  rect: { top: number; bottom: number },
  viewport: { innerHeight: number; bottomBarHeight: number },
): boolean {
  if (rect.top < 0) return false;
  if (rect.bottom > viewport.innerHeight - viewport.bottomBarHeight) return false;
  return true;
}

/**
 * 快捷选项 roving tabindex 计算。
 * ArrowLeft / ArrowRight / Home / End 支持循环移动焦点。
 */
export function nextRovingIndex(
  current: number,
  total: number,
  key: "ArrowRight" | "ArrowLeft" | "Home" | "End",
): number {
  if (total <= 0) return 0;
  switch (key) {
    case "ArrowRight":
      return (current + 1) % total;
    case "ArrowLeft":
      return (current - 1 + total) % total;
    case "Home":
      return 0;
    case "End":
      return total - 1;
    default:
      return current;
  }
}

/** 元素是否可见且可获得焦点（tabIndex >= 0 且未 disabled）。 */
export function isElementTabbable(el: HTMLElement): boolean {
  if (el.tabIndex < 0) return false;
  if ("disabled" in el && (el as HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).disabled) {
    return false;
  }
  if (el.offsetParent === null && el.offsetWidth === 0 && el.offsetHeight === 0) {
    return false;
  }
  const style = typeof window !== "undefined" ? window.getComputedStyle(el) : null;
  if (style && (style.display === "none" || style.visibility === "hidden")) {
    return false;
  }
  return true;
}

/** 获取容器内所有按 DOM 顺序排列的可获得焦点元素。 */
export function getTabbableElements(container: HTMLElement): HTMLElement[] {
  const candidates = container.querySelectorAll<HTMLElement>(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
  );
  return Array.from(candidates).filter(isElementTabbable);
}

/**
 * 查找桌面入口按钮：[data-ask-entry]:not([data-ask-bottom-bar] [data-ask-entry])。
 */
export function getDesktopAskEntry(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  return document.querySelector<HTMLElement>(
    "[data-ask-entry]:not([data-ask-bottom-bar] [data-ask-entry])",
  );
}

/**
 * 查找在 DOM 顺序上位于 entry 之后、且不在 [data-ask-panel] 或 [data-ask-bottom-bar] 内的第一个可获得焦点元素。
 */
export function getNextTabbableAfterEntry(entry: HTMLElement): HTMLElement | null {
  if (typeof document === "undefined") return null;
  const candidates = document.querySelectorAll<HTMLElement>(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
  );
  let passedEntry = false;
  for (const candidate of candidates) {
    if (!passedEntry) {
      if (candidate === entry) {
        passedEntry = true;
      }
      continue;
    }
    if (candidate.closest("[data-ask-panel]") !== null) continue;
    if (candidate.closest("[data-ask-bottom-bar]") !== null) continue;
    if (isElementTabbable(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * 处理面板打开时（drafting / error 阶段）且非移动端的 Tab / Shift+Tab 导航。
 * 若移动了焦点返回 true，否则返回 false。
 */
export function handlePanelTabNavigation(
  event: Pick<globalThis.KeyboardEvent, "key" | "shiftKey" | "altKey" | "ctrlKey" | "metaKey" | "target">,
): boolean {
  if (event.key !== "Tab" || event.altKey || event.ctrlKey || event.metaKey) return false;

  const entry = getDesktopAskEntry();
  if (!entry) return false;

  const panel = document.querySelector<HTMLElement>("[data-ask-panel]");
  if (!panel) return false;

  const panelTabbables = getTabbableElements(panel);
  if (panelTabbables.length === 0) return false;

  const firstPanelTabbable = panelTabbables[0];
  const lastPanelTabbable = panelTabbables[panelTabbables.length - 1];
  const active = event.target as HTMLElement | null;

  if (!event.shiftKey) {
    // 1. Tab on the desktop entry -> focus the first tabbable element inside [data-ask-panel]
    if (active === entry) {
      firstPanelTabbable.focus();
      return true;
    }
    // 3. Tab on the last panel tabbable -> focus the first tabbable element after the entry
    if (active === lastPanelTabbable) {
      const nextAfterEntry = getNextTabbableAfterEntry(entry);
      if (nextAfterEntry) {
        nextAfterEntry.focus();
        return true;
      }
    }
  } else {
    // 2. Shift+Tab on the first panel tabbable -> focus the entry
    if (active === firstPanelTabbable) {
      entry.focus();
      return true;
    }
    // 4. Shift+Tab on that 'next after entry' element -> focus the last panel tabbable
    const nextAfterEntry = getNextTabbableAfterEntry(entry);
    if (nextAfterEntry && active === nextAfterEntry) {
      lastPanelTabbable.focus();
      return true;
    }
  }

  return false;
}

/** 退出圈选并将焦点还给入口按钮（若在 DOM 中）。 */
export function exitAskAndFocusEntry(): void {
  setAskCodeMissNotice(null);
  setAskOpenSource(null);
  const active = typeof document !== "undefined" ? document.activeElement : null;
  const focusWasInLayer =
    active != null &&
    (Boolean(document.querySelector("[data-ask-layer]")?.contains(active)) ||
      Boolean(document.querySelector("[data-ask-bottom-bar]")?.contains(active)));

  usePlayerStore.getState().exitAsk();
  if (usePlayerStore.getState().askPhase !== "idle") return;
  if (typeof document === "undefined") return;

  if (focusWasInLayer && typeof (active as HTMLElement).blur === "function") {
    (active as HTMLElement).blur();
  }

  const focusEntry = () => {
    if (typeof document === "undefined") return;
    if (usePlayerStore.getState().askPhase !== "idle") return;
    const bar = document.querySelector("[data-ask-bottom-bar]");
    const candidates = Array.from(document.querySelectorAll<HTMLElement>("[data-ask-entry]"));
    const persistent = candidates.find((el) => !bar || !bar.contains(el)) ?? candidates[0];
    persistent?.focus({ preventScroll: true });
  };
  focusEntry();
  if (typeof requestAnimationFrame !== "undefined") {
    requestAnimationFrame(focusEntry);
  }
  if (typeof window !== "undefined") {
    window.setTimeout(focusEntry, 0);
  }
}

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

const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

export { computeBottomOcclusion, type OcclusionParts };
export const computeOcclusion = computeBottomOcclusion;

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
  const closeAskPanel = usePlayerStore((s) => s.closeAskPanel);
  // 上一阶段在 effect 里更新。取消的焦点还原由 finishAskCancelSync 拥有；
  // 这里只留下 drafting 的 status 播报。
  const previousPhaseRef = useRef(askPhase);

  // Selection mode pays for the encode worker up front, on an idle callback,
  // so the first capture reuses it. The callback is not the submit task and
  // not the domToCanvas task.
  useEffect(() => {
    if (!ACTIVE_PHASES.has(askPhase)) return;
    scheduleEncodeWorkerPrewarm();
  }, [askPhase]);

  // 圈选期间唯一的 Esc。挂在始终挂载的这层。sending/streaming 不注册：
  // closeAskPanel / exitAsk 在这两态是空操作，和 0.3.1 一样。
  // 捕获阶段先于 Monaco 接到按键；真正关面板或退出时 preventDefault + stopPropagation，
  // 避免编辑器再处理同一次 Esc。忽略时不拦截，非圈选阶段不注册监听。
  useEffect(() => {
    if (!ESCAPE_PHASES.has(askPhase)) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (event.repeat) return;
      const action = resolveAskEscape(usePlayerStore.getState().askPhase, event.target, {
        composing: event.isComposing,
        defaultPrevented: event.defaultPrevented,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
      });
      if (action === "ignore") return;
      event.preventDefault();
      event.stopPropagation();
      if (action === "close-panel") {
        finishAskCancelSync(document.querySelector<HTMLElement>("[data-ask-panel]"), closeAskPanel);
      }
      else {
        exitAskAndFocusEntry();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [askPhase, closeAskPanel]);

  // 面板打开时（drafting / error 阶段）且非移动端时，通过捕获阶段监听 Tab 键管理焦点流转：
  // entry -> panel chips (roving) -> textarea -> cancel -> submit -> next after entry
  useEffect(() => {
    if (askPhase !== "drafting" && askPhase !== "error") return;

    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      const isMobileDevice = typeof window !== "undefined" && window.matchMedia("(max-width: 639px)").matches;
      if (isMobileDevice) return;

      const moved = handlePanelTabNavigation(event);
      if (moved) {
        event.preventDefault();
      }
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [askPhase]);

  // drafting → selecting 时把选区摘要写回 role=status。
  // 焦点由 finishAskCancelSync 在同一提交里写。
  // 这里不排 setTimeout / rAF / microtask，也不写焦点。
  useEffect(() => {
    const previous = previousPhaseRef.current;
    previousPhaseRef.current = askPhase;
    if (askPhase === "selecting" && previous === "drafting") {
      const curSelection = usePlayerStore.getState().selection;
      if (curSelection && curSelection.targets.length > 0) {
        const status = document.querySelector("[role=status]");
        if (status) status.textContent = summarizeSelection(curSelection);
      }
    }
  }, [askPhase]);

  return (
    <AskSelectionLayerActive
      stageRef={stageRef}
      stage={stage}
      askPhase={askPhase}
      active={LAYER_MOUNTED_PHASES.has(askPhase)}
      selection={selection}
      stepId={steps[currentIndex]?.id ?? ""}
      setAskSelection={setAskSelection}
      clearAskSelection={clearAskSelection}
    />
  );
}

function AskSelectionLayerActive({
  stageRef,
  stage,
  askPhase,
  active,
  selection,
  stepId,
  setAskSelection,
  clearAskSelection,
}: AskSelectionLayerProps & {
  askPhase: string;
  active: boolean;
  selection: AskSelectionSummary | null;
  stepId: string;
  setAskSelection: (selection: AskSelectionSummary) => void;
  clearAskSelection: () => void;
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
  const settleRafRef = useRef<number | null>(null);
  const downClientRef = useRef<{ clientX: number; clientY: number } | null>(null);
  const enteringSmoothScrollRef = useRef(false);
  const enteringScrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const enteringScrollRafRef = useRef<number | null>(null);
  const enteringScrollPositionsRef = useRef<{ windowY: number; ancestorTops: number[] } | null>(null);
  const enteringScrollTimestampRef = useRef<number>(0);
  const chipDragCleanupRef = useRef<(() => void) | null>(null);
  const dragStartedRef = useRef(false);
  const suppressClickUntilRef = useRef<number | null>(null);
  const touchCompletedSelectionRef = useRef(false);
  const lastPointerTypeRef = useRef<string | null>(null);
  const lastTouchCancelPointerUpRef = useRef<number | null>(null);
  const cancelClickSeenRef = useRef(false);

  const bottomBarRef = useRef<HTMLDivElement>(null);
  // Last mobile / keyboard / height snapshot from updateMeasurements.
  // Module-level so finishAskCancelSync restores selecting vars from the
  // same object this layer fills and invalidates. A cancel commit does not
  // measure heights here: innerHeight, visualViewport, and
  // getBoundingClientRect after a root custom-property write each force a
  // full-document recalc. Focus is owned by finishAskCancelSync.

  const [rubberBand, setRubberBand] = useState<RubberBand | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [activeShortcut, setActiveShortcut] = useState(0);
  const [rovingIndex, setRovingIndex] = useState(0);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const isMobile = useIsMobile();

  const getStage = useCallback(() => resolveStage(stage, stageRef), [stage, stageRef]);

  /** 获取当前视口与所有可滚动祖先的垂直滚动位置快照。 */
  const getScrollPositions = useCallback((): { windowY: number; ancestorTops: number[] } => {
    if (typeof window === "undefined") return { windowY: 0, ancestorTops: [] };
    const ancestorTops: number[] = [];
    let node: HTMLElement | null = getStage()?.parentElement ?? null;
    while (node && node !== document.body && node !== document.documentElement) {
      if (node.scrollHeight > node.clientHeight + 1 || node.scrollWidth > node.clientWidth + 1) {
        ancestorTops.push(node.scrollTop);
      }
      node = node.parentElement;
    }
    return { windowY: window.scrollY, ancestorTops };
  }, [getStage]);

  /** 清理进入滚动追踪器（廉价清理，不触发 scrollTo）。 */
  const clearEnteringScrollTracker = useCallback(() => {
    if (enteringScrollRafRef.current != null) {
      cancelAnimationFrame(enteringScrollRafRef.current);
      enteringScrollRafRef.current = null;
    }
    if (enteringScrollTimerRef.current) {
      clearTimeout(enteringScrollTimerRef.current);
      enteringScrollTimerRef.current = null;
    }
    enteringSmoothScrollRef.current = false;
    enteringScrollPositionsRef.current = null;
    enteringScrollTimestampRef.current = 0;
  }, []);

  // 不活动时不查 document：这层在 idle / sending 也挂着，服务端渲染没有 document。
  const visibleShortcuts = !active
    ? []
    : SHORTCUTS.filter((item) => {
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

  // 触摸框选后或触摸取消按钮后浏览器会延时派发 ghost click，在此处吞掉以防误触下方元素。
  useEffect(() => {
    const onDocPointerDown = (event: globalThis.PointerEvent) => {
      lastPointerTypeRef.current = event.pointerType;
      // A compatibility mousedown after waiting-cancel still has
      // askCancelGhostUntil in the future. Clearing the touch-selection
      // window here would let that ghost click through.
      if (
        typeof performance !== "undefined" &&
        askCancelGhostUntil > 0 &&
        performance.now() < askCancelGhostUntil
      ) {
        return;
      }
      suppressClickUntilRef.current = null;
      touchCompletedSelectionRef.current = false;
      lastTouchCancelPointerUpRef.current = null;
      cancelClickSeenRef.current = false;
    };
    const onDocPointerUp = (event: globalThis.PointerEvent) => {
      if (event.pointerType !== "touch") return;
      const target = event.target as Element | null;
      if (target?.closest?.("[data-ask-panel] [data-ask-cancel], [data-ask-cancel]")) {
        lastTouchCancelPointerUpRef.current = event.timeStamp;
        cancelClickSeenRef.current = false;
      }
    };
    const ghostMouse = (event: globalThis.MouseEvent) => {
      if (event.detail === 0) return false;
      if (lastPointerTypeRef.current !== "touch") return false;
      if (!touchCompletedSelectionRef.current) return false;
      return (
        suppressClickUntilRef.current != null &&
        event.timeStamp <= suppressClickUntilRef.current
      );
    };
    // The compatibility mousedown that follows a touch cancel lands after the
    // panel has unmounted, so it hits the layer and focuses it. preventDefault
    // on that mousedown keeps the chip focus finishAskCancelSync just set.
    const onDocMouseDown = (event: globalThis.MouseEvent) => {
      if (!ghostMouse(event)) return;
      event.preventDefault();
      event.stopPropagation();
    };
    const onDocClick = (event: globalThis.MouseEvent) => {
      cancelClickSeenRef.current = true;
      const target = event.target as Element | null;
      if (target?.closest?.("[data-ask-panel] [data-ask-cancel], [data-ask-cancel]")) {
        return;
      }
      if (!ghostMouse(event)) return;
      event.preventDefault();
      event.stopPropagation();
      suppressClickUntilRef.current = null;
      touchCompletedSelectionRef.current = false;
    };
    document.addEventListener("pointerdown", onDocPointerDown, true);
    document.addEventListener("pointerup", onDocPointerUp, true);
    document.addEventListener("mousedown", onDocMouseDown, true);
    document.addEventListener("click", onDocClick, true);
    return () => {
      document.removeEventListener("pointerdown", onDocPointerDown, true);
      document.removeEventListener("pointerup", onDocPointerUp, true);
      document.removeEventListener("mousedown", onDocMouseDown, true);
      document.removeEventListener("click", onDocClick, true);
    };
  }, []);

  // 处于 selecting 且无选区时播报（含首次进入与再次进入）。优先写入页面已有的 role=status。
  useEffect(() => {
    if (askPhase !== "selecting") return;
    if (selection && selection.targets.length > 0) return;
    const status = document.querySelector("[role=status]");
    if (status) status.textContent = ASK_ENTERED_STATUS;
  }, [askPhase, selection]);

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

  useEffect(() => {
    return () => {
      chipDragCleanupRef.current?.();
      chipDragCleanupRef.current = null;
      if (settleRafRef.current != null) {
        cancelAnimationFrame(settleRafRef.current);
        settleRafRef.current = null;
      }
    };
  }, []);

  const updateMeasurements = useCallback(() => {
    if (typeof document === "undefined") return;
    // Reads first. Writing a custom property invalidates style for the whole
    // document, so a measure after a write pays for a full recalc (the cancel
    // commit on a 390px phone spent ~90ms here). Every read below runs before
    // any setProperty.
    const isMobileDevice = typeof window !== "undefined" && window.matchMedia("(max-width: 639px)").matches;
    const viewport = typeof window !== "undefined" ? window.visualViewport : null;
    const kbOpen =
      viewport != null && typeof window !== "undefined" && window.innerHeight - viewport.height > 120;

    const cache = sharedAskMeasureCache;
    cache.isMobile = isMobileDevice;
    cache.keyboardOpen = kbOpen;

    let nextBar = "0px";
    let nextOcclusion = "0px";
    if (active && isMobileDevice && !kbOpen) {
      const playerH = measureAskPlayerBarHeight();
      cache.playerHeight = playerH;

      let panelH = 0;
      const panelEl = document.querySelector<HTMLElement>("[data-ask-panel]");
      if (panelEl) {
        panelH = measureAskElementHeight(panelEl);
      }

      let barH = 0;
      const panelOpen = panelH > 0 || askPhase !== "selecting";
      if (!panelOpen) {
        const barEl = bottomBarRef.current ?? document.querySelector<HTMLElement>("[data-ask-bottom-bar]");
        barH = measureAskElementHeight(barEl);
        // A missing bar is not a measured 0. Keep the previous height so a
        // later cancel can still restore the chip bar without a fresh read.
        if (barEl) cache.barHeight = barH;
      }
      nextBar = `${barH}px`;
      nextOcclusion = `${computeBottomOcclusion({
        playerHeight: playerH,
        barHeight: barH,
        panelHeight: panelH,
      })}px`;
    }

    // setState after the reads. It does not write a CSS variable, and on the
    // cancel path the keyboard flag is unchanged so this is a no-op.
    setKeyboardOpen(kbOpen);

    // --ask-player-bar-h is owned by AskPlayerBarVar, which stays mounted
    // after this chrome unmounts. This effect only publishes the chip bar
    // and the occlusion total, and only while the chrome is up. Skip a write
    // whose inline value is already what we measured: the cancel frame's
    // selecting restore is then a no-op and the box does not move.
    writeAskRootVars({
      "--ask-bottom-bar-h": nextBar,
      "--ask-bottom-occlusion": nextOcclusion,
    });
  }, [active, askPhase]);

  const measureRafRef = useRef<number | null>(null);
  // ResizeObserver rebind runs in the same frame as the measurement. The
  // mount effect fills this in; phase-change frames only measure.
  const afterMeasureRef = useRef<(() => void) | null>(null);
  // Latest measurement, so a frame queued before this render still applies
  // the phase that just committed. scheduleUpdate itself stays stable: the
  // mount effect must not re-subscribe (and reset the variables) on a phase change.
  const updateMeasurementsRef = useRef(updateMeasurements);
  updateMeasurementsRef.current = updateMeasurements;
  const scheduleUpdate = useCallback(() => {
    const run = () => {
      updateMeasurementsRef.current();
      afterMeasureRef.current?.();
    };
    if (typeof requestAnimationFrame !== "function") {
      run();
      return;
    }
    if (measureRafRef.current !== null) return;
    measureRafRef.current = requestAnimationFrame(() => {
      measureRafRef.current = null;
      run();
    });
  }, []);

  // Selecting targets for a cancel commit. Panel contribution is 0. Uses only
  // the shared measure cache, so this path does no layout read (no innerHeight,
  // visualViewport, matchMedia, or getBoundingClientRect). An incomplete
  // cache writes nothing; the scheduleUpdate rAF already queued by the
  // layout effect re-measures before the next paint. finishAskCancelSync
  // already wrote these vars, so this call is a no-op when the values match.
  const writeSelectingCssVarsSync = useCallback(() => {
    if (typeof document === "undefined") return;
    applyAskSelectingRootVars(sharedAskMeasureCache, active);
  }, [active]);

  const prevAskPhaseRef = useRef(askPhase);
  useIsomorphicLayoutEffect(() => {
    const prev = prevAskPhaseRef.current;
    prevAskPhaseRef.current = askPhase;

    // Non-cancel phase changes stay on the next frame: measuring in the
    // commit invalidates style for the document. Cancel (any phase other
    // than selecting/idle → selecting) drops the panel contribution in this
    // same commit so waiting values cannot sit for one frame.
    // Focus is owned by finishAskCancelSync. This effect does not blur or
    // focus. CSS vars still come from the cache below — that path must not
    // measure.
    // Waiting cancel (sending|streaming → selecting) also needs ghost
    // mousedown suppress so chip focus from finishAskCancelSync sticks
    // until paint. The compatibility mousedown hits [data-ask-layer].
    const closingPanel =
      prev === "drafting" || prev === "error" || prev === "sending" || prev === "streaming";
    const cancelToSelecting = askPhase === "selecting" && prev !== "selecting" && prev !== "idle";

    if (askPhase === "selecting" && closingPanel) {
      const now = typeof performance !== "undefined" ? performance.now() : Date.now();
      const lastUp = lastTouchCancelPointerUpRef.current;
      if (
        lastUp != null &&
        Math.abs(now - lastUp) <= 400 &&
        !cancelClickSeenRef.current
      ) {
        suppressClickUntilRef.current = Math.max(now, lastUp) + 400;
        touchCompletedSelectionRef.current = true;
      }
      lastTouchCancelPointerUpRef.current = null;
    }

    // finishAskCancelSync already wrote selecting vars before focus. This
    // write is a no-op when those values match. A store-only cancel (no
    // finishAskCancelSync) still publishes the cached selecting vars here.
    // Focus stays in finishAskCancelSync: this effect does not blur or focus.
    if (cancelToSelecting) {
      writeSelectingCssVarsSync();
    }

    // The queued frame re-measures and rebinds ResizeObserver. When the
    // cached values already match the inline style, that frame writes nothing.
    scheduleUpdate();
  }, [active, askPhase, scheduleUpdate, writeSelectingCssVarsSync]);

  // 测量底部条高度、播放区高度与抽屉面板高度，并同步 --ask-bottom-bar-h 和 --ask-bottom-occlusion。
  // --ask-player-bar-h 由始终挂载的 AskPlayerBarVar 写。
  // 桌面/inactive/unmount/键盘打开时设为 0px（或 removeProperty）。
  // 取消回到 selecting 时，finishAskCancelSync 先用缓存写上目标值再 focus；
  // 这里只在它没写过时补一次缓存写。其余阶段变化、ResizeObserver、scroll、
  // mount 仍走 scheduleUpdate 的 rAF。
  // resize / visualViewport / orientationchange / matchMedia change 先作废缓存，
  // 这样下一次取消不会用过期高度。ResizeObserver 只排 rAF：面板开着时底栏不在，
  // 不能把已记住的底栏高度清成未测量。
  useEffect(() => {
    if (typeof document === "undefined") return;

    let observedBarEl: HTMLElement | null = null;
    let observedPlayerEl: HTMLElement | null = null;
    let observedPanelEl: HTMLElement | null = null;
    let ro: ResizeObserver | null = null;

    const syncObserved = () => {
      const curBarEl = bottomBarRef.current ?? document.querySelector<HTMLElement>("[data-ask-bottom-bar]");
      const curPlayerEl = document.querySelector<HTMLElement>('[aria-label="讲解播放区"]');
      const curPanelEl = document.querySelector<HTMLElement>("[data-ask-panel]");
      if (!ro) return;
      if (curPlayerEl !== observedPlayerEl) {
        if (observedPlayerEl) ro.unobserve(observedPlayerEl);
        observedPlayerEl = curPlayerEl;
        if (curPlayerEl) ro.observe(curPlayerEl);
      }
      if (curBarEl !== observedBarEl) {
        if (observedBarEl) ro.unobserve(observedBarEl);
        observedBarEl = curBarEl;
        if (curBarEl) ro.observe(curBarEl);
      }
      if (curPanelEl !== observedPanelEl) {
        if (observedPanelEl) ro.unobserve(observedPanelEl);
        observedPanelEl = curPanelEl;
        if (curPanelEl) ro.observe(curPanelEl);
      }
    };
    afterMeasureRef.current = syncObserved;

    scheduleUpdate();

    const barEl = bottomBarRef.current ?? document.querySelector<HTMLElement>("[data-ask-bottom-bar]");
    const playerEl = document.querySelector<HTMLElement>('[aria-label="讲解播放区"]');
    const panelEl = document.querySelector<HTMLElement>("[data-ask-panel]");

    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(() => {
        scheduleUpdate();
      });
      if (barEl) {
        observedBarEl = barEl;
        ro.observe(barEl);
      }
      if (playerEl) {
        observedPlayerEl = playerEl;
        ro.observe(playerEl);
      }
      if (panelEl) {
        observedPanelEl = panelEl;
        ro.observe(panelEl);
      }
    }

    let mo: MutationObserver | null = null;
    if (typeof MutationObserver !== "undefined") {
      mo = new MutationObserver(() => {
        scheduleUpdate();
      });
      mo.observe(document.body, { childList: true, subtree: true });
    }

    const mq = window.matchMedia("(max-width: 639px)");
    const onInvalidate = () => {
      invalidateAskMeasureCache(sharedAskMeasureCache);
      scheduleUpdate();
    };
    mq.addEventListener("change", onInvalidate);

    window.addEventListener("resize", onInvalidate);
    window.addEventListener("orientationchange", onInvalidate);
    window.visualViewport?.addEventListener("resize", onInvalidate);

    const onScroll = () => {
      scheduleUpdate();
      if (enteringSmoothScrollRef.current) {
        const current = getScrollPositions();
        if (!isSameScrollPositions(enteringScrollPositionsRef.current, current)) {
          enteringScrollPositionsRef.current = current;
          enteringScrollTimestampRef.current = performance.now();
        }
      }
    };
    window.addEventListener("scroll", onScroll, { passive: true, capture: true });

    return () => {
      afterMeasureRef.current = null;
      if (measureRafRef.current !== null) {
        cancelAnimationFrame(measureRafRef.current);
        measureRafRef.current = null;
      }
      ro?.disconnect();
      mo?.disconnect();
      mq.removeEventListener("change", onInvalidate);
      window.removeEventListener("resize", onInvalidate);
      window.removeEventListener("orientationchange", onInvalidate);
      window.visualViewport?.removeEventListener("resize", onInvalidate);
      window.removeEventListener("scroll", onScroll, { capture: true } as EventListenerOptions);
      document.documentElement.style.setProperty("--ask-bottom-bar-h", "0px");
      document.documentElement.style.setProperty("--ask-bottom-occlusion", "0px");
    };
  }, [scheduleUpdate, getScrollPositions]);

  // 当进入 ask 模式（selecting）在移动端时，确保代码区域可见。
  useEffect(() => {
    if (askPhase !== "selecting") return;
    const isMobile = typeof window !== "undefined" && window.matchMedia("(max-width: 639px)").matches;
    if (!isMobile) return;

    if (enteringScrollRafRef.current != null) {
      cancelAnimationFrame(enteringScrollRafRef.current);
    }
    enteringScrollRafRef.current = requestAnimationFrame(() => {
      enteringScrollRafRef.current = null;
      const host = getStage();
      const codeEl = host?.querySelector<HTMLElement>('[data-ask-target="code"]');
      if (!codeEl) return;

      const barEl = bottomBarRef.current ?? document.querySelector<HTMLElement>("[data-ask-bottom-bar]");
      const barObstacle = getAskBottomObstacle(barEl);
      const codeRect = codeEl.getBoundingClientRect();

      const inView = isElementFullyInView(
        { top: codeRect.top, bottom: codeRect.bottom },
        { innerHeight: window.innerHeight, bottomBarHeight: barObstacle },
      );

      if (!inView) {
        const prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        if (!prefersReduced) {
          enteringSmoothScrollRef.current = true;
          // 记录初始滚动位置和时间戳
          enteringScrollPositionsRef.current = getScrollPositions();
          enteringScrollTimestampRef.current = performance.now();

          // 追踪平滑滚动：每帧记录最新滚动位置和变化时间戳
          const track = () => {
            const current = getScrollPositions();
            if (!isSameScrollPositions(enteringScrollPositionsRef.current, current)) {
              enteringScrollPositionsRef.current = current;
              enteringScrollTimestampRef.current = performance.now();
            }
            enteringScrollRafRef.current = requestAnimationFrame(track);
          };
          enteringScrollRafRef.current = requestAnimationFrame(track);

          if (enteringScrollTimerRef.current) clearTimeout(enteringScrollTimerRef.current);
          const onScrollEnd = () => {
            clearEnteringScrollTracker();
            window.removeEventListener("scrollend", onScrollEnd);
          };
          window.addEventListener("scrollend", onScrollEnd, { once: true });
          enteringScrollTimerRef.current = setTimeout(() => {
            clearEnteringScrollTracker();
            window.removeEventListener("scrollend", onScrollEnd);
          }, 800);
        }
        codeEl.scrollIntoView({ block: "nearest", behavior: prefersReduced ? "auto" : "smooth" });
      }
    });

    return () => {
      clearEnteringScrollTracker();
    };
  }, [askPhase, getStage, getScrollPositions, clearEnteringScrollTracker]);

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
    if (settleRafRef.current != null) {
      cancelAnimationFrame(settleRafRef.current);
      settleRafRef.current = null;
    }
    downClientRef.current = null;
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
      const motion = Math.max(Math.abs(dx), Math.abs(dy));

      const codeElements = Array.from(
        host.querySelectorAll<HTMLElement>('[data-ask-target="code"]'),
      ).filter((el) => el.closest("[data-ask-exclude]") === null);

      const dragBox =
        box.width === 0 || box.height === 0
          ? { x: box.x, y: box.y, width: Math.max(box.width, 1), height: Math.max(box.height, 1) }
          : box;

      const dragIntersectsCode = codeElements.some((codeEl) =>
        intersects(dragBox, normalizeBBox(relativeRect(host, codeEl))),
      );

      const isPointInside = (pt: PointerSample, el: HTMLElement) => {
        const r = normalizeBBox(relativeRect(host, el));
        return pt.x >= r.x && pt.x <= r.x + r.width && pt.y >= r.y && pt.y <= r.y + r.height;
      };

      const isClick = motion < ASK_LIMITS.dragThresholdPx;
      const clickCodeEl = isClick
        ? codeElements.find((codeEl) => isPointInside(current, codeEl) || isPointInside(origin, codeEl))
        : undefined;

      let point: { x: number; y: number } | null;
      let candidateBox: AskBBox;

      if (motion >= ASK_LIMITS.dragThresholdPx && dragIntersectsCode) {
        candidateBox = box;
        point = null;
      } else if (isClick && clickCodeEl) {
        const pointerPos = isPointInside(current, clickCodeEl) ? current : origin;
        candidateBox = { x: pointerPos.x, y: pointerPos.y, width: 1, height: 1 };
        point = { x: pointerPos.x, y: pointerPos.y };
      } else {
        const pointLike =
          motion < ASK_LIMITS.dragThresholdPx ||
          box.width < MIN_REGION_SIDE ||
          box.height < MIN_REGION_SIDE;
        point = pointLike
          ? { x: box.x + box.width / 2, y: box.y + box.height / 2 }
          : null;
        candidateBox = point
          ? { x: point.x, y: point.y, width: Math.max(box.width, 1), height: Math.max(box.height, 1) }
          : box;
      }

      const candidates = collectAskCandidates(host, candidateBox);
      const hit = point ? hitTestPoint(point.x, point.y, candidates) : hitTest(box, candidates);

      const codeIntersected = dragIntersectsCode || Boolean(clickCodeEl);
      const codeCollected = hit.targets.some((t) => t.kind === "code");

      if (hit.targets.length === 0) {
        if (codeIntersected) {
          setHint(ASK_CODE_MISS_HINT);
        } else {
          setHint(ASK_EMPTY_HIT);
        }
        setAskCodeMissNotice(null);
        return false;
      }

      setHint(null);
      if (codeIntersected && !codeCollected) {
        setAskCodeMissNotice(ASK_CODE_MISS_HINT);
      } else {
        setAskCodeMissNotice(null);
      }
      setAskOpenSource({ kind: "box" });
      setAskSelection({ mode: hit.mode, bbox: box, targets: hit.targets });
      return true;
    },
    [getStage, setAskSelection],
  );

  /** 停住进行中的进入滚动（平滑滚动）。返回是否确实有滚动被停住。 */
  const stopInflightScroll = (): boolean => {
    const wasScrolling = enteringSmoothScrollRef.current;
    clearEnteringScrollTracker();
    if (typeof window !== "undefined") {
      // scrollIntoView 的平滑滚动会带上所有可滚动祖先，逐个停在当前位置。
      let node: HTMLElement | null = getStage()?.parentElement ?? null;
      while (node && node !== document.body && node !== document.documentElement) {
        if (node.scrollHeight > node.clientHeight + 1 || node.scrollWidth > node.clientWidth + 1) {
          node.scrollTo({ top: node.scrollTop, left: node.scrollLeft, behavior: "auto" });
        }
        node = node.parentElement;
      }
      window.scrollTo({ top: window.scrollY, left: window.scrollX, behavior: "auto" });
    }
    return wasScrolling;
  };

  const beginPointer = (
    hostEl: HTMLElement,
    pointerId: number,
    pointerType: string,
    button: number,
    clientX: number,
    clientY: number,
  ) => {
    if (button !== 0 && pointerType === "mouse") return;
    const stageHost = getStage();
    if (!stageHost) return;
    const sample = sampleAt(stageHost, clientX, clientY);
    pointersRef.current.set(pointerId, sample);
    if (!hostEl.hasPointerCapture(pointerId)) hostEl.setPointerCapture(pointerId);

    if (pointersRef.current.size >= 2) {
      if (settleRafRef.current != null) {
        cancelAnimationFrame(settleRafRef.current);
        settleRafRef.current = null;
      }
      downClientRef.current = null;
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

    // 根据 pointerdown 时刻的实时状态判断进入滚动是否仍在进行中：
    // 仅当追踪器激活，且当前滚动位置与上次记录不同或最近一次滚动变化在约 50ms 以内时，才视为正在滚动。
    const isTrackerActive =
      enteringSmoothScrollRef.current ||
      enteringScrollRafRef.current != null ||
      enteringScrollTimerRef.current != null;
    const currentPositions = getScrollPositions();
    const isScrolling = isEnteringScrollInFlight(
      isTrackerActive,
      enteringScrollPositionsRef.current,
      currentPositions,
      enteringScrollTimestampRef.current,
      performance.now(),
    );

    if (isScrolling) {
      // 正在滚动：停住平滑滚动，并安排落定 rAF 重新校准起点
      stopInflightScroll();
      const start = sampleAt(stageHost, clientX, clientY);
      pointersRef.current.set(pointerId, start);
      originRef.current = start;
      drawingRef.current = true;
      setRubberBand(bandFrom(start, start));
      if (settleRafRef.current != null) {
        cancelAnimationFrame(settleRafRef.current);
        settleRafRef.current = null;
      }
      downClientRef.current = { clientX, clientY };
      settleRafRef.current = requestAnimationFrame(() => {
        settleRafRef.current = null;
        downClientRef.current = null;
        if (originRef.current !== start || !drawingRef.current) return;
        const settledHost = getStage();
        if (!settledHost) return;
        const settled = sampleAt(settledHost, clientX, clientY);
        originRef.current = settled;
        const cur = pointersRef.current.get(pointerId);
        if (cur === start) pointersRef.current.set(pointerId, settled);
        setRubberBand(bandFrom(settled, cur === start || !cur ? settled : cur));
      });
    } else {
      // 未在滚动：廉价清理可能残留的定时器与状态，不调用 scrollTo，不安排落定 rAF
      clearEnteringScrollTracker();
      if (settleRafRef.current != null) {
        cancelAnimationFrame(settleRafRef.current);
        settleRafRef.current = null;
      }
      downClientRef.current = null;
      const start = sampleAt(stageHost, clientX, clientY);
      pointersRef.current.set(pointerId, start);
      originRef.current = start;
      drawingRef.current = true;
      setRubberBand(bandFrom(start, start));
    }
  };

  const isIgnoredTarget = (target: EventTarget | null): boolean => {
    const el = target instanceof Element ? target : (target as Node | null)?.parentElement;
    return Boolean(
      el?.closest?.("[data-ask-bottom-bar], [data-ask-entry], [data-ask-shortcut]"),
    );
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    suppressClickUntilRef.current = null;
    touchCompletedSelectionRef.current = false;
    lastPointerTypeRef.current = event.pointerType;
    // Waiting keeps the shell mounted so cancel can restore selecting in
    // the same commit. A press on that shell must not start a selection.
    if (askPhase === "sending" || askPhase === "streaming") return;
    if (isIgnoredTarget(event.target)) return;
    beginPointer(event.currentTarget, event.pointerId, event.pointerType, event.button, event.clientX, event.clientY);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (isIgnoredTarget(event.target)) return;
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
    if (settleRafRef.current != null) {
      cancelAnimationFrame(settleRafRef.current);
      settleRafRef.current = null;
      if (drawingRef.current && originRef.current != null && downClientRef.current) {
        const settledHost = getStage();
        if (settledHost) {
          const settled = sampleAt(settledHost, downClientRef.current.clientX, downClientRef.current.clientY);
          const prevOrigin = originRef.current;
          originRef.current = settled;
          const cur = pointersRef.current.get(event.pointerId);
          if (cur === prevOrigin) pointersRef.current.set(event.pointerId, settled);
        }
      }
      downClientRef.current = null;
    }
    if (isIgnoredTarget(event.target)) return;
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
      const selected = commitBand(origin, current);
      if (selected && event.pointerType === "touch") {
        suppressClickUntilRef.current = event.timeStamp + 400;
        touchCompletedSelectionRef.current = true;
      }
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
    if (settleRafRef.current != null) {
      cancelAnimationFrame(settleRafRef.current);
      settleRafRef.current = null;
    }
    downClientRef.current = null;
    if (isIgnoredTarget(event.target)) return;
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
    setAskOpenSource({ kind: "chip", key });
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
    // Esc 只由窗口级监听处理，避免和这里重复退出。
    if (key === "Escape") return;
    if (
      (key === "Enter" || key === " ") &&
      (event.shiftKey || event.ctrlKey || event.altKey || event.metaKey)
    ) {
      return;
    }
    const blocked = key === " " || key === "ArrowLeft" || key === "ArrowRight" || key === "ArrowUp" || key === "ArrowDown";
    if (blocked || key === "Enter") {
      event.stopPropagation();
    }
    if (key === " " || key === "ArrowLeft" || key === "ArrowRight") {
      event.preventDefault();
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
      setAskOpenSource({ kind: "box" });
      setAskSelection({ mode: "single", bbox: match.rect, targets: [match.target] });
    }
  };

  const showShortcuts = askPhase === "selecting";
  const band = rubberBand ? normalizeBBox(rubberBand) : null;
  const selectedBox = selection && selection.targets.length > 0 ? normalizeBBox(selection.bbox) : null;
  const label = selection && selection.targets.length > 0 ? summarizeSelection(selection) : null;
  const labelBelow = selectedBox != null && selectedBox.y < 28;

  if (!active) return null;

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
      <div data-ask-capture-exclude className="pointer-events-none absolute inset-x-0 top-0 max-sm:z-40 sm:z-10 flex flex-col gap-1 p-2">
        <p className="text-xs text-chalk-100">{hint ?? ASK_LAYER_HINT}</p>
        {showShortcuts ? (
          <div
            ref={bottomBarRef}
            data-ask-bottom-bar
            data-ask-layer-part="bottom-bar"
            data-keyboard-open={keyboardOpen ? "" : undefined}
            role="group"
            aria-label="点选捷径"
            className={`pointer-events-auto flex items-center max-sm:flex-nowrap gap-2 max-sm:fixed max-sm:inset-x-2 max-sm:top-auto max-sm:bottom-[calc(var(--ask-player-bar-h)+env(safe-area-inset-bottom)+8px)] max-sm:z-40 max-sm:h-[60px] max-sm:box-border max-sm:rounded-xl max-sm:border max-sm:border-board-600 max-sm:bg-board-900/95 max-sm:px-2 max-sm:py-0 max-sm:shadow-lg sm:relative sm:inset-auto sm:bottom-auto sm:z-auto sm:rounded-none sm:border-0 sm:bg-transparent sm:p-0 sm:shadow-none sm:gap-1 sm:flex-wrap ${keyboardOpen ? "max-sm:hidden" : ""}`}
            onPointerDown={(event) => {
              event.stopPropagation();
            }}
            onPointerUp={(event) => {
              event.stopPropagation();
            }}
            onClick={(event) => {
              event.stopPropagation();
            }}
          >
            {(() => {
              const selectedShortcutKey =
                selection?.mode === "single" && selection.targets.length === 1
                  ? (selection.targets[0].kind as ShortcutKey)
                  : null;
              const selectedShortcutIndex = visibleShortcuts.findIndex(
                (item) => item.key === selectedShortcutKey,
              );
              const effectiveTabbableIndex =
                selectedShortcutIndex !== -1
                  ? selectedShortcutIndex
                  : Math.min(activeShortcut, Math.max(0, visibleShortcuts.length - 1));

              return (
                <div
                  role="group"
                  aria-label="快捷选项"
                  className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto py-1 max-sm:px-1 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden sm:contents"
                >
                  {visibleShortcuts.map((item, index) => {
                    const isSelected = selectedShortcutIndex === index;
                    const isTabbable = index === effectiveTabbableIndex;
                    return (
                      <button
                        key={item.key}
                        type="button"
                        data-ask-shortcut={item.key}
                        aria-pressed={isSelected ? true : undefined}
                        tabIndex={isTabbable ? 0 : -1}
                        className="min-h-11 min-w-11 pointer-coarse:min-h-11 pointer-coarse:min-w-11 inline-flex shrink-0 items-center justify-center rounded-full border border-board-600 bg-board-900/80 px-3 py-1 text-xs sm:px-2 sm:py-0.5 sm:text-[10px] sm:min-h-0 sm:min-w-0 sm:pointer-coarse:min-h-11 sm:pointer-coarse:min-w-11 text-chalk-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-beam-gold focus-visible:ring-inset"
                        onClick={(event) => {
                          event.stopPropagation();
                          // 拖过阈值后的 click 只留下框选，不再把捷径当成点选。
                          if (dragStartedRef.current) {
                            dragStartedRef.current = false;
                            return;
                          }
                          setActiveShortcut(index);
                          pickShortcut(item.key);
                        }}
                        onKeyDown={(event) => {
                          // 1280：从芯片组 Shift+Tab 回到入口按钮（和入口 Tab 进来对称）。
                          // 焦点在芯片上：Enter / 空格选中这个芯片本身，不交给图层的 Enter（会选当前代码）。
                          if (
                            (event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) &&
                            (event.key === "Enter" || event.key === " ")
                          ) {
                            return;
                          }
                          if (
                            (event.key === "Enter" || event.key === " ") &&
                            !event.altKey &&
                            !event.ctrlKey &&
                            !event.metaKey &&
                            !event.shiftKey
                          ) {
                            event.preventDefault();
                            event.stopPropagation();
                            if (event.repeat) return;
                            setActiveShortcut(index);
                            pickShortcut(item.key);
                            return;
                          }
                          if (
                            event.key === "Tab" &&
                            event.shiftKey &&
                            !event.altKey &&
                            !event.ctrlKey &&
                            !event.metaKey &&
                            !isMobile
                          ) {
                            const entry = document.querySelector<HTMLElement>(
                              "[data-ask-entry]:not([data-ask-bottom-bar] [data-ask-entry])",
                            );
                            if (entry) {
                              event.preventDefault();
                              event.stopPropagation();
                              entry.focus();
                              return;
                            }
                          }
                          if (
                            event.key === "ArrowRight" ||
                            event.key === "ArrowLeft" ||
                            event.key === "Home" ||
                            event.key === "End"
                          ) {
                            event.preventDefault();
                            event.stopPropagation();
                            const next = nextRovingIndex(index, visibleShortcuts.length, event.key);
                            setActiveShortcut(next);
                            const buttons =
                              bottomBarRef.current?.querySelectorAll<HTMLButtonElement>("[data-ask-shortcut]");
                            buttons?.[next]?.focus();
                          }
                        }}
                        onPointerDown={(event) => {
                          // 点按仍选中捷径。拖过阈值就从起点起框，捷径不能挡住代码区起拖。
                          if (event.button !== 0 && event.pointerType === "mouse") return;
                          const startX = event.clientX;
                          const startY = event.clientY;
                          const pointerId = event.pointerId;
                          const host = event.currentTarget.closest<HTMLElement>("[data-ask-layer]");
                          if (!host) return;
                          chipDragCleanupRef.current?.();
                          dragStartedRef.current = false;
                          const detach = () => {
                            window.removeEventListener("pointermove", onMove);
                            window.removeEventListener("pointerup", onUp);
                            window.removeEventListener("pointercancel", onCancel);
                            if (chipDragCleanupRef.current === detach) chipDragCleanupRef.current = null;
                          };
                          const onMove = (move: globalThis.PointerEvent) => {
                            if (move.pointerId !== pointerId) return;
                            if (Math.hypot(move.clientX - startX, move.clientY - startY) < ASK_LIMITS.dragThresholdPx) return;
                            dragStartedRef.current = true;
                            detach();
                            beginPointer(host, pointerId, event.pointerType, 0, startX, startY);
                          };
                          const onUp = (up: globalThis.PointerEvent) => {
                            if (up.pointerId !== pointerId) return;
                            detach();
                          };
                          const onCancel = (cancel: globalThis.PointerEvent) => {
                            if (cancel.pointerId !== pointerId) return;
                            detach();
                          };
                          chipDragCleanupRef.current = detach;
                          window.addEventListener("pointermove", onMove);
                          window.addEventListener("pointerup", onUp);
                          window.addEventListener("pointercancel", onCancel);
                        }}
                      >
                        {item.label}
                      </button>
                    );
                  })}
                </div>
              );
            })()}
            {isMobile ? (
              <button
                type="button"
                data-ask-entry
                tabIndex={-1}
                aria-pressed="true"
                aria-keyshortcuts="Escape"
                className="shrink-0 min-h-11 min-w-11 pointer-coarse:min-h-11 pointer-coarse:min-w-11 inline-flex items-center justify-center gap-1 rounded-full border border-board-600 bg-board-900/80 px-3 py-1 font-mono text-xs text-chalk-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-beam-gold focus-visible:ring-inset sm:hidden whitespace-nowrap"
                onClick={(event) => {
                  event.stopPropagation();
                  exitAskAndFocusEntry();
                }}
              >
                <span>{ASK_EXIT_LABEL}</span>
                <kbd
                  data-ask-kbd
                  className="max-[391px]:hidden rounded border border-board-600 px-1 font-mono text-[9px] leading-none text-chalk-500"
                  aria-hidden
                >
                  Esc
                </kbd>
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      {band && (band.width > 0 || band.height > 0) ? (
        <div
          data-ask-rubber
          data-ask-capture-exclude
          className="pointer-events-none absolute border-2 border-dashed border-beam-gold shadow-[0_0_0_9999px_rgba(0,0,0,0.4)]"
          style={{ left: band.x, top: band.y, width: band.width, height: band.height }}
        />
      ) : null}

      {selectedBox ? (
        <div
          data-ask-selection
          data-ask-capture-exclude
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
          data-ask-capture-exclude
          className="pointer-events-none absolute border border-beam-gold"
          style={{ left: box.rect.x, top: box.rect.y, width: box.rect.width, height: box.rect.height }}
        />
      ))}
    </>
  );
}
