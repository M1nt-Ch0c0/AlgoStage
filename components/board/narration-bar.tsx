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
import { IS_DEMO } from "@/lib/runtime";
import { parseInline, totalChars, InlinePartial, InlineMarkdown } from "./inline-markdown";
import { usePrefersReducedMotion } from "@/components/effects/fx-context";

const BASE_CHARS_PER_SEC = 24;

export default function NarrationBar({ problemSlug }: { problemSlug?: string } = {}) {
  const step = usePlayerStore((s) => s.steps[s.currentIndex]);
  const status = usePlayerStore((s) => s.status);
  const speed = usePlayerStore((s) => s.speed);
  const next = usePlayerStore((s) => s.next);
  const reduced = usePrefersReducedMotion();

  const segments = useMemo(
    () => parseInline(step?.narration ?? ""),
    [step?.narration],
  );
  const total = totalChars(segments);
  const stepKey = `${step?.id ?? ""}\0${step?.narration ?? ""}`;
  const [typing, setTyping] = useState({ key: "", count: 0 });
  // 非播放态直接显示全文；新步骤首帧也不能沿用上一句的打字进度。
  const typed = reduced || status !== "playing" ? total : typing.key === stepKey ? typing.count : 0;
  const accRef = useRef(0);
  const done = total === 0 || typed >= total;

  // 仅播放中的新步骤从零开始；暂停/追问补全当前句，恢复播放时保留全文。
  useEffect(() => {
    accRef.current = 0;
    setTyping(previous => {
      if (reduced || status !== "playing") return { key: stepKey, count: total };
      return previous.key === stepKey ? previous : { key: stepKey, count: 0 };
    });
  }, [stepKey, total, reduced, status]);

  // 打字机仅在播放中推进。
  useEffect(() => {
    if (done || reduced || status !== "playing") return;
    const perTick = (BASE_CHARS_PER_SEC * speed) / 20; // 50ms 一拍
    const timer = setInterval(() => {
      accRef.current += perTick;
      const n = Math.floor(accRef.current);
      if (n > 0) {
        accRef.current -= n;
        setTyping(t => ({ key: stepKey, count: Math.min(total, (t.key === stepKey ? t.count : 0) + n) }));
      }
    }, 50);
    return () => clearInterval(timer);
  }, [done, reduced, status, speed, total, stepKey]);

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
      className={`rounded-xl border px-4 py-3 transition-colors ${
        step ? "cursor-pointer border-beam-gold/25 bg-board-800/80" : "border-board-700 bg-board-800/50"
      }`}
      onClick={() => setTyping({ key: stepKey, count: total })}
      title={step && !done ? "点击显示全文" : undefined}
    >
      <p className="mb-1 font-mono text-[10px] tracking-widest text-chalk-700">字幕</p>
      {step ? (
        <p className="min-h-12 text-[15px] leading-6 text-chalk-100">
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
        <p className="text-[15px] leading-6 text-chalk-500">
          {IS_DEMO && problemSlug !== "two-sum"
            ? "体验版只内置了「两数之和」这一课；其他题目可以先读题、练习，装到自己电脑上接上 AI 就能听讲。"
            : "点「开始讲课」，老师说的每句话都会在这里一个字一个字出现。"}
        </p>
      )}
      {/* 隐藏全量文本供无障碍读取 */}
      {step && <span className="sr-only"><InlineMarkdown text={step.narration} /></span>}
    </div>
  );
}
