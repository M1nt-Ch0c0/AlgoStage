/**
 * DemoBoard · 首屏 10 秒讲课秀（docs/02 §5.2）
 * 一块带木框和粉笔槽的迷你黑板：光束沿代码逐行迁移、关键表达式被粉笔划线、
 * 字幕打字机逐句念白。减少动效时停在"划线那一步"的静态画面。
 */
"use client";

import { useEffect, useState } from "react";
import { animate, motion, useMotionValue, useMotionValueEvent, useReducedMotion } from "motion/react";

type Tok = { t: string; c?: "kw" | "fn" | "num" | "mark" };

const KW = new Set(["function", "const", "for", "let", "if", "return", "new"]);

/** 极简着色：关键字 / 函数名 / 数字；mark 是要被粉笔划线的片段 */
function tokenize(line: string, mark?: string): Tok[] {
  const out: Tok[] = [];
  const parts = mark ? line.split(mark) : [line];
  parts.forEach((part, pi) => {
    part.split(/(\b\w+\b)/).forEach((w) => {
      if (!w) return;
      if (KW.has(w)) out.push({ t: w, c: "kw" });
      else if (/^\d+$/.test(w)) out.push({ t: w, c: "num" });
      else if (w === "twoSum") out.push({ t: w, c: "fn" });
      else out.push({ t: w });
    });
    if (mark && pi < parts.length - 1) out.push({ t: mark, c: "mark" });
  });
  return out;
}

const CODE = [
  "function twoSum(nums, target) {",
  "  const seen = new Map();",
  "  for (let i = 0; i < nums.length; i++) {",
  "    const need = target - nums[i];",
  "    if (seen.has(need)) return [seen.get(need), i];",
  "    seen.set(nums[i], i);",
  "  }",
  "}",
];
const MARK_LINE = 3;
const MARK = "target - nums[i]";

/** 讲解步骤：照亮哪一行 + 这一步的字幕；起止是 0~1 的循环进度 */
const STEPS = [
  { from: 0.04, to: 0.22, line: 1, text: "先准备一张哈希表 seen，记下见过的数和下标。" },
  { from: 0.22, to: 0.4, line: 2, text: "从左往右扫，每个数只看一次。" },
  { from: 0.4, to: 0.62, line: 3, text: "要找的另一半，就是 target - nums[i]。" },
  { from: 0.62, to: 0.8, line: 4, text: "表里已经有它？答案立刻出来。" },
  { from: 0.8, to: 0.96, line: 5, text: "没找到，就把自己记进表里，留给后面的数。" },
];
const LOOP_S = 11;
const LINE_H = 26;
const STATIC_STEP = 2;

const TOKEN_CLASS: Record<string, string> = {
  kw: "text-beam-cyan/85",
  fn: "text-beam-gold",
  num: "text-beam-violet",
};

