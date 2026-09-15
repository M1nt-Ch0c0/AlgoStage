/**
 * Focus Dim · 舞台压暗（docs/02 §4.4）
 * 全屏暗纱 rgba(6,10,9,0.55)，焦点处用 SVG mask 开圆角矩形孔保持明亮；
 * 组件跨步骤持久，开孔位置/尺寸随锚点平滑迁移（形状也在插值）。
 * 使用节制：仅"细讲一段代码"的步骤声明（协议限制一场课 ≤2 次）。
 */
"use client";

import { useId } from "react";
import { motion } from "motion/react";
import type { EffectProps } from "@/lib/effects/registry";
import { useAnchorRect } from "./use-anchor-rect";
import { useFx } from "./fx-context";

const MIGRATE = { duration: 0.35, ease: [0.22, 1, 0.36, 1] as const };

export default function FocusDim({ target }: EffectProps) {
  const rect = useAnchorRect(target);
  const { reduced } = useFx();
  const maskId = useId();
  if (!rect) return null;

  const pad = 12;

  return (
    <motion.svg
      className="pointer-events-none fixed inset-0 z-30 h-full w-full"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.25 } }}
      transition={{ duration: reduced ? 0.15 : 0.3 }}
    >
      <defs>
        <mask id={maskId}>
          <rect x="0" y="0" width="100%" height="100%" fill="white" />
          <motion.rect
            fill="black"
            initial={false}
            animate={{
              x: rect.left - pad,
              y: rect.top - pad,
              width: rect.width + pad * 2,
              height: rect.height + pad * 2,
              rx: 10,
            }}
            transition={reduced ? { duration: 0 } : MIGRATE}
          />
        </mask>
      </defs>
      <rect
        x="0"
        y="0"
        width="100%"
        height="100%"
        fill="rgba(6,10,9,0.55)"
        mask={`url(#${maskId})`}
      />
    </motion.svg>
  );
}
