"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  animate,
  motion,
  useMotionValue,
  useMotionValueEvent,
  useTransform,
  type Variants,
} from "motion/react";

/* ---------- 10 秒循环特效秀（docs/02 §5.2） ---------- */

const CODE_LINES = [
  "function twoSum(nums, target) {",
  "  const seen = new Map();",
  "  for (let i = 0; i < nums.length; i++) {",
  "    if (seen.has(target - nums[i]))",
  "      return [seen.get(target - nums[i]), i];",
];
const LINE_H = 24; // leading-6
const SUBTITLE = "两数之和，我们从哈希表讲起…";
const LOOP_S = 10;

/** 光束在时间轴上依次照亮第 1~5 行；<0 表示灯灭 */
function beamLineAt(t: number): number {
  if (t < 0.06 || t >= 0.96) return -1;
  if (t < 0.2) return 0;
  if (t < 0.36) return 1;
  if (t < 0.52) return 2;
  if (t < 0.7) return 3;
  return 4;
}

function EffectsShow() {
  const progress = useMotionValue(0);
  const [beamLine, setBeamLine] = useState(-1);
  const [chars, setChars] = useState(0);

  useEffect(() => {
    const controls = animate(progress, 1, {
      duration: LOOP_S,
      ease: "linear",
      repeat: Infinity,
    });
    return () => controls.stop();
  }, [progress]);

  useMotionValueEvent(progress, "change", (t) => {
    setBeamLine(beamLineAt(t));
    const typed =
      t < 0.62
        ? 0
        : Math.min(
            SUBTITLE.length,
            Math.floor(((t - 0.62) / 0.26) * SUBTITLE.length),
          );
    setChars(t >= 0.96 ? 0 : typed);
  });

  // 粉笔下划线：第 4 行（seen.has…）在 t=0.52~0.64 画出，收尾时淡出
  const underlineScale = useTransform(progress, [0.52, 0.64], [0, 1]);
  const underlineOpacity = useTransform(progress, [0.92, 0.97], [1, 0]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1], delay: 0.3 }}
      className="w-full max-w-2xl overflow-hidden rounded-2xl border border-board-700/60 bg-board-900/70 shadow-2xl backdrop-blur-md"
    >
      {/* 窗口栏 */}
      <div className="flex items-center gap-1.5 border-b border-board-700/50 px-4 py-2.5">
        <span className="size-2.5 rounded-full bg-beam-rose/70" />
        <span className="size-2.5 rounded-full bg-beam-gold/70" />
        <span className="size-2.5 rounded-full bg-beam-mint/70" />
        <span className="ml-3 text-xs text-chalk-500">
          学习页 · two-sum · 讲课模式
        </span>
      </div>

      <div className="grid sm:grid-cols-5">
        {/* 左：讲义（题面） */}
        <div className="hidden border-r border-board-700/50 p-4 sm:col-span-2 sm:block">
          <p className="font-chalk text-lg text-chalk-100">1. 两数之和</p>
          <div className="mt-3 space-y-2">
            {[88, 72, 80, 45].map((w, i) => (
              <div
                key={i}
                className="h-2 rounded-full bg-board-700/70"
                style={{ width: `${w}%` }}
              />
            ))}
          </div>
          <p className="mt-4 text-[11px] leading-relaxed text-chalk-500">
            给定数组与 target，找出和为目标值的两个下标。
          </p>
        </div>

        {/* 右：黑板（代码） */}
        <div className="relative p-4 sm:col-span-3">
          <pre className="relative text-[12px] leading-6 text-chalk-300">
            {/* Spotlight Beam：滑动迁移的聚光灯 */}
            <motion.div
              className="pointer-events-none absolute inset-x-0 rounded-sm"
              style={{
                height: LINE_H,
                background:
                  "radial-gradient(ellipse 90% 100% at 30% 50%, rgba(255, 209, 102, 0.22), transparent 75%)",
              }}
              initial={false}
              animate={{
                y: beamLine < 0 ? 0 : beamLine * LINE_H,
                opacity: beamLine < 0 ? 0 : 1,
              }}
              transition={{
                y: { type: "spring", stiffness: 200, damping: 26 },
                opacity: { duration: 0.25 },
              }}
            >
              <span className="absolute inset-y-0 left-0 w-[2px] rounded-full bg-beam-gold" />
            </motion.div>

            {CODE_LINES.map((line, i) => (
              <div key={i} className="relative whitespace-pre">
                {line}
                {i === 3 && (
                  /* Chalk Underline：手绘粉笔下划线 */
                  <motion.span
                    className="absolute -bottom-0.5 left-4 h-[3px] w-40 origin-left -rotate-[0.8deg] rounded-full bg-beam-gold"
                    style={{
                      scaleX: underlineScale,
                      opacity: underlineOpacity,
                      filter:
                        "drop-shadow(0 0 3px rgba(255, 209, 102, 0.55))",
                    }}
                  />
                )}
              </div>
            ))}
          </pre>
        </div>
      </div>

      {/* 字幕条：打字机 */}
      <div className="flex h-11 items-center border-t border-board-700/50 bg-board-950/60 px-4">
        <span className="font-chalk text-lg text-chalk-100">
          {SUBTITLE.slice(0, chars)}
        </span>
        {chars > 0 && (
          <motion.span
            className="ml-0.5 inline-block h-4 w-[2px] rounded-full bg-beam-gold"
            animate={{ opacity: [1, 0.2, 1] }}
            transition={{ duration: 0.9, repeat: Infinity, ease: "easeInOut" }}
          />
        )}
        {chars === 0 && (
          <span className="text-xs text-chalk-700">字幕待命中…</span>
        )}
      </div>
    </motion.div>
  );
}

/* ---------- 特性卡片 ---------- */

