/**
 * AskEntry · 字幕卡标题行右侧的「圈选提问」入口。
 * 置灰原因来自 selectAskAvailability，文案来自 ask-ui-text。
 * pending 不置灰：点击记下意图并立刻转圈，落定后进圈选或显示原因；超过 3 秒取消意图。
 */
"use client";

import { useEffect, useRef, useState, type MouseEvent } from "react";
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
  const exitAsk = usePlayerStore((s) => s.exitAsk);
  const reduced = usePrefersReducedMotion();

  const [awaitingPending, setAwaitingPending] = useState(false);
  const [pendingTimedOut, setPendingTimedOut] = useState(false);

  const inAsk = IN_ASK.has(askPhase);
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
      exitAsk();
      return;
    }
    activate();
  }

  return (
    <span className="inline-flex flex-col items-end gap-0.5">
      <button
        type="button"
        data-ask-entry
        aria-disabled={grey ? true : undefined}
        aria-pressed={inAsk ? true : undefined}
        aria-busy={awaitingPending ? true : undefined}
        aria-describedby={describedBy}
        aria-keyshortcuts={inAsk ? "Escape" : "Q"}
        data-ask-disabled-reason={reason ?? (showTimeout ? "pendingTimeout" : undefined)}
        className={`inline-flex items-center justify-center gap-1 rounded-full border border-board-600 px-2 py-0.5 font-mono text-[10px] tracking-wide text-chalk-300 pointer-coarse:min-h-11 pointer-coarse:min-w-11 whitespace-nowrap ${
          grey ? GREY_CLASS : ""
        }${inAsk ? " min-h-11 min-w-11 pointer-fine:-my-3" : ""}`}
        onClick={onClick}
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
        <span>{inAsk ? ASK_EXIT_LABEL : ASK_ENTRY_LABEL}</span>
        <kbd
          data-ask-kbd
          className="max-[391px]:hidden rounded border border-board-600 px-1 font-mono text-[9px] leading-none text-chalk-500"
          aria-hidden
        >
          {inAsk ? "Esc" : "Q"}
        </kbd>
        {awaitingPending ? <span className="sr-only">{ASK_PENDING_PREPARING_SR}</span> : null}
      </button>
      {reason ? (
        <span id={REASON_ID} role="note" className="text-[10px] text-chalk-500">
          {ASK_REASON_TEXT[reason]}
        </span>
      ) : null}
      {showTimeout ? (
        <span id={TIMEOUT_ID} role="note" className="text-[10px] text-chalk-500">
          {ASK_PENDING_TIMEOUT}
        </span>
      ) : null}
    </span>
  );
}
