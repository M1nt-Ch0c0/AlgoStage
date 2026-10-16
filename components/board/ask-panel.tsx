/**
 * AskPanel · 提问面板。桌面（≥lg）绝对定位浮在选区右侧，放不下则放下方；
 * 窄屏固定底部抽屉，最高 50vh，bottom 跟 visualViewport 避开键盘。
 * 提问先 captureStage；stepId、selection 引用或面板会话变了就丢弃。截图失败仍 sendAsk(null)，
 * 并把「没截到图」记在 store。回答开始流出或落到 playing 时提问面板卸掉（选区已被清空，
 * 不能留着「已选：无」的草稿框）；截图失败提示留到下一次提问，或仍在圈选时退出。
 * Esc 由画选层的窗口监听处理：closeAskPanel（回 selecting）。关面板（取消按钮或 Esc）后焦点回到选区原目标。
 */
"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import Link from "next/link";
import { cancelAsk, retroCancelAsk, sendAsk } from "@/lib/ask/ask-client";
import { chooseAskScrollBlock } from "@/lib/ask/ask-scroll";
import { ASK_ERROR_SPECS, resolveAskError, type AskErrorAction } from "@/lib/ask/ask-errors";
import { askAb } from "@/lib/ask/ask-ab";
import {
  isAskTimingEnabled,
  markAskPhase,
  markAskPointerDown,
  markAskTiming,
  noteCancelPaint,
} from "@/lib/ask/ask-timing";
import { listenCancelPress } from "@/lib/ask/cancel-press";
import { captureStage, type CaptureResult } from "@/lib/ask/capture";
import { createCancelHold } from "@/lib/ask/cancel-hold";
import { shouldRetroCancel } from "@/lib/ask/retro-cancel";
import { yieldMacrotask } from "@/lib/ask/yield-macrotask";
import { usePointerActivate } from "@/lib/ask/use-pointer-activate";
import { collectAskCandidates, summarizeSelection } from "@/lib/ask/collect-candidates";
import { getAskCodeMissNotice, subscribeAskCodeMissNotice } from "@/lib/ask/code-editor-registry";
import {
  ASK_CAPTURE_FALLBACK,
  ASK_CHIPS,
  ASK_SHORTCUT_STEP,
  ASK_SHORTCUT_SUBTITLE,
  ASK_SHORTCUT_VIZ,
  ASK_WAITING_STATUS,
} from "@/lib/ask/ask-ui-text";
import { AskStatusRow } from "@/components/board/ask-status-row";
import { ASK_LIMITS, type AskSelectionSummary, type AskTarget } from "@/lib/ask/types";
import { usePlayerStore } from "@/lib/player/store";

const PANEL_PHASES = new Set(["drafting", "sending", "streaming", "error"]);
const DESKTOP_QUERY = "(min-width: 1024px)";
const PANEL_WIDTH = 320;
const GAP = 8;
const STATUS_INTERVAL_MS = 10_000;

const SHORTCUTS = [
  { key: "subtitle", label: ASK_SHORTCUT_SUBTITLE },
  { key: "step", label: ASK_SHORTCUT_STEP },
  { key: "viz", label: ASK_SHORTCUT_VIZ },
] as const;

type ShortcutKey = (typeof SHORTCUTS)[number]["key"];

const ACTION_LABEL: Record<Exclude<AskErrorAction, "none">, string> = {
  retry: "重新问",
  settings: "去设置",
  refresh: "刷新",
  edit: "修改问题",
  home: "重新打开题目",
};

export interface AskPanelProps {
  /** 截图与点选捷径用的 stage。缺省时查 [data-ask-stage]。 */
  stage?: HTMLElement | null;
}

function resolveStage(stage: HTMLElement | null | undefined): HTMLElement | null {
  if (stage) return stage;
  if (typeof document === "undefined") return null;
  return document.querySelector<HTMLElement>("[data-ask-stage]");
}

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

function findByAskId(host: HTMLElement, id: string): HTMLElement | null {
  for (const el of host.querySelectorAll<HTMLElement>("[data-ask-id]")) {
    if (el.getAttribute("data-ask-id") !== id) continue;
    if (el.closest("[data-ask-exclude]") !== null) continue;
    return el;
  }
  return null;
}

