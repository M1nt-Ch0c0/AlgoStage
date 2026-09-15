/**
 * Spotlight Beam · 聚光灯光束（DOM 版，docs/02 §4.1）
 * 用于讲义段落 / 可视化节点 / 任意 DOM 锚点；
 * 代码行的光束由 CodeEditor 通过 Monaco decorations 注入（.beam-line），不走这里。
 *
 * 视觉：目标背后浮起椭圆辉光（radial-gradient），2.4s 呼吸；
 * 左缘 2px 实色光柱；首次落光 150ms "开灯"（scaleX 0→1 带 overshoot）；
 * 步骤切换时组件不卸载（EffectStage 按特效名 key 持久化），位置用
 * cubic-bezier(.22,1,.36,1) 平滑迁移，绝不瞬移。
 */
"use client";

import { motion } from "motion/react";
import type { EffectProps } from "@/lib/effects/registry";
import { useAnchorRect } from "./use-anchor-rect";
import { beamColorVar, intensityScale, useFx } from "./fx-context";

const MIGRATE = { duration: 0.35, ease: [0.22, 1, 0.36, 1] as const };

export default function SpotlightBeam({ target, color, intensity }: EffectProps) {
  const rect = useAnchorRect(target);
  const { level, reduced } = useFx();
  if (!rect) return null;

  const beam = beamColorVar(color);
  const scale = intensityScale(intensity);
  const padX = 10 * scale;
  const padY = 5 * scale;
  // 极简档：静态高亮（无呼吸、无光柱辉光）
  const minimal = level === "minimal";

  return (
    <motion.div
      className="pointer-events-none fixed z-40"
      initial={reduced ? { opacity: 0 } : { opacity: 0, scaleX: 0 }}
      animate={{
        opacity: 1,
        scaleX: 1,
        top: rect.top - padY,
        left: rect.left - padX,
        width: rect.width + padX * 2,
        height: rect.height + padY * 2,
      }}
      exit={{ opacity: 0, transition: { duration: 0.2 } }}
      transition={{
        // 位置/尺寸：平滑迁移；入场：开灯 overshoot
        default: MIGRATE,
        opacity: { duration: reduced ? 0.15 : 0.2 },
        scaleX: reduced
          ? { duration: 0 }
          : { type: "spring", stiffness: 500, damping: 22, mass: 0.6 },
      }}
      style={{ transformOrigin: "left center", borderRadius: 8 }}
    >
      {/* 辉光层：呼吸只动 opacity（globals.css beam-breathe） */}
      <div
        className="absolute inset-0 rounded-lg"
        style={{
          background: `radial-gradient(ellipse 90% 100% at 30% 50%, color-mix(in srgb, ${beam} ${minimal ? 14 : 24}%, transparent), transparent 75%)`,
          animation:
            reduced || minimal ? "none" : "beam-breathe 2.4s ease-in-out infinite",
          opacity: reduced || minimal ? 0.7 : undefined,
        }}
      />
      {/* 左缘光柱 */}
      {!minimal && (
        <div
          className="absolute top-0 bottom-0 left-0 w-[2px] rounded-full"
          style={{
            background: beam,
            filter: `drop-shadow(0 0 6px color-mix(in srgb, ${beam} 70%, transparent))`,
          }}
        />
      )}
    </motion.div>
  );
}