const cardVariants: Variants = {
  idle: {},
  hover: {},
};

function FeatureCard({
  title,
  desc,
  children,
}: {
  title: string;
  desc: string;
  children: React.ReactNode;
}) {
  return (
    <motion.div
      variants={cardVariants}
      initial="idle"
      whileHover="hover"
      whileTap="idle"
      className="group rounded-xl border border-board-700/50 bg-board-900/60 p-5 backdrop-blur-sm transition-colors hover:border-beam-gold/40"
    >
      <div className="flex h-10 items-center">{children}</div>
      <h3 className="mt-3 font-chalk text-xl text-chalk-100">{title}</h3>
      <p className="mt-1 text-sm leading-relaxed text-chalk-500">{desc}</p>
    </motion.div>
  );
}

const rippleRing: Variants = {
  idle: { scale: 1, opacity: 0 },
  hover: {
    scale: [1, 1.6],
    opacity: [0.7, 0],
    transition: { duration: 0.9, repeat: Infinity, ease: "easeOut" },
  },
};

const playNudge: Variants = {
  idle: { x: 0 },
  hover: {
    x: [0, 5, 0],
    transition: { duration: 0.8, repeat: Infinity, ease: "easeInOut" },
  },
};

const sparkle = (delay: number): Variants => ({
  idle: { scale: 0, opacity: 0 },
  hover: {
    scale: [0, 1, 0.6],
    opacity: [0, 1, 0.8],
    transition: { duration: 0.9, repeat: Infinity, delay },
  },
});

const barGrow = (i: number): Variants => ({
  idle: { scaleY: 0.3 },
  hover: {
    scaleY: 1,
    transition: { type: "spring", stiffness: 300, damping: 18, delay: i * 0.07 },
  },
});

/* ---------- 页面 ---------- */

export default function LandingPage() {
  return (
    <div className="mx-auto max-w-6xl px-6">
      {/* 首屏 */}
      <section className="flex flex-col items-center pb-20 pt-16 text-center sm:pt-24">
        <motion.h1
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
          className="font-chalk text-5xl text-chalk-100 [text-shadow:0_0_24px_rgba(244,241,232,0.2)] sm:text-7xl"
        >
          Spotlight
        </motion.h1>
        <motion.p
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1], delay: 0.12 }}
          className="mt-4 text-lg text-chalk-300 sm:text-xl"
        >
          像老师站在黑板前讲课一样学算法
        </motion.p>
        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.7, delay: 0.24 }}
          className="mt-2 text-sm text-chalk-500"
        >
          AI 讲到哪，聚光灯就打到哪 · LeetCode Hot 100 · 纯本地运行
        </motion.p>

        <div className="mt-12 flex w-full justify-center">
          <EffectsShow />
        </div>

        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 0.5 }}
          className="mt-12"
        >
          <Link
            href="/roadmap"
            className="inline-block rounded-full bg-beam-gold px-8 py-3 text-sm font-semibold text-board-950 transition-transform duration-200 hover:scale-105 active:scale-95"
            style={{ filter: "drop-shadow(0 0 16px rgba(255, 209, 102, 0.35))" }}
          >
            开始刷题 →
          </Link>
        </motion.div>
      </section>

      {/* 特性卡片 */}
      <section className="grid gap-4 pb-24 sm:grid-cols-2 lg:grid-cols-4">
        <FeatureCard
          title="教鞭特效讲解"
          desc="聚光灯、粉笔划线、注意力涟漪——AI 的手指点到哪，你的眼睛就跟到哪。"
        >
          <span className="relative flex size-8 items-center justify-center">
            <motion.span
              variants={rippleRing}
              className="absolute inset-0 rounded-full border-2 border-beam-gold"
            />
            <span
              className="size-3 rounded-full bg-beam-gold"
              style={{ filter: "drop-shadow(0 0 6px rgba(255,209,102,0.8))" }}
            />
          </span>
        </FeatureCard>

        <FeatureCard
          title="本地 Playground"
          desc="浏览器沙箱里随时上台自己写代码，测试全过触发粉笔礼花。"
        >
          <span className="flex items-center gap-1 rounded-md border border-board-700/70 bg-board-950/80 px-3 py-1.5 font-mono text-sm text-beam-mint">
            <motion.span variants={playNudge}>▶</motion.span> run
          </span>
        </FeatureCard>

        <FeatureCard
          title="BYOK 内嵌 AI"
          desc="自带 API Key，DeepSeek / Claude / Gemini 随你选，Key 只存在本机。"
        >
          <span className="relative flex size-8 items-center justify-center">
            <svg
              viewBox="0 0 24 24"
              className="size-5 text-beam-violet"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            >
              <circle cx="8" cy="8" r="4" />
              <path d="M11 11l9 9m-3-3l2.5-2.5M16 16l2-2" />
            </svg>
            {[0, 0.3, 0.6].map((d, i) => (
              <motion.span
                key={i}
                variants={sparkle(d)}
                className="absolute size-1 rounded-full bg-beam-violet"
                style={{
                  top: `${[2, 24, 8][i]}px`,
                  left: `${[26, 28, 0][i]}px`,
                }}
              />
            ))}
          </span>
        </FeatureCard>

        <FeatureCard
          title="个人看板"
          desc="热力图、掌握度生长图、独立性指标——每一次 AC 都会开花。"
        >
          <span className="flex h-8 items-end gap-1">
            {[0.5, 0.8, 0.6, 1].map((h, i) => (
              <motion.span
                key={i}
                variants={barGrow(i)}
                className="w-2 origin-bottom rounded-sm bg-beam-gold/80"
                style={{ height: `${h * 100}%` }}
              />
            ))}
          </span>
        </FeatureCard>
      </section>
    </div>
  );
}
