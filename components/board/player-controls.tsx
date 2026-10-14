/**
 * PlayerControls · 讲解播放器控制条（docs/02 §5.4 底部）
 * 上一步/播放暂停/下一步 · 步骤指示 · 可点击时间线圆点 · 自动播放 · 语速 · 特效强度档位。
 * 键盘可达：←/→ 步进、Space 播放暂停；等待继续时 Space/→ 均下一步（docs/02 §7）。
 * 结束面板出现后 Space 与 → 不再操作播放器。
 * 等待继续时「下一步」改为图标加文字的按钮，热区至少 44px；平时仍是图标按钮。
 * 粗指针下上一步、播放暂停、下一步（含非等待态）热区至少 44×44；时间线圆点视觉仍是 20px 居中细条，点按高度至少 44px，宽度均分整条且相邻热区边对边贴合、不重叠。细指针尺寸不变。
 * 自动播放、语速与特效强度仍用 pill 的 py-0.5 视觉；粗指针用透明 after 把点按高度扩到至少 44px，pill 宽至少 44px 且文字居中，换行 gap-y 加大以免相邻行热区重叠。
 * 粗指针且下一步已就绪时，把「点「下一步」继续」放在这条控制条里（窄屏单独成行，吸底仍可见）。
 * 某步已有提问时，时间线圆点内加一枚不接收指针的小标记；无障碍名称改为「跳到第 N 步，有 M 个提问」。
 * 回答播放中：暂停只暂停当前段，播放继续当前段，下一步切到下一段，不推进原课。
 * 输入框、contenteditable、Monaco 编辑器内以及带 Ctrl/Meta/Alt 的按键不拦截。
 * 焦点在 button 或链接上时只把 Space 留给控件本身（重播、语速）；←/→ 仍步进。
 * 焦点在 role=dialog 内，或页面上存在 aria-modal="true" 的对话框时，忽略全部播放器快捷键。
 */
"use client";

import { useEffect } from "react";
import { Pause, Play, SkipBack, SkipForward } from "lucide-react";
import type { StepAnswer } from "@/lib/ask/types";
import { endPanelShowing, syncPrefsFromStorage, usePlayerStore } from "@/lib/player/store";
import { useCoarsePointer } from "./use-coarse-pointer";

const EMPTY_ANSWERS: Record<string, StepAnswer[]> = {};

const SPEEDS = [0.5, 1, 1.5, 2] as const;
const LEVELS = [
  { value: "full", label: "华丽" },
  { value: "calm", label: "克制" },
  { value: "minimal", label: "极简" },
] as const;

/** 焦点在输入控件、可编辑区或 Monaco 内时不抢快捷键（happy-dom 未必实现 isContentEditable）。 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  return (
    target.closest('[contenteditable=""],[contenteditable="true"],.monaco-editor') !== null
  );
}

/** 按钮和链接自己处理 Space，播放器不能 preventDefault 掉原生激活。方向键仍由播放器步进。 */
function isSpaceActivationTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("button, a") !== null;
}

/**
 * preparing：首个步骤到达前（备课中，不可播放）。
 * generating：已收到部分步骤可播放，但教案尚未生成完成——总步数未知，
 * 不显示「第 x / N 步」，时间线末尾留一段「仍在备课」占位，避免 1/1 满格。
 * interrupted：备课超时/中断但已收到部分步骤——步骤仍可播放，占位段改为静态「断开」样式。
 */
