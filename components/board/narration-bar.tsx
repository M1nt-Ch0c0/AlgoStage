/**
 * NarrationBar · 板书打字机字幕条（docs/02 §4.6）
 * 逐字出现（约 24 字/秒 × 语速），内联 code 金色 mono 高亮；
 * 光标是发光粉笔小竖线，句毕轻跳（globals.css caret-hop）。
 * 与播放器同步：字幕打完后，awaitNarration 为 false 立刻下一步；
 * 否则仅 autoAdvance 时 dwellMs 停留后自动推进，关闭时停在本步等用户继续。
 * 等待继续时只显示提示（粗指针「点「下一步」继续」，细指针「按空格继续」）；
 * 流式中下一步还没到时优先显示「下一步准备中…」。可点的「下一步」在播放控制条。
 * 讲完仍显示最后一句，并提供下一题（末题则回路线图）与重播。点击字幕条可跳过打字直接看全文。
 */
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { selectScriptSlug, usePlayerStore } from "@/lib/player/store";
import { nextProblem } from "@/lib/content/roadmap-order";
import { parseInline, totalChars, InlinePartial, InlineMarkdown } from "./inline-markdown";
import { usePrefersReducedMotion } from "@/components/effects/fx-context";
import { useCoarsePointer } from "./use-coarse-pointer";

const BASE_CHARS_PER_SEC = 24;

export default function NarrationBar() {
  const step = usePlayerStore((s) => s.steps[s.currentIndex]);
  const status = usePlayerStore((s) => s.status);
  const speed = usePlayerStore((s) => s.speed);
  const next = usePlayerStore((s) => s.next);
  const replay = usePlayerStore((s) => s.replay);
  const currentSlug = usePlayerStore(selectScriptSlug);
  const nextItem = nextProblem(currentSlug ?? "");
  const autoAdvance = usePlayerStore((s) => s.autoAdvance);
  const awaitingContinue = usePlayerStore((s) => s.awaitingContinue);
  const receiving = usePlayerStore((s) => s.receiving);
  const currentIndex = usePlayerStore((s) => s.currentIndex);
  const receivedCount = usePlayerStore((s) => s.steps.length);
  const setAwaitingContinue = usePlayerStore((s) => s.setAwaitingContinue);
  const preparingNext =
    awaitingContinue && receiving && receivedCount > 0 && currentIndex === receivedCount - 1;
  const reduced = usePrefersReducedMotion();
  const coarsePointer = useCoarsePointer();

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

  // 打完后：不等待则立刻下一步；自动播放才停留后推进，否则停在本步等用户继续。
  useEffect(() => {
    if (!done || !step || status !== "playing") return;
    if (step.awaitNarration === false) {
      next();
      return;
    }
    if (autoAdvance) {
      const dwell = (step.dwellMs ?? 800) / speed;
      const timer = setTimeout(next, dwell);
      return () => clearTimeout(timer);
    }
    if (!usePlayerStore.getState().awaitingContinue) setAwaitingContinue(true);
  }, [done, step, status, speed, next, autoAdvance, setAwaitingContinue]);

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
          点「开始讲课」，老师说的每句话都会在这里一个字一个字出现。
        </p>
      )}
      {awaitingContinue && (
        <p data-testid="continue-hint" className="mt-1 text-xs text-beam-gold/80">
          {preparingNext ? "下一步准备中…" : coarsePointer ? "点「下一步」继续" : "按空格继续"}
        </p>
      )}
      {status === "finished" && step && (
        <div>
          <p>讲完了</p>
          {nextItem ? (
            <Link
              href={`/problem/${nextItem.slug}`}
              className="rounded-full bg-beam-gold px-4 py-1.5 text-sm font-semibold text-on-accent"
              onClick={(event) => event.stopPropagation()}
            >
              下一题
            </Link>
          ) : (
            <Link
              href="/roadmap"
              className="rounded-full bg-beam-gold px-4 py-1.5 text-sm font-semibold text-on-accent"
              onClick={(event) => event.stopPropagation()}
            >
              回路线图
            </Link>
          )}
          <button
            type="button"
            className="rounded-full border border-board-600 px-3 py-1 text-sm text-chalk-300 hover:text-chalk-100"
            onClick={(event) => {
              event.stopPropagation();
              replay();
            }}
          >
            重播
          </button>
          {nextItem && (
            <Link
              href="/roadmap"
              className="text-sm text-chalk-300 hover:text-chalk-100"
              onClick={(event) => event.stopPropagation()}
            >
              回路线图
            </Link>
          )}
        </div>
      )}
      {/* 隐藏全量文本供无障碍读取 */}
      {step && <span className="sr-only"><InlineMarkdown text={step.narration} /></span>}
    </div>
  );
}