function selectionFromShortcut(host: HTMLElement, stepId: string, key: ShortcutKey): AskSelectionSummary | null {
  const el = findByAskId(host, `${key}:${stepId}`);
  if (!el) return null;
  const id = el.getAttribute("data-ask-id") || `${key}:${stepId}`;
  const match = collectAskCandidates(host).find((candidate) => candidate.target.id === id);
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

function clampQuestion(value: string): string {
  return value.length > ASK_LIMITS.questionMax ? value.slice(0, ASK_LIMITS.questionMax) : value;
}

/**
 * Probe mark. Call after the cancelled or idle state is committed, in the
 * same turn as that setState. React 19 flushes the update before the task
 * yields, so the next animation frame is the paint of that state.
 * That frame's time minus the 取消 release is cancelPaintAfterReleaseMs.
 * No timer, settle, or hold wait sits between the commit and this frame.
 * No-op unless the timing probe is installed.
 */
export function noteCancelPaintAfterRelease(): void {
  if (!isAskTimingEnabled()) return;
  const raf = globalThis.requestAnimationFrame;
  const stamp = () => {
    markAskTiming("cancelPaintAt");
    noteCancelPaint();
  };
  if (typeof raf !== "function") {
    stamp();
    return;
  }
  raf(() => {
    stamp();
  });
}

/**
 * Two animation frames so setPreparing(true) paints the busy 取消 row and
 * the button is pressable before captureStage stalls the main thread.
 * When requestAnimationFrame is missing, one macrotask stands in for both.
 */
export function yieldPaintFrames(): Promise<void> {
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

function errorView(code: string | null) {
  if (code && ASK_ERROR_SPECS[code]) return ASK_ERROR_SPECS[code];
  return resolveAskError(code ? { code } : { code: "UPSTREAM_ERROR" });
}

function elapsedSeconds(startedAt: number | null, now: number): number {
  if (startedAt == null) return 0;
  return Math.max(0, Math.floor((now - startedAt) / 1000));
}

/** 回答流出或播放时不再挂草稿面板，只把没截到图的说明留在舞台上。 */
function CaptureFallbackNotice() {
  return (
    <p
      data-ask-capture-fallback
      className="pointer-events-none absolute top-2 right-2 z-40 max-w-xs rounded-md border border-board-600 bg-board-900/95 px-2 py-1 text-[11px] text-chalk-500 shadow-lg"
    >
      {ASK_CAPTURE_FALLBACK}
    </p>
  );
}

export default function AskPanel({ stage }: AskPanelProps) {
  const askPhase = usePlayerStore((s) => s.askPhase);
  const captureFailed = usePlayerStore((s) => s.askCaptureFallback);
  // playing / done 不挂草稿面板：选区已被清空，再挂会显示「已选：无」。
  // streaming 还留着选区，面板要留到 start 之后、result 之前（Esc 仍不关它）。
  // 截图失败提示从回答文字出现留到下一次提问，或仍在圈选时退出。不跟 phase 一起卸。
  if (askPhase === "playing" || askPhase === "done") {
    if (!captureFailed) return null;
    return <CaptureFallbackNotice />;
  }
  if (!PANEL_PHASES.has(askPhase)) return null;
  return <AskPanelActive stage={stage} />;
}

function AskPanelActive({ stage }: AskPanelProps) {
  const askPhase = usePlayerStore((s) => s.askPhase);
  const selection = usePlayerStore((s) => s.selection);
  const draftQuestion = usePlayerStore((s) => s.draftQuestion);
  const askErrorCode = usePlayerStore((s) => s.askErrorCode);
  const askStartedAt = usePlayerStore((s) => s.askStartedAt);
  const captureFailed = usePlayerStore((s) => s.askCaptureFallback);
  const currentIndex = usePlayerStore((s) => s.currentIndex);
  const steps = usePlayerStore((s) => s.steps);
  const setAskQuestion = usePlayerStore((s) => s.setAskQuestion);
  const setAskSelection = usePlayerStore((s) => s.setAskSelection);
  const closeAskPanel = usePlayerStore((s) => s.closeAskPanel);

  const labelId = useId();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [preparing, setPreparing] = useState(false);
  const [desktop, setDesktop] = useState(false);
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null);
  const [drawerBottom, setDrawerBottom] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const sendingRef = useRef(false);
  const notice = useSyncExternalStore(subscribeAskCodeMissNotice, getAskCodeMissNotice, () => null);
  /** Bumps on panel open and close. A submit that outlives the panel must not send. */
  const askSessionRef = useRef(0);
  const holdRef = useRef(createCancelHold());
  const holdWaitingRef = useRef(false);
  /** Sessions whose ask fetch has already been issued. */
  const sentSessionsRef = useRef(new Set<number>());
  /**
   * The capture-phase listener saw a primary pointerdown whose target is
   * inside [data-ask-cancel]. This flag is the cancel decision. The event
   * timeStamp is logged and is not compared to sentAt.
   */
  const cancelHitRef = useRef(false);
  /** pointerId of that press, so a later press does not replace the hit. */
  const pointerDownIdRef = useRef<number | null>(null);
  /** Removes the early pointerdown listener once the press has released. */
  const stopEarlyPressRef = useRef<(() => void) | null>(null);
  /**
   * Aborts captureStage between domToCanvas and encode. Armed only while
   * capture is running, so a press that lands after the fetch does not
   * abort a controller nobody is listening to.
   */
  const captureAbortRef = useRef<AbortController | null>(null);
  /**
   * A release that is still on 取消 while capture is running. A slide-off
   * does not set it. The post-capture yield reads it, because that release
   * can happen before captureStage is awaiting the signal.
   */
  const releasedOnCancelRef = useRef(false);
  const heldAfterSendRef = useRef(false);
  const [holdPressed, setHoldPressed] = useState(false);
  const [heldAfterSend, setHeldAfterSend] = useState(false);

  const markHeldAfterSend = useCallback((value: boolean) => {
    heldAfterSendRef.current = value;
    setHeldAfterSend(value);
  }, []);

  const clearHeldAfterSendOffButton = useCallback(() => {
    if (!heldAfterSendRef.current) return;
    markHeldAfterSend(false);
  }, [markHeldAfterSend]);

  const stopEarlyPress = useCallback(() => {
    stopEarlyPressRef.current?.();
    stopEarlyPressRef.current = null;
  }, []);

  const retroCancel = useCallback((releasedOnButton: boolean) => {
    const hit = cancelHitRef.current;
    const session = askSessionRef.current;
    const sent = sentSessionsRef.current.has(session);
    cancelHitRef.current = false;
    pointerDownIdRef.current = null;
    stopEarlyPress();
    if (!shouldRetroCancel(hit, sent, releasedOnButton)) return;
    sentSessionsRef.current.delete(session);
    retroCancelAsk();
  }, [stopEarlyPress]);

  useEffect(() => {
    askSessionRef.current += 1;
    return () => {
      askSessionRef.current += 1;
    };
  }, []);

  useEffect(() => {
    const hold = holdRef.current;
    return () => {
      markAskTiming("cancelUnmountAt");
      hold.reset();
    };
  }, []);

  const stepId = steps[currentIndex]?.id ?? "";
  const waiting = askPhase === "sending" || askPhase === "streaming";
  const showWaiting = waiting && !heldAfterSend;
  const errored = askPhase === "error";
  const drafting = askPhase === "drafting";
  const trimmedEmpty = draftQuestion.trim().length === 0;
  const submitLocked = trimmedEmpty || waiting || preparing;
  const count = draftQuestion.length;
  const view = errored ? errorView(askErrorCode) : null;
  const label = selection ? summarizeSelection(selection) : "已选：无";
  const host = resolveStage(stage);
  const shortcuts = SHORTCUTS.filter((item) => item.key !== "viz" || (host ? stageHasViz(host, stepId) : false));

  const place = useCallback(() => {
    const wide = typeof window !== "undefined" && window.matchMedia(DESKTOP_QUERY).matches;
    setDesktop(wide);
    const hostEl = resolveStage(stage);
    if (!wide) {
      const viewport = window.visualViewport;
      const drawerBottomOffset = viewport
        ? Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop)
        : 0;
      setDrawerBottom(drawerBottomOffset);
      setAnchor(null);
      const box = selection?.bbox;
      if (hostEl && box && box.width > 0 && box.height > 0) {
        const marker = hostEl.querySelector<HTMLElement>("[data-ask-selection]") ?? hostEl;
        const panelHeight = panelRef.current?.getBoundingClientRect().height ?? 0;
        const availableHeight = window.innerHeight - panelHeight - drawerBottomOffset;
        const markerHeight = marker.getBoundingClientRect().height;
        const block = chooseAskScrollBlock(markerHeight, availableHeight);
        const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        marker.scrollIntoView?.(reduced ? { block, behavior: "auto" } : { block });
      }
      return;
    }
    setDrawerBottom(0);
    if (!hostEl || !selection) {
      setAnchor({ top: GAP, left: GAP });
      return;
    }
    const box = selection.bbox;
    const stageWidth = hostEl.clientWidth || window.innerWidth;
    const roomRight = stageWidth - (box.x + box.width) - GAP;
    const left = roomRight >= PANEL_WIDTH ? box.x + box.width + GAP : box.x;
    const top = roomRight >= PANEL_WIDTH ? box.y : box.y + box.height + GAP;
    setAnchor({ top: Math.max(0, top), left: Math.max(0, left) });
  }, [stage, selection]);

  useEffect(() => {
    place();
    const mq = window.matchMedia(DESKTOP_QUERY);
    const onChange = () => place();
    mq.addEventListener("change", onChange);
    window.addEventListener("resize", onChange);
    window.visualViewport?.addEventListener("resize", onChange);
    window.visualViewport?.addEventListener("scroll", onChange);
    return () => {
      mq.removeEventListener("change", onChange);
      window.removeEventListener("resize", onChange);
      window.visualViewport?.removeEventListener("resize", onChange);
      window.visualViewport?.removeEventListener("scroll", onChange);
    };
  }, [place]);

  // 有选区进入 drafting 时焦点进输入框（§7）。
  useEffect(() => {
    if (!drafting) return;
    textareaRef.current?.focus({ preventScroll: true });
  }, [drafting]);

  useEffect(() => {
    if (!showWaiting) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [showWaiting, askStartedAt]);

  // 等待文案每 10 秒写入页面已有的唯一 role=status，不新建第二个。
  useEffect(() => {
    if (!showWaiting) return;
    const write = () => {
      const status = document.querySelector("[role=status]");
      if (!status) return;
      const seconds = elapsedSeconds(usePlayerStore.getState().askStartedAt, Date.now());
      status.textContent = ASK_WAITING_STATUS(seconds);
    };
    write();
    const timer = window.setInterval(write, STATUS_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [showWaiting, askStartedAt]);

  const submit = useCallback(async () => {
    markAskTiming("submitAt");
    if (sendingRef.current) return;
    const state = usePlayerStore.getState();
    if (state.askPhase !== "drafting" && state.askPhase !== "error") return;
    if (state.draftQuestion.trim().length === 0) return;
    const startStepId = state.steps[state.currentIndex]?.id ?? "";
    const startSelection = state.selection;
    if (!startSelection) return;
    const session = askSessionRef.current;
    sendingRef.current = true;
    holdRef.current.reset();
    cancelHitRef.current = false;
    releasedOnCancelRef.current = false;
    pointerDownIdRef.current = null;
    // 新的一次截图开始：上一轮「没截到图」先清掉，这次失败再写回。
    usePlayerStore.setState({ askCaptureFallback: false });
    setPreparing(true);
    // Record a 取消 press from before capture starts. The button's own
    // listener is attached on the next commit, which is after a press that
    // lands as the stall ends. This listener only sets the cancel-hit flag
    // and the pointerId. It never presses the hold, captures the pointer,
    // or releases. The button's own handlers still do that.
    // It stays up through the fetch: a press that lands after the fetch
    // still has to abort on release, with no answer left behind.
    stopEarlyPress();
    // A press that lands during domToCanvas aborts capture before encode.
    const captureAbort = new AbortController();
    captureAbortRef.current = captureAbort;
    const stopCancelPress = listenCancelPress(document, {
      onDown: (event) => {
        if (event.button !== 0) return;
        if (askSessionRef.current !== session) return;
        if (!sendingRef.current) return;
        // Keep the first press of this gesture. A later pointerdown must not
        // replace the hit the cancel decision uses.
        if (pointerDownIdRef.current != null) return;
        pointerDownIdRef.current = event.pointerId;
        cancelHitRef.current = true;
        // Logs only. CDP stamps timeStamp when the renderer dequeues the
        // event, so it is not compared with sentAt.
        markAskPointerDown(event.timeStamp);
      },
    });
    stopEarlyPressRef.current = stopCancelPress;
    try {
      // Paint the busy 取消 row before captureStage stalls the main thread,
      // so a press during the stall has a live button to hit.
      // A/B noDoubleRaf skips the two frames and captures in this turn.
      if (!askAb("noDoubleRaf")) await yieldPaintFrames();
      // One macrotask after domToCanvas returns and before encode or fetch.
      // captureStage calls beforeEncode at that point and awaits it, so this
      // is the only yield: it replaces the earlier 50ms settle and the extra
      // yield rounds. The macrotask is started after the long task, so a
      // pointerdown queued during it is dispatched and sets the hit flag
      // before encode. scheduler.yield when it exists, otherwise setTimeout(0).
      // A/B noSettle skips it.
      let yieldStarted = 0;
      const beforeEncode = askAb("noSettle")
        ? undefined
        : () => {
            yieldStarted = performance.now();
            return yieldMacrotask();
          };
      let capture: CaptureResult | null;
      try {
        // captureStage calls beforeEncode after domToCanvas and awaits it
        // before encode, so this is the only yield. It replaces the earlier
        // 50ms settle and the extra yield rounds. A/B noSettle omits it.
        capture = await captureStage(resolveStage(stage), startSelection, {
          signal: captureAbort.signal,
          beforeEncode,
        });
      } catch {
        capture = null;
      } finally {
        captureAbortRef.current = null;
      }
      if (askAb("noSettle") || yieldStarted === 0) {
        markAskPhase("settleMs", 0);
      } else {
        markAskPhase("settleMs", performance.now() - yieldStarted);
      }
      // A release that stayed on 取消 during the long task resolved the
      // hold as cancel before this yield returned. A mock capture ignores
      // the signal, so the latch is the decision here too. A slide-off
      // latches send. A press that is still down is not a decision yet:
      // the hold wait below cancels on release, sends on slide-off, and
      // sends after 2s while the press stays down.
      const cancelledBeforeEncode =
        releasedOnCancelRef.current ||
        captureAbort.signal.aborted ||
        holdRef.current.latched(session) === "cancel";
      if (cancelledBeforeEncode && (capture == null || capture.ok)) {
        capture = { ok: false, reason: "ABORTED", fallbackText: "" };
      }
      holdWaitingRef.current = true;
      const holdResult = await holdRef.current.wait(session, 2000);
      holdWaitingRef.current = false;
      if (holdResult === "cancel" || (capture?.ok === false && capture.reason === "ABORTED")) {
        setPreparing(false);
        usePlayerStore.getState().closeAskPanel();
        // The panel unmounts on this path, so the paint mark cannot wait
        // for an effect. React flushes this commit before the task yields;
        // the next frame, and only that frame, is the paint mark. The
        // yield and the hold wait have already resolved by here.
        noteCancelPaintAfterRelease();
        sendingRef.current = false;
        return;
      }
      if (holdResult === "send-held") {
        markHeldAfterSend(true);
        // The 2s timeout already sent. Releasing on the button aborts that
        // ask: drop the request, the streamed text, and the panel. A slide
        // off does not (leave() clears the hold without onLateCancel).
        holdRef.current.onLateCancel(() => {
          markHeldAfterSend(false);
          setHoldPressed(false);
          retroCancelAsk();
        });
      }
      setPreparing(false);
      const latest = usePlayerStore.getState();
      const latestStepId = latest.steps[latest.currentIndex]?.id ?? "";
      if (latestStepId !== startStepId || latest.selection !== startSelection) {
        sendingRef.current = false;
        return;
      }
      const failed = !capture || capture.ok === false;
      // 记在 store 上：sendAsk 把 phase 推进后本组件不再靠本地 state 记住这次失败。
      usePlayerStore.setState({ askCaptureFallback: failed });
      try {
        await sendAsk(failed ? null : capture, {
          isCurrent: () => {
            // A press on 取消 that landed before this check aborts with no
            // fetch. The button's release still closes the panel.
            if (cancelHitRef.current && !sentSessionsRef.current.has(session)) return false;
            return askSessionRef.current === session;
          },
          onFetch: (_sentAt) => {
            // The clock is a log mark inside sendAsk. The cancel decision is
            // the hit flag, which does not compare it.
            sentSessionsRef.current.add(session);
          },
        });
      } finally {
        sendingRef.current = false;
        // A press is still down. Leave the listener until that pointer releases
        // so the hit can still abort the ask that just went out.
        if (pointerDownIdRef.current == null) stopEarlyPress();
      }
    } finally {
      // Capture threw before the fetch. Nothing is in flight.
      if (sendingRef.current) stopEarlyPress();
    }
  }, [stage, markHeldAfterSend, stopEarlyPress]);

  const onQuestionChange = (value: string) => {
    setAskQuestion(clampQuestion(value));
  };

  const onTextKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      event.stopPropagation();
      void submit();
    }
  };

  const pickShortcut = (key: ShortcutKey) => {
    const hostEl = resolveStage(stage);
    if (!hostEl || !stepId) return;
    const next = selectionFromShortcut(hostEl, stepId, key);
    if (!next) return;
    setAskSelection(next);
  };

  const runAction = (action: AskErrorAction) => {
    if (action === "retry") {
      void submit();
      return;
    }
    if (action === "refresh") {
      window.location.reload();
      return;
    }
    if (action === "edit") {
      textareaRef.current?.focus({ preventScroll: true });
    }
  };

  const cancelWaiting = usePointerActivate(() => {
    if (holdWaitingRef.current || heldAfterSendRef.current) return;
    cancelAsk();
  });
  const cancelDraft = usePointerActivate(() => {
    if (holdWaitingRef.current || heldAfterSendRef.current) return;
    closeAskPanel();
  });

  const bindCancelHold = (
    activate: {
      onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void;
      onPointerMove: (event: ReactPointerEvent<HTMLButtonElement>) => void;
      onPointerUp: (event: ReactPointerEvent<HTMLButtonElement>) => void;
      onPointerCancel: (event: ReactPointerEvent<HTMLButtonElement>) => void;
    },
  ) => ({
    onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.button === 0) {
        // The early document listener may already have recorded this press.
        // Keep that hit: it is the one the cancel decision uses.
        // A press the early listener missed (target outside the button) still
        // records here, which is the pre-aa122ae path.
        if (pointerDownIdRef.current !== event.pointerId) {
          cancelHitRef.current = true;
          pointerDownIdRef.current = event.pointerId;
        }
        markAskPointerDown(event.timeStamp);
      }
      if (event.button === 0 && sendingRef.current) {
        holdRef.current.press(askSessionRef.current);
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          // Capture can fail if the pointer is already gone.
        }
        setHoldPressed(true);
      }
      activate.onPointerDown(event);
    },
    onPointerMove: (event: ReactPointerEvent<HTMLButtonElement>) => {
      const box = event.currentTarget.getBoundingClientRect();
      const inside =
        event.clientX >= box.left &&
        event.clientX <= box.right &&
        event.clientY >= box.top &&
        event.clientY <= box.bottom;
      if (!inside) {
        holdRef.current.leave();
        setHoldPressed(false);
        clearHeldAfterSendOffButton();
        // The gesture left the button. A later release is not a cancel,
        // and the early listener no longer has a press to remember.
        cancelHitRef.current = false;
        releasedOnCancelRef.current = false;
        if (!holdRef.current.isPending(askSessionRef.current)) stopEarlyPress();
      }
      activate.onPointerMove(event);
    },
    onPointerUp: (event: ReactPointerEvent<HTMLButtonElement>) => {
      const box = event.currentTarget.getBoundingClientRect();
      const inside =
        event.clientX >= box.left &&
        event.clientX <= box.right &&
        event.clientY >= box.top &&
        event.clientY <= box.bottom;
      // An in-submit hold owns the release. The button action would unmount
      // the panel and reset the hold before wait() can see the cancel.
      // send-held is the 2s timeout: release on the button aborts once, in
      // onLateCancel. Calling retroCancel here as well would abort twice.
      const held = holdRef.current.isPending(askSessionRef.current);
      const sentWhileHeld = heldAfterSendRef.current;
      // Both clocks. event.timeStamp is when the pointer went up. The
      // handler's performance.now() is when the event was dispatched. They
      // match when the main thread was free. When the release was queued
      // during the capture long task, timeStamp is inside that task and
      // dispatch is when the thread became free. The paint delta uses the
      // later of the two, so the queued stall is not charged to the paint.
      if (inside && sendingRef.current) {
        markAskTiming("cancelPointerUpAt", event.timeStamp);
        markAskTiming("cancelPointerUpDispatchAt");
      }
      holdRef.current.release(inside);
      setHoldPressed(false);
      if (!inside) clearHeldAfterSendOffButton();
      // A release that is still on 取消, while capture has not encoded yet,
      // aborts that capture. A slide-off has already cleared the hit, so it
      // encodes and sends. A release after the fetch uses retroCancel.
      if (inside) {
        releasedOnCancelRef.current = true;
        captureAbortRef.current?.abort();
      }
      if (!sentWhileHeld) retroCancel(inside);
      if ((held || sentWhileHeld) && inside) return;
      activate.onPointerUp(event);
    },
    onPointerCancel: (event: ReactPointerEvent<HTMLButtonElement>) => {
      cancelHitRef.current = false;
      releasedOnCancelRef.current = false;
      pointerDownIdRef.current = null;
      stopEarlyPress();
      holdRef.current.pointerCancel();
      setHoldPressed(false);
      clearHeldAfterSendOffButton();
      activate.onPointerCancel(event);
    },
  });

  const cancelWaitingHold = bindCancelHold(cancelWaiting);
  const cancelDraftHold = bindCancelHold(cancelDraft);

  useEffect(() => {
    if (!heldAfterSend) return;
    if (askPhase === "sending" || askPhase === "streaming") return;
    if (holdRef.current.isPending(askSessionRef.current)) return;
    markHeldAfterSend(false);
  }, [heldAfterSend, askPhase, markHeldAfterSend]);

  const seconds = elapsedSeconds(askStartedAt, now);
  const cancelPressed = holdPressed || heldAfterSend;
  const cancelClassName = `pointer-coarse:min-h-11 pointer-coarse:min-w-11 rounded-md border border-board-600 px-3 py-1${
    cancelPressed ? " bg-board-700" : ""
  }`;
  const positionClass = desktop ? "absolute z-40 w-80" : "fixed inset-x-0 z-40 max-h-[50vh] overflow-y-auto";

  return (
    <div
      ref={panelRef}
      data-ask-panel
      role="dialog"
      aria-modal="false"
      aria-labelledby={labelId}
      className={`${positionClass} flex flex-col gap-2 rounded-xl border border-board-600 bg-board-900/95 p-3 text-sm text-chalk-100 shadow-lg`}
      style={desktop ? { top: anchor?.top ?? GAP, left: anchor?.left ?? GAP, width: PANEL_WIDTH } : { bottom: drawerBottom }}
    >
      <div role="group" aria-label="点选捷径" className="flex flex-wrap gap-1">
        {shortcuts.map((item) => (
          <button
            key={item.key}
            type="button"
            data-ask-shortcut={item.key}
            className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 rounded-full border border-board-600 px-2 py-0.5 text-[10px] text-chalk-100"
            onClick={() => pickShortcut(item.key)}
          >
            {item.label}
          </button>
        ))}
      </div>

      {notice ? (
        <p data-testid="ask-code-miss-hint" className="text-xs text-chalk-500">
          {notice}
        </p>
      ) : null}

      <p id={labelId} data-ask-panel-label className="text-xs text-beam-gold">
        {label}
      </p>

      <AskStatusRow
        state={preparing || heldAfterSend ? "preparing" : showWaiting ? "waiting" : "idle"}
        seconds={seconds}
      />

      {captureFailed ? (
        <p data-ask-capture-fallback className="text-[11px] text-chalk-500">
          {ASK_CAPTURE_FALLBACK}
        </p>
      ) : null}

      {view ? (
        <p role="alert" data-ask-error={view.code}>
          {view.message}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-1">
        {ASK_CHIPS.map((chip) => (
          <button
            key={chip}
            type="button"
            data-ask-chip={chip}
            className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 rounded-full border border-board-600 px-2 py-1 text-xs text-chalk-100"
            onClick={() => onQuestionChange(chip)}
          >
            {chip}
          </button>
        ))}
      </div>

      <textarea
        ref={textareaRef}
        data-ask-question
        value={draftQuestion}
        maxLength={ASK_LIMITS.questionMax}
        rows={3}
        className="w-full resize-y rounded-md border border-board-600 bg-board-950 px-2 py-1 text-sm text-chalk-100"
        onChange={(event) => onQuestionChange(event.target.value)}
        onKeyDown={onTextKeyDown}
      />
      <p
        data-ask-count
        className={`text-right text-[11px] tabular-nums ${count >= 280 ? "text-warning text-amber-400" : "text-chalk-500"}`}
      >
        {`${count}/${ASK_LIMITS.questionMax}`}
      </p>

      <div className={`flex gap-2 ${desktop ? "" : "[&>button]:w-1/2 [&>a]:w-1/2"}`}>
        {waiting ? (
          <button
            type="button"
            data-ask-cancel
            data-ask-capture-exclude
            data-pressed={cancelPressed ? "" : undefined}
            className={cancelClassName}
            onPointerDown={cancelWaitingHold.onPointerDown}
            onPointerMove={cancelWaitingHold.onPointerMove}
            onPointerUp={cancelWaitingHold.onPointerUp}
            onPointerCancel={cancelWaitingHold.onPointerCancel}
            onClick={cancelWaiting.onClick}
          >
            取消
          </button>
        ) : (
          <button
            type="button"
            data-ask-cancel
            data-ask-capture-exclude
            data-pressed={cancelPressed ? "" : undefined}
            className={cancelClassName}
            onPointerDown={cancelDraftHold.onPointerDown}
            onPointerMove={cancelDraftHold.onPointerMove}
            onPointerUp={cancelDraftHold.onPointerUp}
            onPointerCancel={cancelDraftHold.onPointerCancel}
            onClick={cancelDraft.onClick}
          >
            取消
          </button>
        )}

        {view && view.action !== "none" && view.action !== "retry" ? (
          <ErrorAction action={view.action} onRun={runAction} />
        ) : (
          <button
            type="button"
            data-ask-submit
            aria-disabled={submitLocked ? true : undefined}
            className={`pointer-coarse:min-h-11 pointer-coarse:min-w-11 rounded-md bg-beam-gold px-3 py-1 text-on-accent${
              submitLocked ? " opacity-50 cursor-not-allowed" : ""
            }`}
            onClick={() => {
              if (submitLocked) return;
              void submit();
            }}
          >
            {view?.action === "retry" ? ACTION_LABEL.retry : "提问"}
          </button>
        )}
      </div>
    </div>
  );
}

function ErrorAction({
  action,
  onRun,
}: {
  action: Exclude<AskErrorAction, "none" | "retry">;
  onRun: (action: AskErrorAction) => void;
}) {
  const label = ACTION_LABEL[action];
  const className =
    "pointer-coarse:min-h-11 pointer-coarse:min-w-11 rounded-md bg-beam-gold px-3 py-1 text-center text-on-accent";
  if (action === "settings") {
    return (
      <Link href="/settings" data-ask-error-action={action} className={className}>
        {label}
      </Link>
    );
  }
  if (action === "home") {
    return (
      <Link href="/" data-ask-error-action={action} className={className}>
        {label}
      </Link>
    );
  }
  return (
    <button type="button" data-ask-error-action={action} className={className} onClick={() => onRun(action)}>
      {label}
    </button>
  );
}
