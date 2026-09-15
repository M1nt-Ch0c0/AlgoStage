/**
 * /playground/effects · 特效调试页（docs/02 §8-5）
 * 每种注册特效一个独立演示入口：点击按钮在示例讲义段落 / 示例数组上触发，
 * 支持切换特效色与粉笔形状； confetti 在演示区中心喷发。
 */
"use client";

import { useState } from "react";
import Link from "next/link";
import { AnimatePresence } from "motion/react";
import { ArrowLeft } from "lucide-react";
import { listEffects } from "@/lib/effects/registry";
import type { BeamColor, EffectTarget } from "@/lib/teaching/types";
import type { VizFrame } from "@/lib/teaching/types";
import { FxContext, usePrefersReducedMotion, type EffectLevel } from "@/components/effects/fx-context";
import { InlineMarkdown } from "@/components/board/inline-markdown";
import ArrayVisualizer from "@/components/viz/array-visualizer";
import "@/components/effects/index"; // 注册全部内置特效

const COLORS: BeamColor[] = ["gold", "cyan", "violet", "rose", "mint"];
const LEVELS: { value: EffectLevel; label: string }[] = [
  { value: "full", label: "华丽" },
  { value: "calm", label: "克制" },
  { value: "minimal", label: "极简" },
];

const TARGETS: { label: string; target: EffectTarget }[] = [
  { label: "讲义 · intro", target: { kind: "statement", blockId: "intro" } },
  { label: "讲义 · insight", target: { kind: "statement", blockId: "insight" } },
  { label: "讲义 · summary", target: { kind: "statement", blockId: "summary" } },
  { label: "数组节点 a1", target: { kind: "viz-node", nodeId: "a1" } },
  { label: "数组节点 a2", target: { kind: "viz-node", nodeId: "a2" } },
];

const DEMO_FRAME: VizFrame = {
  type: "array",
  state: { values: [2, 7, 11, 15], highlight: [1], map: { "2": 0 }, scan: 2 },
  captions: [{ nodeId: "a2", text: "i" }],
};

interface ActiveFx {
  effect: string;
  target: EffectTarget;
  key: number;
}

