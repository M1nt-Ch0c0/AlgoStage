/**
 * 六种教学手势（对应 EFFECT_WHITELIST，docs/02 §4）
 * 每张卡片一块迷你黑板：静止时就是这个特效的定格画面，悬停或聚焦时演示一遍。
 */
"use client";

import { motion, type Variants } from "motion/react";

/** 三根"代码行"的长度 */
const BARS = [72, 54, 64];

function Bars({
  dim,
  className = "",
}: {
  dim?: (i: number) => boolean;
  className?: string;
}) {
  return (
    <div className={`flex flex-col gap-2.5 ${className}`}>
      {BARS.map((w, i) => (
        <motion.span
          key={i}
          variants={dim ? { idle: { opacity: 1 }, hover: { opacity: dim(i) ? 0.22 : 1 } } : undefined}
          className="block h-2 rounded-full bg-chalk-500/45"
          style={{ width: `${w}%` }}
        />
      ))}
    </div>
  );
}

const ease = [0.22, 1, 0.36, 1] as const;

function BeamDemo() {
  return (
    <div className="relative">
      <motion.span
        aria-hidden="true"
        className="absolute -inset-x-2 h-5 rounded"
        style={{
          top: -6,
          background:
            "radial-gradient(ellipse 80% 120% at 30% 50%, color-mix(in srgb, var(--color-beam-gold) 32%, transparent), transparent 75%)",
          boxShadow: "inset 2px 0 0 var(--color-beam-gold)",
        }}
        variants={{ idle: { y: 18 }, hover: { y: [18, 36, 0, 18], transition: { duration: 2.2, ease, repeat: Infinity } } }}
      />
      <Bars />
    </div>
  );
}

function LaserDemo() {
  return (
    <div className="relative">
      <Bars />
      <motion.span
        aria-hidden="true"
        className="absolute size-2.5 rounded-full bg-beam-gold"
        style={{ left: 0, top: -1, filter: "drop-shadow(0 0 6px var(--color-beam-gold))" }}
        variants={{
          idle: { x: 150, y: 0 },
          hover: {
            x: [150, 120, 36, 150],
            y: [0, -14, 36, 0],
            transition: { duration: 1.8, ease: "easeInOut", repeat: Infinity, repeatDelay: 0.3 },
          },
        }}
      />
    </div>
  );
}

function UnderlineDemo() {
  return (
    <div className="relative">
      <Bars />
      <svg aria-hidden="true" className="absolute left-0 top-[23px] h-2 w-[56%] overflow-visible" viewBox="0 0 100 8" preserveAspectRatio="none">
        <motion.path
          d="M1 5 C 14 3, 26 6.5, 40 4.5 S 66 3.5, 80 5.6 S 94 4, 99 4.6"
          fill="none"
          stroke="var(--color-beam-violet)"
          strokeWidth="2.4"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
          variants={{
            idle: { pathLength: 1 },
            hover: { pathLength: [0, 1], transition: { duration: 0.9, ease, repeat: Infinity, repeatDelay: 0.6 } },
          }}
          style={{ filter: "drop-shadow(0 0 3px var(--color-beam-violet))" }}
        />
      </svg>
    </div>
  );
}

function DimDemo() {
  return (
    <div className="relative">
      <Bars dim={(i) => i !== 1} />
      <span className="absolute -inset-x-2 top-[11px] h-5 rounded border border-chalk-500/30" aria-hidden="true" />
    </div>
  );
}

const ring: Variants = {
  idle: { scale: 1, opacity: 0.55 },
  hover: { scale: [1, 1.18], opacity: [0.7, 0], transition: { duration: 1.1, ease: "easeOut", repeat: Infinity } },
};

function RippleDemo() {
  return (
    <div className="relative">
      <Bars />
      <motion.span
        aria-hidden="true"
        variants={ring}
        className="absolute -inset-x-2 top-[11px] h-5 rounded-md border-2 border-beam-cyan"
      />
    </div>
  );
}

function SplitDemo() {
  return (
    <div className="grid grid-cols-2 gap-3">
      {[
        { mark: "M3 3 L13 13 M13 3 L3 13", color: "var(--color-beam-rose)" },
        { mark: "M2 9 L6 13 L14 3", color: "var(--color-beam-mint)" },
      ].map((side, i) => (
        <div
          key={i}
          className="relative rounded-md px-2 py-2"
          style={{ background: `color-mix(in srgb, ${side.color} 9%, transparent)` }}
        >
          <div className="flex flex-col gap-2">
            <span className="block h-1.5 w-4/5 rounded-full bg-chalk-500/45" />
            <span className="block h-1.5 w-3/5 rounded-full bg-chalk-500/45" />
          </div>
          <svg aria-hidden="true" viewBox="0 0 16 16" className="absolute right-1.5 top-1.5 size-4">
            <motion.path
              d={side.mark}
              fill="none"
              stroke={side.color}
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              variants={{
                idle: { pathLength: 1 },
                hover: { pathLength: [0, 1], transition: { duration: 0.6, delay: i * 0.35, repeat: Infinity, repeatDelay: 1 } },
              }}
            />
          </svg>
        </div>
      ))}
    </div>
  );
}

const GESTURES = [
  { name: "聚光灯", effect: "spotlight-beam", says: "现在看这里。", desc: "一束暖光落在正在讲的那一行，讲到下一句，光就跟着滑过去。", Demo: BeamDemo },
  { name: "激光教鞭", effect: "laser-pointer", says: "刚才讲完这里，现在看那边。", desc: "要换到很远的地方讲时，一颗小光点先飞过去，带着你的眼睛走。", Demo: LaserDemo },
  { name: "粉笔划线", effect: "chalk-underline", says: "这个条件很关键。", desc: "最要紧的那几个字，老师会用粉笔在下面划一道。", Demo: UnderlineDemo },
  { name: "舞台压暗", effect: "focus-dim", says: "别的先别看。", desc: "细讲一小段时，其他地方先暗下来，免得你分心。", Demo: DimDemo },
  { name: "注意力涟漪", effect: "attention-ripple", says: "顺便留意一下。", desc: "轻轻提醒你一句，波纹荡开就散，不打断思路。", Demo: RippleDemo },
  { name: "正误对比", effect: "comparison-split", says: "看看错在哪。", desc: "常见的错误写法和正确写法并排摆着，一对比就明白。", Demo: SplitDemo },
] as const;

export function GestureCards() {
  return (
    <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {GESTURES.map(({ name, effect, says, desc, Demo }) => (
        <motion.li
          key={effect}
          initial="idle"
          animate="idle"
          whileHover="hover"
          whileFocus="hover"
          tabIndex={0}
          className="group flex flex-col gap-4 rounded-2xl border border-board-700/60 bg-board-900/70 p-5 outline-none transition-colors hover:border-board-600 focus-visible:border-beam-gold/60"
        >
          <div className="board-surface rounded-lg px-5 py-5">
            <Demo />
          </div>
          <div>
            <h3 className="text-[15px] font-semibold text-chalk-100">{name}</h3>
            <p className="chalk mt-1 text-xl text-beam-gold">“{says}”</p>
            <p className="mt-1 text-sm leading-6 text-chalk-500">{desc}</p>
          </div>
        </motion.li>
      ))}
    </ul>
  );
}
