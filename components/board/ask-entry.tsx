/**
 * AskEntry · 字幕卡标题行右侧的「圈选提问」入口。
 * 置灰原因来自 selectAskAvailability，文案来自 ask-ui-text。
 * pending 不置灰：点击记下意图并立刻转圈，落定后进圈选或显示原因；超过 3 秒取消意图。
 */
"use client";

import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent } from "react";
import { Loader2 } from "lucide-react";
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
import { exitAskAndFocusEntry } from "./ask-selection-layer";
import { useIsMobile } from "./use-is-mobile";

const PENDING_TIMEOUT_MS = 3000;
const REASON_ID = "ask-entry-reason";
const TIMEOUT_ID = "ask-entry-timeout";

/** 所有置灰原因共用同一套灰色，不按原因换样式。 */
const GREY_CLASS = "opacity-50 text-chalk-500";

const IN_ASK = new Set(["selecting", "drafting", "error"]);

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

  // 当在 390 移动端从入口按钮进入圈选时，将焦点转移到底部条退出按钮
  useEffect(() => {
    if (hideAtMobileAsk) {
      const schedule = () => {
        const barExit = document.querySelector<HTMLElement>("[data-ask-bottom-bar] [data-ask-entry]");
        barExit?.focus({ preventScroll: true });
      };
      if (typeof requestAnimationFrame !== "undefined") {
        requestAnimationFrame(schedule);
      }
      setTimeout(schedule, 0);
    }
  }, [hideAtMobileAsk]);

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

  // Mobile Uma 390: capture runs while askPhase is still drafting (entry hidden,
  // no busy note), then baseline is taken after sending|streaming|playing when
  // BUSY_PHASES mounts the busy note. An in-flow visible note grew the subtitle
  // (+17px) and painted chalk into the crop; absolute-above removed growth and
  // exposed lesson-plan board-900 in the crop that capture fills with stage bg
  // (0.65). Keep the note's in-flow footprint on mobile during ask + busy so
  // capture and baseline share geometry, but do not paint the chalk (invisible).
  const mobileBusy =
    isMobile && (askPhase === "sending" || askPhase === "streaming" || askPhase === "playing");
  const reserveMobileNoteSpace = isMobile && (hideAtMobileAsk || mobileBusy || reason != null || showTimeout);
  const hideMobileNotePaint = isMobile && (hideAtMobileAsk || mobileBusy);
  const noteClass = hideMobileNotePaint
    ? "invisible pointer-events-none text-[10px] leading-tight text-chalk-500"
    : "text-[10px] text-chalk-500";

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
        className={`relative z-40 inline-flex items-center justify-center gap-1 rounded-full border border-board-600 px-2 py-0.5 font-mono text-[10px] tracking-wide text-chalk-300 pointer-coarse:min-h-11 pointer-coarse:min-w-11 whitespace-nowrap ${
          grey ? GREY_CLASS : ""
        }${inAsk && !isMobile ? " min-h-11 min-w-11 pointer-fine:-my-3" : ""}${
          hideAtMobileAsk ? " invisible pointer-events-none" : ""
        }`}
        onClick={onClick}
        onKeyDown={onEntryKeyDown}
      >
        <span className="inline-flex h-3 w-3 shrink-0 items-center justify-center" aria-hidden>
          {awaitingPending ? (
            reduced ? (
              "…"
            ) : (
              <Loader2 size={12} className="animate-spin" data-ask-pending-spinner />
            )
          ) : null}
        </span>
        <span>{inAsk && !isMobile ? ASK_EXIT_LABEL : ASK_ENTRY_LABEL}</span>
        <kbd
          data-ask-kbd
          className="max-[391px]:hidden rounded border border-board-600 px-1 font-mono text-[9px] leading-none text-chalk-500"
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
      ) : showTimeout ? (
        <span id={TIMEOUT_ID} role="note" className={noteClass}>
          {ASK_PENDING_TIMEOUT}
        </span>
      ) : reserveMobileNoteSpace ? (
        <span className="invisible pointer-events-none text-[10px] leading-tight" aria-hidden>
          {ASK_REASON_TEXT.busy}
        </span>
      ) : null}
    </span>
  );
}