export default function EffectsPlayground() {
  const [active, setActive] = useState<ActiveFx | null>(null);
  const [color, setColor] = useState<BeamColor>("gold");
  const [shape, setShape] = useState<"line" | "circle">("line");
  const [targetIdx, setTargetIdx] = useState(0);
  const [level, setLevel] = useState<EffectLevel>("full");
  const reduced = usePrefersReducedMotion();

  const effects = listEffects();

  const fire = (effect: string) => {
    setActive({
      effect,
      target: TARGETS[targetIdx].target,
      key: Date.now(),
    });
  };

  const Plugin = active ? listEffects().find((e) => e.name === active.effect) : undefined;

  return (
    <FxContext.Provider value={{ level, reduced }}>
      <main className="mx-auto flex min-h-screen max-w-[1200px] flex-col gap-4 p-6">
        <header className="flex items-center gap-3">
          <Link
            href="/"
            className="flex h-8 w-8 items-center justify-center rounded-full text-chalk-500 hover:bg-board-700 hover:text-chalk-100"
            aria-label="返回"
          >
            <ArrowLeft size={16} />
          </Link>
          <h1 className="text-lg font-semibold text-chalk-100">特效调试台</h1>
          <span className="text-xs text-chalk-500">docs/02 §8-5 · 共 {effects.length} 种已注册特效</span>
        </header>

        {/* 演示区：示例讲义 + 示例数组 */}
        <section className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <div className="rounded-2xl border border-board-700 bg-board-900 p-4">
            <h2 className="mb-3 font-chalk text-xl text-chalk-300">示例讲义</h2>
            <div className="flex flex-col gap-3 text-[15px] leading-7 text-chalk-300">
              <p data-statement="intro" className="rounded-lg px-2 py-1">
                给定整数数组 <InlineMarkdown text="`nums`" /> 和目标值{" "}
                <InlineMarkdown text="`target`" />，找出和为目标值的两个整数。
              </p>
              <p data-statement="insight" className="rounded-lg px-2 py-1">
                <InlineMarkdown text="**关键洞察**：对每个数，我们只想知道它的另一半在哪。" />
              </p>
              <p data-statement="summary" className="rounded-lg px-2 py-1">
                <InlineMarkdown text="套路：**枚举一个，查找另一个**——内层查找换成哈希表。" />
              </p>
            </div>
          </div>
          <div className="rounded-2xl border border-board-700 bg-board-900 p-4">
            <h2 className="mb-3 font-chalk text-xl text-chalk-300">示例数组</h2>
            <ArrayVisualizer frame={DEMO_FRAME} />
          </div>
        </section>

        {/* 控制台 */}
        <section className="flex flex-col gap-3 rounded-2xl border border-board-700 bg-board-900 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="w-16 text-xs text-chalk-500">特效</span>
            {effects.map((e) => (
              <button
                key={e.name}
                onClick={() => fire(e.name)}
                className={`rounded-full border px-3 py-1 font-mono text-xs transition-colors ${
                  active?.effect === e.name
                    ? "border-beam-gold/60 text-beam-gold"
                    : "border-board-600 text-chalk-300 hover:text-chalk-100"
                }`}
              >
                {e.name}
              </button>
            ))}
            <button
              onClick={() => setActive(null)}
              className="rounded-full border border-board-600 px-3 py-1 text-xs text-chalk-500 hover:text-chalk-100"
            >
              清除
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="w-16 text-xs text-chalk-500">锚点</span>
            {TARGETS.map((t, i) => (
              <button
                key={t.label}
                onClick={() => setTargetIdx(i)}
                className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                  targetIdx === i
                    ? "border-beam-cyan/60 text-beam-cyan"
                    : "border-board-600 text-chalk-500 hover:text-chalk-100"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="w-16 text-xs text-chalk-500">颜色</span>
            {COLORS.map((c) => (
              <button
                key={c}
                onClick={() => setColor(c)}
                aria-label={c}
                className={`h-6 w-6 rounded-full border-2 transition-transform hover:scale-110 ${
                  color === c ? "border-chalk-100" : "border-transparent"
                }`}
                style={{ background: `var(--color-beam-${c})` }}
              />
            ))}
            <span className="ml-4 w-16 text-xs text-chalk-500">粉笔</span>
            {(["line", "circle"] as const).map((s) => (
              <button
                key={s}
                onClick={() => setShape(s)}
                className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                  shape === s
                    ? "border-beam-violet/60 text-beam-violet"
                    : "border-board-600 text-chalk-500 hover:text-chalk-100"
                }`}
              >
                {s === "line" ? "划线" : "圈选"}
              </button>
            ))}
            <span className="ml-4 w-16 text-xs text-chalk-500">档位</span>
            {LEVELS.map((l) => (
              <button
                key={l.value}
                onClick={() => setLevel(l.value)}
                className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                  level === l.value
                    ? "border-beam-gold/60 text-beam-gold"
                    : "border-board-600 text-chalk-500 hover:text-chalk-100"
                }`}
              >
                {l.label}
              </button>
            ))}
          </div>
          <p className="text-xs text-chalk-700">
            提示：先选一个锚点再点特效；切换锚点后重新点击同一特效可观察「平滑迁移」。
            laser-pointer 会从上一次落点飞过来。档位模拟 EffectStage 的降级过滤（本页直接渲染插件不过滤，仅传递降级上下文）。
          </p>
        </section>

        {/* 特效层 */}
        <div className="pointer-events-none fixed inset-0" aria-hidden>
          <AnimatePresence>
            {Plugin && active && (
              <Plugin.component
                key={active.key}
                target={active.target}
                color={color}
                params={active.effect === "chalk-underline" ? { shape } : undefined}
              />
            )}
          </AnimatePresence>
        </div>
      </main>
    </FxContext.Provider>
  );
}
