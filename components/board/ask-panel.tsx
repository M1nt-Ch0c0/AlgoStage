/**
 * AskPanel · 提问面板。桌面（≥lg）绝对定位浮在选区右侧，放不下则放下方；
 * 窄屏固定底部抽屉，最高 50vh，bottom 跟 visualViewport 避开键盘。
 * 提问先 captureStage；stepId 或 selection 引用变了就丢弃。截图失败仍 sendAsk(null)，
 * 并把「没截到图」记在 store。回答开始流出或落到 playing 时提问面板卸掉（选区已被清空，
 * 不能留着「已选：无」的草稿框）；截图失败提示留到下一次提问，或仍在圈选时退出。
 * Esc 由画选层的窗口监听处理。关面板（取消按钮或 Esc）后焦点回到选区原目标。
 */
"use client";

import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import Link from "next/link";
import { cancelAsk, sendAsk } from "@/lib/ask/ask-client";
import { ASK_ERROR_SPECS, resolveAskError, type AskErrorAction } from "@/lib/ask/ask-errors";
import { captureStage, type CaptureResult } from "@/lib/ask/capture";
import { collectAskCandidates, summarizeSelection } from "@/lib/ask/collect-candidates";
import {
  ASK_CAPTURE_FALLBACK,
  ASK_CHIPS,
  ASK_SHORTCUT_STEP,
  ASK_SHORTCUT_SUBTITLE,
  ASK_SHORTCUT_VIZ,
  ASK_WAITING_STATUS,
} from "@/lib/ask/ask-ui-text";
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
  const [desktop, setDesktop] = useState(false);
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null);
  const [drawerBottom, setDrawerBottom] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const sendingRef = useRef(false);

  const stepId = steps[currentIndex]?.id ?? "";
  const waiting = askPhase === "sending" || askPhase === "streaming";
  const errored = askPhase === "error";
  const drafting = askPhase === "drafting";
  const trimmedEmpty = draftQuestion.trim().length === 0;
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
      const offset = viewport ? Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop) : 0;
      setDrawerBottom(offset);
      setAnchor(null);
      const box = selection?.bbox;
      if (hostEl && box && box.width > 0 && box.height > 0) {
        const marker = hostEl.querySelector<HTMLElement>("[data-ask-selection]") ?? hostEl;
        marker.scrollIntoView?.({ block: "start" });
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
    textareaRef.current?.focus();
  }, [drafting]);

  useEffect(() => {
    if (!waiting) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [waiting, askStartedAt]);

  // 等待文案每 10 秒写入页面已有的唯一 role=status，不新建第二个。
  useEffect(() => {
    if (!waiting) return;
    const write = () => {
      const status = document.querySelector("[role=status]");
      if (!status) return;
      const seconds = elapsedSeconds(usePlayerStore.getState().askStartedAt, Date.now());
      status.textContent = ASK_WAITING_STATUS(seconds);
    };
    write();
    const timer = window.setInterval(write, STATUS_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [waiting, askStartedAt]);

  const submit = useCallback(async () => {
    if (sendingRef.current) return;
    const state = usePlayerStore.getState();
    if (state.askPhase !== "drafting" && state.askPhase !== "error") return;
    if (state.draftQuestion.trim().length === 0) return;
    const startStepId = state.steps[state.currentIndex]?.id ?? "";
    const startSelection = state.selection;
    if (!startSelection) return;
    sendingRef.current = true;
    // 新的一次截图开始：上一轮「没截到图」先清掉，这次失败再写回。
    usePlayerStore.setState({ askCaptureFallback: false });
    let capture: CaptureResult | null;
    try {
      capture = await captureStage(resolveStage(stage), startSelection);
    } catch {
      capture = null;
    }
    const latest = usePlayerStore.getState();
    const latestStepId = latest.steps[latest.currentIndex]?.id ?? "";
    if (latestStepId !== startStepId || latest.selection !== startSelection) {
      sendingRef.current = false;
      return;
    }
    const failed = !capture || capture.ok === false;
    // 记在 store 上：sendAsk 把 phase 推进后本组件不再靠本地 state 记住这次失败。
    usePlayerStore.setState({ askCaptureFallback: failed });
    await sendAsk(failed ? null : capture);
    sendingRef.current = false;
  }, [stage]);

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
      textareaRef.current?.focus();
    }
  };

  const seconds = elapsedSeconds(askStartedAt, now);
  const positionClass = desktop ? "absolute z-40 w-80" : "fixed inset-x-0 z-40 max-h-[50vh] overflow-y-auto";

  return (
    <div
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

      <p id={labelId} data-ask-panel-label className="text-xs text-beam-gold">
        {label}
      </p>

      {captureFailed ? (
        <p data-ask-capture-fallback className="text-[11px] text-chalk-500">
          {ASK_CAPTURE_FALLBACK}
        </p>
      ) : null}

      {waiting ? (
        <p data-ask-waiting className="text-xs text-chalk-300">
          {ASK_WAITING_STATUS(seconds)}
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
            className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 rounded-md border border-board-600 px-3 py-1"
            onClick={() => cancelAsk()}
          >
            取消
          </button>
        ) : (
          <button
            type="button"
            data-ask-cancel
            className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 rounded-md border border-board-600 px-3 py-1"
            onClick={() => closeAskPanel()}
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
            aria-disabled={trimmedEmpty || waiting ? true : undefined}
            className={`pointer-coarse:min-h-11 pointer-coarse:min-w-11 rounded-md bg-beam-gold px-3 py-1 text-on-accent${
              trimmedEmpty || waiting ? " opacity-50 cursor-not-allowed" : ""
            }`}
            onClick={() => {
              if (trimmedEmpty || waiting) return;
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
