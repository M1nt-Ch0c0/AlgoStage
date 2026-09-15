/**
 * NarrationBar · 板书打字机字幕条（docs/02 §4.6）
 * 逐字出现（约 24 字/秒 × 语速），内联 code 金色 mono 高亮；
 * 光标是发光粉笔小竖线，句毕轻跳（globals.css caret-hop）。
 * 与播放器同步：字幕打完 + dwellMs 停留后才自动推进下一步（awaitNarration 语义）；
 * 点击字幕条可跳过打字直接看全文。
 */
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { usePlayerStore } from "@/lib/player/store";
import { parseInline, totalChars, InlinePartial, InlineMarkdown } from "./inline-markdown";
import { usePrefersReducedMotion } from "@/components/effects/fx-context";

const BASE_CHARS_PER_SEC = 24;

export default function NarrationBar() {
  const step = usePlayerStore((s) => s.steps[s.currentIndex]);
  const status = usePlayerStore((s) => s.status);
  const speed = usePlayerStore((s) => s.speed);
  const next = usePlayerStore((s) => s.next);
  const reduced = usePrefersReducedMotion();

  const segments = useMemo(
    () => parseInline(step?.narration ?? ""),
    [step?.id], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const total = totalChars(segments);
  const [typed, setTyped] = useState(0);
  const accRef = useRef(0);
  const done = total === 0 || typed >= total;

  // 步骤切换：重置打字进度
  useEffect(() => {
    accRef.current = 0;
    setTyped(reduced ? total : 0);
  }, [step?.id, total, reduced]);

  // 打字机推进（仅在播放中走字；暂停即冻结）
  useEffect(() => {
    if (done || reduced || status !== "playing") return;
    const perTick = (BASE_CHARS_PER_SEC * speed) / 20; // 50ms 一拍
    const timer = setInterval(() => {
      accRef.current += perTick;
      const n = Math.floor(accRef.current);
      if (n > 0) {
        accRef.current -= n;
        setTyped((t) => Math.min(total, t + n));
      }
    }, 50);
    return () => clearInterval(timer);
  }, [done, reduced, status, speed, total]);

  // 打完 + 停留 → 自动推进下一步（awaitNarration 默认 true）
  useEffect(() => {
    if (!done || !step || status !== "playing") return;
    if (step.awaitNarration === false) {
      next();
      return;
    }
    const dwell = (step.dwellMs ?? 800) / speed;
    const timer = setTimeout(next, dwell);
    return () => clearTimeout(timer);
  }, [done, step, status, speed, next]);

  return (
    <div
      className="cursor-pointer rounded-xl border border-board-700 bg-board-800/70 px-4 py-3 backdrop-blur"
      onClick={() => setTyped(total)}
      title={done ? undefined : "点击显示全文"}
    >
      {step ? (
        <p className="min-h-6 text-[15px] leading-6 text-chalk-100">
          <InlinePartial segments={segments} count={typed} />
          {/* 粉笔光标 */}
          <span
            className="ml-0.5 inline-block h-4 w-[2px] rounded-full align-text-bottom"
            style={{
              background: "var(--color-beam-gold)",
              filter: "drop-shadow(0 0 4px var(--color-beam-gold))",
              animation: done
                ? "caret-hop 0.5s ease-in-out 2"
                : "beam-breathe 1.2s ease-in-out infinite",
            }}
          />
        </p>
      ) : (
        <p className="min-h-6 text-[15px] leading-6 text-chalk-500">
          点击顶栏「开始讲课」，AI 老师会指着黑板带你过一遍这题。
        </p>
      )}
      {/* 隐藏全量文本供无障碍读取 */}
      {step && <span className="sr-only"><InlineMarkdown text={step.narration} /></span>}
    </div>
  );
}
