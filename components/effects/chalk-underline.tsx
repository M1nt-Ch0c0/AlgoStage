/**
 * Chalk Underline / Circle · 粉笔划线与圈选（docs/02 §4.3）
 * SVG path 手绘扰动（rough.js 风格自绘，抖动在 path 生成时烘焙，不引依赖）：
 *  - line：目标下方带 ±1.5px 抖动的微波浪下划线
 *  - circle：绕目标的不完美椭圆（起止差 8% 不闭合）
 * Motion pathLength 0→1 画出；画完极轻闪烁一次（粉笔灰落定）→ onDone。
 */
"use client";

import { useMemo } from "react";
import { motion } from "motion/react";
import type { EffectProps } from "@/lib/effects/registry";
import { useAnchorRect } from "./use-anchor-rect";
import { beamColorVar, useFx } from "./fx-context";

/** 确定性伪随机（同一块内容每次生成的笔迹一致，避免重渲染抖动） */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function wobblyLinePath(x0: number, y0: number, x1: number, rand: () => number): string {
  const segments = Math.max(6, Math.round((x1 - x0) / 14));
  let d = `M ${x0.toFixed(1)} ${y0.toFixed(1)}`;
  for (let i = 1; i <= segments; i++) {
    const x = x0 + ((x1 - x0) * i) / segments;
    const wave = Math.sin(i * 1.7) * 0.8;
    const jitter = (rand() - 0.5) * 3; // ±1.5px
    d += ` L ${x.toFixed(1)} ${(y0 + wave + jitter).toFixed(1)}`;
  }
  return d;
}

function wobblyCirclePath(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  rand: () => number,
): string {
  const segments = 28;
  const sweep = Math.PI * 2 * 0.92; // 8% 不闭合
  const startAngle = -Math.PI / 2;
  let d = "";
  for (let i = 0; i <= segments; i++) {
    const a = startAngle + (sweep * i) / segments;
    const jx = (rand() - 0.5) * 3;
    const jy = (rand() - 0.5) * 3;
    const x = cx + (rx + jx) * Math.cos(a);
    const y = cy + (ry + jy) * Math.sin(a);
    d += i === 0 ? `M ${x.toFixed(1)} ${y.toFixed(1)}` : ` L ${x.toFixed(1)} ${y.toFixed(1)}`;
  }
  return d;
}

export default function ChalkUnderline({ target, color, params, onDone }: EffectProps) {
  const rect = useAnchorRect(target);
  const { reduced } = useFx();
  const shape = (params?.shape as "line" | "circle" | undefined) ?? "line";

  // 笔迹路径按锚点尺寸烘焙（含手绘扰动）
  const path = useMemo(() => {
    if (!rect) return null;
    const seed =
      Math.round(rect.left) * 31 + Math.round(rect.top) * 7 + Math.round(rect.width);
    const rand = mulberry32(seed);
    const pad = 6;
    if (shape === "circle") {
      return wobblyCirclePath(
        rect.width / 2,
        rect.height / 2,
        rect.width / 2 + pad,
        rect.height / 2 + pad,
        rand,
      );
    }
    return wobblyLinePath(-2, rect.height + pad, rect.width + 2, rand);
  }, [rect, shape]);

  if (!rect || !path) return null;

  const chalk = beamColorVar(color ?? "violet");
  const pad = 10;
  const duration = reduced ? 0 : shape === "circle" ? 0.7 : 0.55;

  return (
    <motion.svg
      className="pointer-events-none fixed z-40 overflow-visible"
      initial={{ opacity: 0 }}
      animate={{
        opacity: 1,
        top: rect.top - pad,
        left: rect.left - pad,
      }}
      exit={{ opacity: 0, transition: { duration: 0.2 } }}
      transition={{
        default: { duration: 0.35, ease: [0.22, 1, 0.36, 1] },
        opacity: { duration: 0.15 },
      }}
      width={rect.width + pad * 2}
      height={rect.height + pad * 2}
      style={{ filter: `drop-shadow(0 0 3px color-mix(in srgb, ${chalk} 45%, transparent))` }}
    >
      <g transform={`translate(${pad} ${pad})`}>
        {/* 主笔迹 */}
        <motion.path
          d={path}
          fill="none"
          stroke={chalk}
          strokeWidth={3}
          strokeLinecap="round"
          strokeLinejoin="round"
          initial={{ pathLength: 0, opacity: 0.95 }}
          animate={{ pathLength: 1, opacity: [0.95, 0.95, 0.65, 0.95] }}
          transition={{
            pathLength: { duration, ease: "easeOut" },
            opacity: { duration: duration + 0.3, times: [0, 0.8, 0.9, 1] },
          }}
          onAnimationComplete={onDone}
        />
        {/* 粉笔灰复笔：偏移的浅色细痕，制造手写层次 */}
        <motion.path
          d={path}
          fill="none"
          stroke={chalk}
          strokeWidth={1.2}
          strokeLinecap="round"
          opacity={0.35}
          transform="translate(0.8 0.6)"
          initial={{ pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: duration * 1.05, ease: "easeOut" }}
        />
      </g>
    </motion.svg>
  );
}
