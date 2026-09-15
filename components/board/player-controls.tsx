/**
 * PlayerControls · 讲解播放器控制条（docs/02 §5.4 底部）
 * 上一步/播放暂停/下一步 · 步骤指示 · 可点击时间线圆点 · 语速 · 特效强度档位。
 * 键盘可达：←/→ 步进、Space 播放暂停（docs/02 §7）。
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

export default function PlayerControls() {
  const status = usePlayerStore((s) => s.status);
  const steps = usePlayerStore((s) => s.steps);
  const currentIndex = usePlayerStore((s) => s.currentIndex);
  const speed = usePlayerStore((s) => s.speed);
  const effectLevel = usePlayerStore((s) => s.effectLevel);
  const { play, pause, next, prev, goto, setSpeed, setEffectLevel } =
    usePlayerStore.getState();

  const hasScript = steps.length > 0;
  const playing = status === "playing" || status === "streaming";

  // 键盘操作：←/→ 步进、Space 播放暂停
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!hasScript) return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        prev();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        next();
      } else if (e.key === " ") {
        e.preventDefault();
        playing ? pause() : play();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hasScript, playing, play, pause, next, prev]);

  const btn =
    "flex h-8 w-8 items-center justify-center rounded-full text-chalk-300 transition-colors hover:bg-board-700 hover:text-chalk-100 disabled:pointer-events-none disabled:opacity-30";

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl border border-board-700 bg-board-800/70 px-4 py-2 backdrop-blur">
      {/* 步进控制 */}
      <div className="flex items-center gap-1">
        <button className={btn} onClick={prev} disabled={!hasScript || currentIndex === 0} aria-label="上一步">
          <SkipBack size={16} />
        </button>
        <button
          className={`${btn} bg-board-700 text-beam-gold hover:text-beam-gold`}
          onClick={() => (playing ? pause() : play())}
          disabled={!hasScript}
          aria-label={playing ? "暂停" : "播放"}
        >
          {playing ? <Pause size={16} /> : <Play size={16} className="ml-0.5" />}
        </button>
        <button
          className={btn}
          onClick={next}
          disabled={!hasScript || currentIndex >= steps.length - 1}
          aria-label="下一步"
        >
          <SkipForward size={16} />
        </button>
      </div>

      {/* 步骤指示 + 时间线 */}
      {hasScript && (
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <span className="shrink-0 font-mono text-xs text-chalk-500">
            {Math.min(currentIndex + 1, steps.length)}/{steps.length}
          </span>
          <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto py-1">
            {steps.map((s, i) => (
              <button
                key={s.id}
                onClick={() => goto(i)}
                aria-label={`跳到第 ${i + 1} 步`}
                className="group shrink-0 p-0.5"
              >
                <span
                  className={`block h-2 w-2 rounded-full transition-transform group-hover:scale-150 ${
                    i === currentIndex
                      ? "scale-125 bg-beam-gold"
                      : i < currentIndex
                        ? "bg-chalk-500"
                        : "bg-board-600"
                  }`}
                />
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 语速 */}
      <div className="flex items-center gap-1 rounded-full bg-board-900/60 p-0.5">
        {SPEEDS.map((v) => (
          <button
            key={v}
            onClick={() => setSpeed(v)}
            className={`rounded-full px-2 py-0.5 font-mono text-xs transition-colors ${
              speed === v ? "bg-board-700 text-beam-gold" : "text-chalk-500 hover:text-chalk-300"
            }`}
          >
            {v}x
          </button>
        ))}
      </div>

      {/* 特效强度档位（docs/02 §5.6） */}
      <div className="flex items-center gap-1 rounded-full bg-board-900/60 p-0.5">
        {LEVELS.map((l) => (
          <button
            key={l.value}
            onClick={() => setEffectLevel(l.value)}
            className={`rounded-full px-2.5 py-0.5 text-xs transition-colors ${
              effectLevel === l.value
                ? "bg-board-700 text-beam-gold"
                : "text-chalk-500 hover:text-chalk-300"
            }`}
          >
            {l.label}
          </button>
        ))}
      </div>
    </div>
  );
}
