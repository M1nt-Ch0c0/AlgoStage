/**
 * Attention Ripple · 注意力涟漪（docs/02 §4.5）
 * 目标四周荡开 3 圈同色圆角矩形波纹（scale 1.0→1.15、opacity 0.6→0，间隔 200ms），
 * 比光束弱一档的轻提醒。whisper 强度只荡 1 圈。
 * 动画用 globals.css 的 attention-ripple 关键帧（只动 transform/opacity）。
 */
"use client";

import { motion } from "motion/react";
import type { EffectProps } from "@/lib/effects/registry";
import { useAnchorRect } from "./use-anchor-rect";
import { beamColorVar, useFx } from "./fx-context";

export default function AttentionRipple({ target, color, intensity }: EffectProps) {
  const rect = useAnchorRect(target);
  const { reduced } = useFx();
  if (!rect) return null;

  const beam = beamColorVar(color);
  const rings = intensity === "whisper" ? 1 : 3;
  const pad = 6;

  return (
    <motion.div
      className="pointer-events-none fixed z-40"
      initial={{ opacity: 0 }}
      animate={{
        opacity: 1,
        top: rect.top - pad,
        left: rect.left - pad,
        width: rect.width + pad * 2,
        height: rect.height + pad * 2,
      }}
      exit={{ opacity: 0, transition: { duration: 0.2 } }}
      transition={{
        default: { duration: 0.35, ease: [0.22, 1, 0.36, 1] },
        opacity: { duration: 0.15 },
      }}
    >
      {Array.from({ length: rings }, (_, i) => (
        <div
          key={i}
          className="absolute inset-0 rounded-lg border-2"
          style={{
            borderColor: beam,
            animation: reduced
              ? "none"
              : `attention-ripple 1.6s ease-out ${i * 0.2}s infinite`,
            opacity: reduced ? 0.5 : 0,
          }}
        />
      ))}
    </motion.div>
  );
}
