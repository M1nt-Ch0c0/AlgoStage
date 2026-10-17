/**
 * AskEntry · 字幕卡标题行右侧的「圈选提问」入口。
 * 置灰原因来自 selectAskAvailability，文案来自 ask-ui-text。
 * pending 不置灰：点击记下意图并立刻转圈，落定后进圈选或显示原因；超过 3 秒取消意图。
 */
"use client";

import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent } from "react";
import { CircleDashed, Loader2 } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import {
  ASK_ENTRY_LABEL,
  ASK_EXIT_LABEL,
  ASK_PENDING_PREPARING_SR,
  ASK_PENDING_TIMEOUT,
  ASK_REASON_TEXT,
} from "@/lib/ask/ask-ui-text";
import { isTypingTarget } from "@/lib/player/keyboard";
import {
  selectAskAvailability,
  usePlayerStore,
  type AskDisabledReason,
} from "@/lib/player/store";
import { usePrefersReducedMotion } from "@/components/effects/fx-context";
import { isAskCancelGhostActive } from "@/lib/ask/ask-cancel";
import { exitAskAndFocusEntry } from "./ask-selection-layer";
import { useIsMobile } from "./use-is-mobile";

const PENDING_TIMEOUT_MS = 3000;
const REASON_ID = "ask-entry-reason";
const TIMEOUT_ID = "ask-entry-timeout";

/** 所有置灰原因共用同一套灰色，不按原因换样式。 */
const GREY_CLASS = "opacity-50 text-chalk-500";

const IN_ASK = new Set(["selecting", "drafting", "error"]);
/** Phases that already left idle. Returning to selecting from these must not focus the bar exit. */
const ASK_RESUME = new Set(["sending", "streaming", "drafting", "error"]);