export default function PlayerControls({
  preparing = false,
  lectureBusy = false,
  generating = false,
  interrupted = false,
}: {
  preparing?: boolean;
  /** 备课中：结束面板不显示，Space / → 也不按结束面板拦截。 */
  lectureBusy?: boolean;
  /**
   * generating：已收到部分步骤可播放，但教案尚未生成完成——总步数未知，
   * 不显示「第 x / N 步」，时间线末尾留一段「仍在备课」占位。
   */
  generating?: boolean;
  interrupted?: boolean;
}) {
  const status = usePlayerStore((s) => s.status);
  const steps = usePlayerStore((s) => s.steps);
  const currentIndex = usePlayerStore((s) => s.currentIndex);
  const speed = usePlayerStore((s) => s.speed);
  const effectLevel = usePlayerStore((s) => s.effectLevel);
  const autoAdvance = usePlayerStore((s) => s.autoAdvance);
  const autoAdvanceHydrated = usePlayerStore((s) => s.autoAdvanceHydrated);
  const awaitingContinue = usePlayerStore((s) => s.awaitingContinue);
  const receiving = usePlayerStore((s) => s.receiving);
  const answers = usePlayerStore((s) => (s.answersReady ? s.answers : EMPTY_ANSWERS));
  const askPhase = usePlayerStore((s) => s.askPhase);
  const askPlaybackPaused = usePlayerStore((s) => s.askPlaybackPaused);
  const askPlaybackRun = usePlayerStore((s) => s.askPlaybackRun);
  const coarsePointer = useCoarsePointer();
  const {
    play,
    pause,
    next,
    prev,
    goto,
    setSpeed,
    setEffectLevel,
    setAutoAdvance,
    hydrateAutoAdvance,
    hydratePrefs,
    setAnswerPlaybackPaused,
    nextAnswerSegment,
  } = usePlayerStore.getState();

  useEffect(() => {
    hydrateAutoAdvance();
    hydratePrefs();
  }, [hydrateAutoAdvance, hydratePrefs]);

  useEffect(() => {
    window.addEventListener("storage", syncPrefsFromStorage);
    return () => window.removeEventListener("storage", syncPrefsFromStorage);
  }, []);

  const hasScript = !preparing && steps.length > 0;
  const answerPlayback = askPhase === "playing";
  // 回答播放时图标跟段暂停，不跟原课 status（此时是 interrupted）。
  const playing = answerPlayback ? !askPlaybackPaused : status === "playing" || status === "streaming";
  // 流式停在最后一步时「下一步准备中…」仍由字幕条显示，这里不插提示。
  const preparingNext =
    awaitingContinue && receiving && steps.length > 0 && currentIndex === steps.length - 1;
  const showContinueHint = coarsePointer && awaitingContinue && !preparingNext;
  // 与字幕条「讲完了」同一条件：finished、当前步存在、且没在备课。
  const panelShowing = endPanelShowing({ status, steps, currentIndex, lectureBusy });

  // 键盘：←/→ 步进、Space 播放暂停；等待继续时 Space 与 → 都下一步。输入区与修饰键忽略。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      // 按钮 / 链接只接管 Space；←/→ 在点过「下一步」之后仍要步进。
      if (e.key === " " && isSpaceActivationTarget(e.target)) return;
      // 对话框内，或任意 aria-modal 打开（焦点常停在 body）时，丢掉全部快捷键。
      // 放在结束面板判断之前，避免面板的 preventDefault 抢走对话框里的 Space。
      const target = e.target;
      const insideDialog = target instanceof Element && target.closest("[role=dialog]") !== null;
      if (insideDialog || document.querySelector('[aria-modal="true"]')) return;
      // 结束面板出现后空格与 → 不再回退到最后一步；← 仍可回看。备课中面板不显示，按键照常。
      if (panelShowing && (e.key === " " || e.key === "ArrowRight")) {
        e.preventDefault();
        return;
      }
      if (!hasScript) return;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        prev();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        // 回答播放只切段，不走 next()，避免推进 currentIndex。
        if (answerPlayback) nextAnswerSegment(askPlaybackRun);
        else next();
      } else if (e.key === " ") {
        e.preventDefault();
        if (answerPlayback) setAnswerPlaybackPaused(!askPlaybackPaused);
        else if (awaitingContinue) next();
        else if (playing) pause();
        else play();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    hasScript,
    playing,
    awaitingContinue,
    panelShowing,
    answerPlayback,
    askPlaybackPaused,
    askPlaybackRun,
    play,
    pause,
    next,
    prev,
    setAnswerPlaybackPaused,
    nextAnswerSegment,
  ]);

  const btn =
    "flex size-8 shrink-0 items-center whitespace-nowrap justify-center rounded-full text-chalk-300 transition-colors hover:bg-board-700 hover:text-chalk-100 disabled:pointer-events-none disabled:opacity-30 pointer-coarse:size-11";
  const pill = (on: boolean) =>
    `shrink-0 whitespace-nowrap rounded-full px-2.5 pointer-coarse:px-1.5 py-0.5 text-xs transition-colors relative pointer-coarse:inline-flex pointer-coarse:min-w-11 pointer-coarse:items-center pointer-coarse:justify-center pointer-coarse:after:absolute pointer-coarse:after:inset-x-0 pointer-coarse:after:top-1/2 pointer-coarse:after:h-11 pointer-coarse:after:-translate-y-1/2 pointer-coarse:after:content-[""] ${
      on ? "bg-board-700 text-beam-gold" : "text-chalk-500 hover:text-chalk-300"
    }`;

  return (
    <div
      data-testid="player-controls"
      className="flex flex-wrap items-center gap-x-4 pointer-coarse:gap-x-2 gap-y-2 pointer-coarse:gap-y-5 rounded-2xl border border-board-700/70 bg-board-900/90 px-3 py-2 backdrop-blur-md"
    >
      {/* 步进控制 */}
      <div className="flex items-center gap-1">
        <button type="button" className={btn} onClick={prev} disabled={!hasScript || currentIndex === 0} aria-label="上一步">
          <SkipBack size={16} />
        </button>
        <button
          type="button"
          className="flex size-9 shrink-0 items-center whitespace-nowrap justify-center rounded-full bg-beam-gold text-on-accent transition-transform hover:scale-105 disabled:pointer-events-none disabled:bg-board-700 disabled:text-chalk-700 pointer-coarse:size-11"
          onClick={() => {
            if (answerPlayback) {
              setAnswerPlaybackPaused(!askPlaybackPaused);
              return;
            }
            if (playing) pause();
            else play();
          }}
          disabled={!hasScript}
          aria-label={playing ? "暂停" : "播放"}
        >
          {playing ? <Pause size={16} /> : <Play size={16} className="ml-0.5" />}
        </button>
        <button
          type="button"
          className={
            awaitingContinue
              ? "flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-1 rounded-full px-3 text-xs font-semibold transition-colors bg-beam-gold text-on-accent hover:brightness-110 disabled:pointer-events-none disabled:opacity-30"
              : btn
          }
          onClick={() => {
            if (answerPlayback) {
              nextAnswerSegment(askPlaybackRun);
              return;
            }
            next();
          }}
          disabled={
            !hasScript ||
            (!answerPlayback && currentIndex >= steps.length - 1 && (receiving || status === "finished"))
          }
          aria-label="下一步"
          data-awaiting={awaitingContinue ? "true" : undefined}
        >
          {awaitingContinue ? <><SkipForward size={16} />下一步</> : <SkipForward size={16} />}
        </button>
      </div>

      {/* 窄屏 basis-full 独占一行，排在按钮上方；宽屏缩回内容宽度，紧挨「下一步」。 */}
      {showContinueHint && (
        <p
          role="status"
          aria-live="polite"
          data-testid="continue-hint"
          className="order-first shrink-0 basis-full text-xs text-beam-gold/80 sm:order-none sm:shrink sm:basis-auto"
        >
          点「下一步」继续
        </p>
      )}

      {/* 步骤指示 + 时间线：每一步一段，可点击跳转 */}
      <div className="flex min-w-[10rem] flex-1 items-center gap-3">
        {preparing ? (
          <span role="status" className="text-xs text-chalk-500">备课中…</span>
        ) : hasScript ? (
          <>
            {generating || interrupted ? (
              <span role="status" className="shrink-0 text-xs text-chalk-300 tabular-nums">
                {generating ? `已收到 ${steps.length} 步，仍在备课…` : `已收到 ${steps.length} 步，备课中断`}
              </span>
            ) : (
              <span className="shrink-0 font-mono text-xs text-chalk-300 tabular-nums">
                第 {Math.min(currentIndex + 1, steps.length)} / {steps.length} 步
              </span>
            )}
            {/* 时间线轨道：圆点 flex-1 等宽均分；占位段 w-8 shrink-0 贴在同一轨道末尾，不参与均分。 */}
            <div className="flex min-w-0 flex-1 items-center">
              {steps.map((s, i) => {
                const asked = answers[s.id]?.length ?? 0;
                return (
                  <button
                    type="button"
                    key={s.id}
                    onClick={() => goto(i)}
                    aria-label={asked > 0 ? `跳到第 ${i + 1} 步，有 ${asked} 个提问` : `跳到第 ${i + 1} 步`}
                    aria-current={i === currentIndex ? "step" : undefined}
                    className="group flex h-5 min-w-0 flex-1 items-center justify-center pointer-coarse:h-11"
                  >
                    <span
                      data-dot-visual=""
                      className={`relative block h-1.5 w-full rounded-full transition-colors ${
                        i === currentIndex
                          ? "bg-beam-gold"
                          : i < currentIndex
                            ? "bg-chalk-500 group-hover:bg-chalk-300"
                            : "bg-board-600 group-hover:bg-chalk-700"
                      }`}
                    >
                      {asked > 0 && (
                        <span
                          data-answer-mark=""
                          aria-hidden="true"
                          className={`pointer-events-none absolute top-1/2 left-1/2 size-1 -translate-x-1/2 -translate-y-1/2 rounded-full ${
                            i === currentIndex ? "bg-board-950" : "bg-beam-gold"
                          }`}
                        />
                      )}
                    </span>
                  </button>
                );
              })}
              {(generating || interrupted) && <PendingSegment broken={interrupted} />}
            </div>
          </>
        ) : (
          <span className="text-xs text-chalk-700">还没开始上课</span>
        )}
      </div>

      {/* 自动播放：关闭时打完本步停住，等空格或下一步继续。
          读完 localStorage 前不报 aria-pressed，避免首帧与真实偏好相反。 */}
      <button
        type="button"
        aria-pressed={autoAdvanceHydrated ? autoAdvance : undefined}
        aria-busy={autoAdvanceHydrated ? undefined : true}
        disabled={!autoAdvanceHydrated}
        onClick={() => setAutoAdvance(!autoAdvance)}
        className={autoAdvanceHydrated ? pill(autoAdvance) : `${pill(false)} pointer-events-none opacity-50`}
      >
        自动播放
      </button>

      {/* 语速 */}
      <div role="group" aria-label="语速" className="flex items-center gap-0.5 rounded-full border border-board-700/70 p-0.5">
        {SPEEDS.map((v) => (
          <button type="button" key={v} onClick={() => setSpeed(v)} aria-pressed={speed === v} className={`${pill(speed === v)} font-mono`}>
            {v}×
          </button>
        ))}
      </div>

      {/* 特效强度档位（docs/02 §5.6） */}
      <div role="group" aria-label="特效强度" className="flex items-center gap-0.5 rounded-full border border-board-700/70 p-0.5">
        {LEVELS.map((l) => (
          <button
            type="button"
            key={l.value}
            onClick={() => setEffectLevel(l.value)}
            aria-pressed={effectLevel === l.value}
            className={pill(effectLevel === l.value)}
          >
            {l.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** 未完成占位段：独立于圆点尺寸，固定宽度、不参与等宽均分。broken = 备课中断（静态）。 */
function PendingSegment({ broken }: { broken: boolean }) {
  return (
    <span
      aria-hidden="true"
      data-pending-step={broken ? "broken" : "true"}
      className="flex h-5 w-8 shrink-0 items-center"
    >
      <span
        className={`block h-1.5 w-full rounded-full border border-dashed ${
          broken ? "border-beam-rose/60" : "motion-safe:animate-pulse motion-reduce:animate-none border-board-600"
        }`}
      />
    </span>
  );
}
