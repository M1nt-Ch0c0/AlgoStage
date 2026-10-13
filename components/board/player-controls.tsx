/**
 * PlayerControls · 讲解播放器控制条（docs/02 §5.4 底部）
 * 上一步/播放暂停/下一步 · 步骤指示 · 可点击时间线圆点 · 自动播放 · 语速 · 特效强度档位。
 * 键盘可达：←/→ 步进、Space 播放暂停；等待继续时 Space/→ 均下一步（docs/02 §7）。
 * 输入框、contenteditable、Monaco 编辑器内以及带 Ctrl/Meta/Alt 的按键不拦截。
 */
"use client";

import { useEffect } from "react";
import { Pause, Play, SkipBack, SkipForward } from "lucide-react";
import { usePlayerStore } from "@/lib/player/store";

const SPEEDS = [0.5, 1, 1.5, 2] as const;
const LEVELS = [
  { value: "full", label: "华丽" },
  { value: "calm", label: "克制" },
  { value: "minimal", label: "极简" },
] as const;

/** 焦点在输入控件、可编辑区或 Monaco 内时不抢快捷键（happy-dom 未必实现 isContentEditable）。 */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  return (
    target.closest('[contenteditable=""],[contenteditable="true"],.monaco-editor') !== null
  );
}

export default function PlayerControls({ preparing = false }: { preparing?: boolean }) {
  const status = usePlayerStore((s) => s.status);
  const steps = usePlayerStore((s) => s.steps);
  const currentIndex = usePlayerStore((s) => s.currentIndex);
  const speed = usePlayerStore((s) => s.speed);
  const effectLevel = usePlayerStore((s) => s.effectLevel);
  const autoAdvance = usePlayerStore((s) => s.autoAdvance);
  const awaitingContinue = usePlayerStore((s) => s.awaitingContinue);
  const { play, pause, next, prev, goto, setSpeed, setEffectLevel, setAutoAdvance } =
    usePlayerStore.getState();

  const hasScript = !preparing && steps.length > 0;
  const playing = status === "playing" || status === "streaming";

  // 键盘：←/→ 步进、Space 播放暂停；等待继续时 Space 与 → 都下一步。输入区与修饰键忽略。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!hasScript) return;
      if (isTypingTarget(e.target)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        prev();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        next();
      } else if (e.key === " ") {
        e.preventDefault();
        if (awaitingContinue) next();
        else if (playing) pause();
        else play();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hasScript, playing, awaitingContinue, play, pause, next, prev]);

  const btn =
    "flex size-8 items-center justify-center rounded-full text-chalk-300 transition-colors hover:bg-board-700 hover:text-chalk-100 disabled:pointer-events-none disabled:opacity-30";
  const pill = (on: boolean) =>
    `rounded-full px-2.5 py-0.5 text-xs transition-colors ${
      on ? "bg-board-700 text-beam-gold" : "text-chalk-500 hover:text-chalk-300"
    }`;

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl border border-board-700/70 bg-board-900/90 px-3 py-2 backdrop-blur-md">
      {/* 步进控制 */}
      <div className="flex items-center gap-1">
        <button type="button" className={btn} onClick={prev} disabled={!hasScript || currentIndex === 0} aria-label="上一步">
          <SkipBack size={16} />
        </button>
        <button
          type="button"
          className="flex size-9 items-center justify-center rounded-full bg-beam-gold text-on-accent transition-transform hover:scale-105 disabled:pointer-events-none disabled:bg-board-700 disabled:text-chalk-700"
          onClick={() => (playing ? pause() : play())}
          disabled={!hasScript}
          aria-label={playing ? "暂停" : "播放"}
        >
          {playing ? <Pause size={16} /> : <Play size={16} className="ml-0.5" />}
        </button>
        <button
          type="button"
          className={`${btn}${awaitingContinue ? " text-beam-gold ring-1 ring-beam-gold/60 animate-pulse" : ""}`}
          onClick={next}
          disabled={!hasScript || currentIndex >= steps.length - 1}
          aria-label="下一步"
          data-awaiting={awaitingContinue ? "true" : undefined}
        >
          <SkipForward size={16} />
        </button>
      </div>

      {/* 步骤指示 + 时间线：每一步一段，可点击跳转 */}
      <div className="flex min-w-[10rem] flex-1 items-center gap-3">
        {preparing ? (
          <span role="status" className="text-xs text-chalk-500">备课中…</span>
        ) : hasScript ? (
          <>
            <span className="shrink-0 font-mono text-xs text-chalk-300 tabular-nums">
              第 {Math.min(currentIndex + 1, steps.length)} / {steps.length} 步
            </span>
            <div className="flex min-w-0 flex-1 items-center gap-1">
              {steps.map((s, i) => (
                <button
                  type="button"
                  key={s.id}
                  onClick={() => goto(i)}
                  aria-label={`跳到第 ${i + 1} 步`}
                  aria-current={i === currentIndex ? "step" : undefined}
                  className="group flex h-5 min-w-0 flex-1 items-center"
                >
                  <span
                    className={`block h-1.5 w-full rounded-full transition-colors ${
                      i === currentIndex
                        ? "bg-beam-gold"
                        : i < currentIndex
                          ? "bg-chalk-500 group-hover:bg-chalk-300"
                          : "bg-board-600 group-hover:bg-chalk-700"
                    }`}
                  />
                </button>
              ))}
            </div>
          </>
        ) : (
          <span className="text-xs text-chalk-700">还没开始上课</span>
        )}
      </div>

      {/* 自动播放：关闭时打完本步停住，等空格或下一步继续 */}
      <button
        type="button"
        aria-pressed={autoAdvance}
        onClick={() => setAutoAdvance(!autoAdvance)}
        className={pill(autoAdvance)}
      >
        自动播放
      </button>

      {/* 语速 */}
      <div role="group" aria-label="语速" className="flex items-center gap-0.5 rounded-full border border-board-700/70 p-0.5">
        {SPEEDS.map((v) => (
          <button type="button" key={v} onClick={() => setSpeed(v)} aria-pressed={speed === v} className={`${pill(speed === v)} font-mono`}>
            {v}x
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