export default function AskEntry() {
  const availability = usePlayerStore(useShallow(selectAskAvailability));
  const askPhase = usePlayerStore((s) => s.askPhase);
  const pendingEnterIntent = usePlayerStore((s) => s.pendingEnterIntent);
  const storageMode = usePlayerStore((s) => s.answerMeta.storageMode);
  const requestEnterAsk = usePlayerStore((s) => s.requestEnterAsk);
  const enterAsk = usePlayerStore((s) => s.enterAsk);
  const reduced = usePrefersReducedMotion();
  const isMobile = useIsMobile();

  const [awaitingPending, setAwaitingPending] = useState(false);
  const [pendingTimedOut, setPendingTimedOut] = useState(false);

  const inAsk = IN_ASK.has(askPhase);
  const hideAtMobileAsk = inAsk && isMobile;
  const pendingIdle = storageMode === "pending" && !inAsk;

  // 意图被换步 / 落定 / 取消清掉后，停掉本地等待。成功进圈选则不显示原因。
  useEffect(() => {
    if (pendingEnterIntent != null) return;
    setAwaitingPending(false);
    if (askPhase === "selecting" || askPhase === "drafting") {
      setPendingTimedOut(false);
    }
  }, [pendingEnterIntent, askPhase]);

  // 超过 3 秒仍是 pending 意图：取消意图，显示超时文案，不进圈选。
  useEffect(() => {
    if (!awaitingPending || pendingEnterIntent == null) return;
    const timer = setTimeout(() => {
      if (usePlayerStore.getState().pendingEnterIntent == null) return;
      usePlayerStore.setState({ pendingEnterIntent: null });
      setAwaitingPending(false);
      setPendingTimedOut(true);
    }, PENDING_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [awaitingPending, pendingEnterIntent]);

  const prevAskPhaseRef = useRef(askPhase);
  useEffect(() => {
    const prev = prevAskPhaseRef.current;
    prevAskPhaseRef.current = askPhase;
    if (IN_ASK.has(prev) && askPhase === "idle") {
      const schedule = () => {
        const btn = document.querySelector<HTMLElement>("[data-ask-entry]");
        btn?.focus({ preventScroll: true });
      };
      if (typeof requestAnimationFrame !== "undefined") {
        requestAnimationFrame(schedule);
      }
      setTimeout(schedule, 0);
    }
  }, [askPhase]);

  // 仅从 idle 进入圈选时，把焦点移到底部条退出按钮。
  // sending|streaming|drafting|error → selecting 时 hideAtMobileAsk 也会从 false 变 true
  // （IN_ASK 不含 sending），但那是取消后回到圈选，不能抢走开场芯片的焦点。
  const prevHidePhaseRef = useRef(askPhase);
  useEffect(() => {
    const prev = prevHidePhaseRef.current;
    prevHidePhaseRef.current = askPhase;
    if (!hideAtMobileAsk) return;
    if (ASK_RESUME.has(prev)) return;
    if (prev !== "idle") return;
    const schedule = () => {
      if (isAskCancelGhostActive()) return;
      const barExit = document.querySelector<HTMLElement>("[data-ask-bottom-bar] [data-ask-entry]");
      barExit?.focus({ preventScroll: true });
    };
    if (typeof requestAnimationFrame !== "undefined") {
      requestAnimationFrame(schedule);
    }
    setTimeout(schedule, 0);
  }, [hideAtMobileAsk, askPhase]);

  const reason: AskDisabledReason | null = pendingIdle ? null : availability.reason;

  function activate() {
    if (reason) {
      setPendingTimedOut(false);
      return;
    }
    if (awaitingPending) {
      if (pendingEnterIntent) usePlayerStore.setState({ pendingEnterIntent: null });
      setAwaitingPending(false);
      setPendingTimedOut(false);
      return;
    }
    setPendingTimedOut(false);
    if (storageMode === "pending") {
      requestEnterAsk();
      setAwaitingPending(true);
      return;
    }
    enterAsk();
  }

  const stateRef = useRef({
    visible: availability.visible,
    inAsk,
    activate,
  });
  stateRef.current = {
    visible: availability.visible,
    inAsk,
    activate,
  };

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.repeat || e.isComposing) return;
      if (e.key !== "q" && e.key !== "Q") return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      if (e.target instanceof Element && e.target.closest("[role=dialog]")) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      if (!stateRef.current.visible) return;
      if (stateRef.current.inAsk) return;
      e.preventDefault();
      stateRef.current.activate();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  if (!availability.visible) return null;

  const showTimeout = pendingTimedOut && !awaitingPending && !inAsk && reason == null;
  const describedBy = showTimeout ? TIMEOUT_ID : reason ? REASON_ID : undefined;
  const grey = reason != null;

  function onClick(event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    if (inAsk) {
      exitAskAndFocusEntry();
      return;
    }
    activate();
  }

  // 1280：芯片组在 DOM 里离入口很远。圈选中从入口按 Tab，第一下直接落到芯片组（roving 的那一个）。
  function onEntryKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (event.key !== "Tab" || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return;
    if (!inAsk || isMobile) return;
    const chip = document.querySelector<HTMLElement>('[data-ask-bottom-bar] [data-ask-shortcut][tabindex="0"]');
    if (!chip) return;
    event.preventDefault();
    chip.focus();
  }

  // Mobile Uma 390: after submit, busy notes must not paint chalk into the
  // closed-panel crop. Keep in-flow footprint (so step geometry stays in the
  // tip's post-busy regime) but paint invisible during sending|streaming|playing.
  const mobileBusy =
    isMobile && (askPhase === "sending" || askPhase === "streaming" || askPhase === "playing");
  const noteClass = mobileBusy
    ? "invisible pointer-events-none text-[10px] text-chalk-500"
    : "text-[10px] text-chalk-500";

  const iconSize = isMobile ? 22 : 20;

  return (
    <span className="inline-flex flex-col items-end gap-0.5">
      <button
        type="button"
        data-ask-entry={hideAtMobileAsk ? undefined : ""}
        aria-hidden={hideAtMobileAsk ? true : undefined}
        tabIndex={hideAtMobileAsk ? -1 : undefined}
        aria-disabled={grey ? true : undefined}
        aria-pressed={inAsk ? true : undefined}
        aria-busy={awaitingPending ? true : undefined}
        aria-describedby={describedBy}
        aria-keyshortcuts={inAsk ? "Escape" : "Q"}
        data-ask-disabled-reason={reason ?? (showTimeout ? "pendingTimeout" : undefined)}
        className={`relative z-40 inline-flex items-center justify-center gap-1.5 rounded-full border border-board-600 font-mono font-medium tracking-wide text-chalk-300 whitespace-nowrap h-10 min-h-11 min-w-11 px-3 text-[15px] max-sm:h-12 max-sm:min-h-12 max-sm:min-w-12 max-sm:text-base pointer-coarse:min-h-11 pointer-coarse:min-w-11 ${
          grey ? GREY_CLASS : ""
        }${hideAtMobileAsk ? " invisible pointer-events-none" : ""}`}
        onClick={onClick}
        onKeyDown={onEntryKeyDown}
      >
        {awaitingPending ? (
          reduced ? (
            <span className="inline-flex shrink-0 items-center justify-center text-sm" aria-hidden>
              …
            </span>
          ) : (
            <Loader2
              size={iconSize}
              className="animate-spin shrink-0"
              data-ask-pending-spinner
              data-ask-entry-icon
              aria-hidden
            />
          )
        ) : (
          <CircleDashed
            size={iconSize}
            className="shrink-0"
            data-ask-entry-icon
            aria-hidden
          />
        )}
        <span>{inAsk && !isMobile ? ASK_EXIT_LABEL : ASK_ENTRY_LABEL}</span>
        <kbd
          data-ask-kbd
          className="max-[391px]:hidden rounded border border-board-600 px-1.5 py-0.5 font-mono text-[10px] leading-none text-chalk-500"
          aria-hidden
        >
          {inAsk && !isMobile ? "Esc" : "Q"}
        </kbd>
        {awaitingPending ? <span className="sr-only">{ASK_PENDING_PREPARING_SR}</span> : null}
      </button>
      {reason ? (
        <span id={REASON_ID} role="note" className={noteClass}>
          {ASK_REASON_TEXT[reason]}
        </span>
      ) : null}
      {showTimeout ? (
        <span id={TIMEOUT_ID} role="note" className={noteClass}>
          {ASK_PENDING_TIMEOUT}
        </span>
      ) : null}
    </span>
  );
}
