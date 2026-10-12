/**
 * LessonPlan · 教案（docs/02 §0「教案 = 讲解脚本」）
 * 讲课时列出全部步骤：讲过的变淡、正在讲的点亮、点击任意一步跳过去。
 */
"use client";

import { useEffect, useRef } from "react";
import { usePlayerStore } from "@/lib/player/store";
import type { TeachingStep } from "@/lib/teaching/types";

/** 去掉行内 markdown 记号，教案里只显示纯文本 */
function plain(md: string) {
  return md.replace(/`([^`]+)`/g, "$1").replace(/\*\*([^*]+)\*\*/g, "$1");
}

/** preview：开课前预览教案（只读，不可跳转） */
export default function LessonPlan({ preview }: { preview?: TeachingStep[] }) {
  const liveSteps = usePlayerStore((s) => s.steps);
  const steps = preview ?? liveSteps;
  const current = usePlayerStore((s) => s.currentIndex);
  const status = usePlayerStore((s) => s.status);
  const goto = usePlayerStore((s) => s.goto);
  const listRef = useRef<HTMLOListElement>(null);

  // 当前步滚进可视区（只在教案列表内部滚动）
  useEffect(() => {
    const list = listRef.current;
    const el = list?.querySelector<HTMLElement>(`[data-step="${current}"]`);
    if (!list || !el) return;
    const top = el.offsetTop - list.offsetTop;
    if (top < list.scrollTop || top + el.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTo({ top: top - 8, behavior: "smooth" });
    }
  }, [current]);

  if (steps.length === 0) return null;
  const finished = status === "finished";

  if (preview) {
    return (
      <ol className="flex flex-col gap-1.5 border-t border-board-700/70 pt-3">
        {preview.map((s, i) => (
          <li key={s.id} className="flex gap-3 text-[13px] leading-5 text-chalk-500">
            <span className="mt-px flex size-5 shrink-0 items-center justify-center rounded-full border border-board-600 font-mono text-[10px] tabular-nums">
              {i + 1}
            </span>
            <span className="line-clamp-1">{plain(s.narration)}</span>
          </li>
        ))}
      </ol>
    );
  }

  return (
    <ol ref={listRef} className="flex min-h-0 flex-col gap-0.5 overflow-y-auto pr-1">
      {steps.map((s, i) => {
        const now = i === current && !finished;
        const past = i < current || finished;
        return (
          <li key={s.id} data-step={i}>
            <button
              type="button"
              onClick={() => goto(i)}
              aria-current={now ? "step" : undefined}
              className={`flex w-full gap-3 rounded-lg px-2.5 py-2 text-left text-[13px] leading-5 transition-colors ${
                now ? "bg-beam-gold/10 text-chalk-100" : past ? "text-chalk-500 hover:bg-board-800" : "text-chalk-300 hover:bg-board-800"
              }`}
            >
              <span
                className={`mt-px flex size-5 shrink-0 items-center justify-center rounded-full font-mono text-[10px] tabular-nums ${
                  now
                    ? "bg-beam-gold text-on-accent"
                    : past
                      ? "border border-chalk-700 text-chalk-500"
                      : "border border-board-600 text-chalk-500"
                }`}
              >
                {i + 1}
              </span>
              <span className="line-clamp-2">{plain(s.narration)}</span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}
