/**
 * EffectStage · 特效统一挂载层（docs/02 §3.2）
 * 覆盖学习页的透明舞台（pointer-events-none）：订阅播放器 currentStep，
 * 解析该步 effects[]，从注册表取组件渲染。
 *
 * 纪律（docs/02 §3.3 / §5.6 / §7）：
 *  - 特效按 "名字:targetIndex" 持久 key 化 → 步骤切换时组件不卸载，
 *    光束/压暗孔平滑迁移而非瞬移；真正消失的特效走 exit 动画（200ms）。
 *  - 同屏活跃特效 ≤3。
 *  - 强度档位：克制=关 focus-dim/laser-pointer；极简=只剩静态 spotlight-beam。
 *  - prefers-reduced-motion 通过 FxContext 下发，各特效自行降级。
 *  - 未注册/未命中锚点的特效静默忽略（协议容错）。
 */
"use client";

import { useMemo } from "react";
import { AnimatePresence } from "motion/react";
import { usePlayerStore } from "@/lib/player/store";
import { getEffect } from "@/lib/effects/registry";
import type { EffectCall } from "@/lib/teaching/types";
import { FxContext, usePrefersReducedMotion, type EffectLevel } from "./fx-context";
import "./index"; // 注册全部内置特效

const MAX_ACTIVE = 3;

function filterByLevel(calls: EffectCall[], level: EffectLevel): EffectCall[] {
  if (level === "minimal") return calls.filter((c) => c.effect === "spotlight-beam");
  if (level === "calm")
    return calls.filter((c) => c.effect !== "focus-dim" && c.effect !== "laser-pointer");
  return calls;
}

export default function EffectStage() {
  const step = usePlayerStore((s) => s.steps[s.currentIndex]);
  const status = usePlayerStore((s) => s.status);
  const effectLevel = usePlayerStore((s) => s.effectLevel);
  const reduced = usePrefersReducedMotion();

  const active = step != null && status !== "idle" && status !== "finished";

  const fx = useMemo(
    () => (active ? filterByLevel(step.effects, effectLevel).slice(0, MAX_ACTIVE) : []),
    [active, step, effectLevel],
  );

  const ctx = useMemo(
    () => ({ level: effectLevel, reduced }),
    [effectLevel, reduced],
  );

  return (
    <FxContext.Provider value={ctx}>
      <div className="pointer-events-none fixed inset-0" aria-hidden>
        <AnimatePresence>
          {fx.map((call) => {
            const plugin = getEffect(call.effect);
            const target = step?.targets[call.targetIndex ?? 0];
            if (!plugin || !target) return null;
            const Component = plugin.component;
            return (
              <Component
                key={`${call.effect}:${call.targetIndex ?? 0}`}
                target={target}
                color={call.color}
                intensity={call.intensity}
                params={call.params}
              />
            );
          })}
        </AnimatePresence>
      </div>
    </FxContext.Provider>
  );
}