export function DemoBoard() {
  const reduced = useReducedMotion();
  const progress = useMotionValue(0);
  // 首帧必须和服务端一致（服务端不知道系统是否减少动效），挂载后再切到静态画面
  const [stepIdx, setStepIdx] = useState(-1);
  const [chars, setChars] = useState(0);
  const [markOn, setMarkOn] = useState(false);

  useEffect(() => {
    if (reduced) {
      setStepIdx(STATIC_STEP);
      setChars(STEPS[STATIC_STEP].text.length);
      setMarkOn(true);
      return;
    }
    const controls = animate(progress, 1, { duration: LOOP_S, ease: "linear", repeat: Infinity });
    return () => controls.stop();
  }, [progress, reduced]);

  useMotionValueEvent(progress, "change", (t) => {
    const i = STEPS.findIndex((s) => t >= s.from && t < s.to);
    setStepIdx(i);
    if (i < 0) {
      setChars(0);
      setMarkOn(false);
      return;
    }
    const s = STEPS[i];
    // 字幕在每步前 70% 时间打完，余下停留
    const local = (t - s.from) / ((s.to - s.from) * 0.7);
    setChars(Math.min(s.text.length, Math.floor(local * s.text.length)));
    setMarkOn(i >= 2 && i <= 3);
  });

  const step = stepIdx >= 0 ? STEPS[stepIdx] : null;

  return (
    <figure className="w-full min-w-0" aria-label="讲课演示：两数之和">
      <div className="board-surface board-frame overflow-hidden rounded-xl p-[6px]">
        {/* 板面顶栏 */}
        <div className="flex items-center justify-between gap-3 px-4 pt-3 pb-2">
          <p className="chalk text-xl text-chalk-100">第 1 课 · 两数之和</p>
          <span className="flex items-center gap-2 font-mono text-[11px] text-chalk-500">
            <span className="flex items-center gap-1.5 rounded-full border border-beam-gold/40 px-2 py-0.5 text-beam-gold">
              <span className="size-1.5 rounded-full bg-beam-gold" />
              讲课中
            </span>
            <span className="tabular-nums">{step ? stepIdx + 1 : 0}/5</span>
          </span>
        </div>

        {/* 代码 */}
        <div className="relative overflow-x-auto px-2 pb-3">
          <div className="relative min-w-[30rem] font-mono text-[12.5px] sm:text-[13px]">
            {/* 光束：滑动迁移 */}
            <motion.div
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-0 top-0 rounded"
              style={{
                height: LINE_H,
                background:
                  "radial-gradient(ellipse 80% 120% at 35% 50%, color-mix(in srgb, var(--color-beam-gold) 24%, transparent), transparent 75%)",
              }}
              initial={false}
              animate={{ y: (step?.line ?? 0) * LINE_H, opacity: step ? 1 : 0 }}
              transition={{ y: { type: "spring", stiffness: 210, damping: 26 }, opacity: { duration: 0.25 } }}
            >
              <span
                className="absolute inset-y-1 left-9 w-[2px] rounded-full bg-beam-gold"
                style={{ filter: "drop-shadow(0 0 4px var(--color-beam-gold))" }}
              />
            </motion.div>

            {CODE.map((line, i) => {
              const lit = step?.line === i;
              return (
                <div key={i} className="relative flex whitespace-pre" style={{ height: LINE_H, lineHeight: `${LINE_H}px` }}>
                  <span
                    className={`w-8 shrink-0 pr-3 text-right tabular-nums select-none ${lit ? "text-chalk-300" : "text-chalk-700"}`}
                  >
                    {i + 1}
                  </span>
                  <span className={`pl-3 ${lit ? "text-chalk-100" : "text-chalk-300/80"}`}>
                    {tokenize(line, i === MARK_LINE ? MARK : undefined).map((tok, ti) =>
                      tok.c === "mark" ? (
                        <span key={ti} className="relative text-chalk-100">
                          {tok.t}
                          {/* 粉笔划线：带抖动的手绘波浪 */}
                          <svg
                            aria-hidden="true"
                            className="pointer-events-none absolute -bottom-1 left-0 h-2 w-full overflow-visible"
                            viewBox="0 0 100 8"
                            preserveAspectRatio="none"
                          >
                            <motion.path
                              d="M1 5.2 C 12 3.6, 22 6.4, 34 4.6 S 58 3.4, 70 5.4 S 90 4.2, 99 4.8"
                              fill="none"
                              stroke="var(--color-beam-violet)"
                              strokeWidth="2.2"
                              strokeLinecap="round"
                              vectorEffect="non-scaling-stroke"
                              initial={false}
                              animate={{ pathLength: markOn ? 1 : 0, opacity: markOn ? 1 : 0 }}
                              transition={{
                                pathLength: { duration: markOn ? 0.6 : 0, ease: [0.22, 1, 0.36, 1] },
                                opacity: { duration: 0.2 },
                              }}
                              style={{ filter: "drop-shadow(0 0 3px var(--color-beam-violet))" }}
                            />
                          </svg>
                        </span>
                      ) : (
                        <span key={ti} className={tok.c ? TOKEN_CLASS[tok.c] : undefined}>
                          {tok.t}
                        </span>
                      ),
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* 字幕条 */}
        <div className="flex min-h-12 items-center gap-3 border-t border-board-700/70 bg-board-950/70 px-4 py-2.5">
          <span className="shrink-0 font-mono text-[10px] tracking-widest text-chalk-700">字幕</span>
          <p className="min-w-0 text-[14px] leading-6 text-chalk-100" aria-live="off">
            {step ? step.text.slice(0, chars) : <span className="text-chalk-700">老师正在擦黑板…</span>}
            {step && (
              <span
                className="ml-0.5 inline-block h-4 w-[2px] translate-y-0.5 rounded-full bg-beam-gold"
                style={{ animation: "beam-breathe 1s ease-in-out infinite" }}
              />
            )}
          </p>
        </div>
      </div>

      {/* 粉笔槽 */}
      <div className="chalk-tray mx-3" aria-hidden="true">
        <span className="chalk-stick left-[12%] w-10 bg-[#f4f1e8]" />
        <span className="chalk-stick left-[24%] w-6 rotate-[4deg] bg-[#ffd166]" />
        <span className="chalk-stick left-[70%] w-8 -rotate-[3deg] bg-[#4cc9f0]" />
        <span className="chalk-stick left-[80%] w-12 bg-[#b9b2a3]" />
      </div>
      <figcaption className="sr-only">
        示例：AI 老师讲解两数之和，光束依次照亮第 2 到第 6 行代码，并在 target - nums[i] 下划线。
      </figcaption>
    </figure>
  );
}
