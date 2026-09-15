/**
 * Laser Pointer · 激光教鞭（docs/02 §4.2）
 * 发光点 + 6 颗延迟跟帧的彗尾光点，沿贝塞尔曲线（15% 弧度"手腕感"）
 * 从上一锚点飞到新锚点，450ms，落点炸开一圈小涟漪。
 * 组件在步骤间持久（EffectStage 按特效名 key 化），因此"上一锚点"就是当前头点位置。
 */
"use client";

import { useEffect, useRef, useState } from "react";
import {
  animate,
  motion,
  motionValue,
  useMotionValue,
  useMotionValueEvent,
} from "motion/react";
import type { EffectProps } from "@/lib/effects/registry";
import { useAnchorRect } from "./use-anchor-rect";
import { beamColorVar, useFx } from "./fx-context";

const TRAIL = 6;
const FLIGHT_MS = 450;

export default function LaserPointer({ target, color }: EffectProps) {
  const rect = useAnchorRect(target);
  const { reduced } = useFx();

  const headX = useMotionValue(-100);
  const headY = useMotionValue(-100);
  const tails = useRef(
    Array.from({ length: TRAIL }, () => ({ x: motionValue(-100), y: motionValue(-100) })),
  ).current;
  const placedRef = useRef(false);
  const [ripple, setRipple] = useState<{ x: number; y: number; key: number } | null>(null);

  // 彗尾：每颗以递减刚度的 spring 追头点，形成延迟拖尾
  useMotionValueEvent(headX, "change", (x) => {
    tails.forEach((t, i) => {
      animate(t.x, x, { type: "spring", stiffness: 900 - i * 120, damping: 40, mass: 0.4 });
    });
  });
  useMotionValueEvent(headY, "change", (y) => {
    tails.forEach((t, i) => {
      animate(t.y, y, { type: "spring", stiffness: 900 - i * 120, damping: 40, mass: 0.4 });
    });
  });

  useEffect(() => {
    if (!rect) return;
    const toX = rect.left + rect.width / 2;
    const toY = rect.top + rect.height / 2;

    // 首次落点或降级：直接落位，不飞行
    if (!placedRef.current || reduced) {
      headX.set(toX);
      headY.set(toY);
      tails.forEach((t) => {
        t.x.set(toX);
        t.y.set(toY);
      });
      placedRef.current = true;
      if (!reduced) setRipple({ x: toX, y: toY, key: Date.now() });
      return;
    }

    // 贝塞尔飞行：控制点取中垂线 15% 弧度的偏移
    const fromX = headX.get();
    const fromY = headY.get();
    const dx = toX - fromX;
    const dy = toY - fromY;
    const cx = (fromX + toX) / 2 - dy * 0.15;
    const cy = (fromY + toY) / 2 + dx * 0.15;

    const controls = animate(0, 1, {
      duration: FLIGHT_MS / 1000,
      ease: [0.3, 0.8, 0.3, 1],
      onUpdate: (t) => {
        const u = 1 - t;
        headX.set(u * u * fromX + 2 * u * t * cx + t * t * toX);
        headY.set(u * u * fromY + 2 * u * t * cy + t * t * toY);
      },
      onComplete: () => setRipple({ x: toX, y: toY, key: Date.now() }),
    });
    return () => controls.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rect, reduced]);

  if (!rect) return null;

  const beam = beamColorVar(color ?? "gold");

  return (
    <>
      {/* 彗尾：scale 递减、透明度递减 */}
      {tails.map((t, i) => (
        <motion.div
          key={i}
          className="pointer-events-none fixed top-0 left-0 z-40 rounded-full"
          style={{
            x: t.x,
            y: t.y,
            width: 8,
            height: 8,
            translateX: "-50%",
            translateY: "-50%",
            background: beam,
            opacity: 0.5 * (1 - i / TRAIL),
            scale: 1 - (i / TRAIL) * 0.6,
            filter: `drop-shadow(0 0 4px ${beam})`,
          }}
        />
      ))}
      {/* 教鞭头 */}
      <motion.div
        className="pointer-events-none fixed top-0 left-0 z-40 rounded-full"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0, transition: { duration: 0.2 } }}
        style={{
          x: headX,
          y: headY,
          width: 12,
          height: 12,
          translateX: "-50%",
          translateY: "-50%",
          background: `radial-gradient(circle, #fff 0%, ${beam} 45%, transparent 75%)`,
          filter: `drop-shadow(0 0 8px ${beam})`,
        }}
      />
      {/* 落点涟漪 */}
      {ripple && (
        <motion.div
          key={ripple.key}
          className="pointer-events-none fixed z-40 rounded-full border-2"
          style={{
            left: ripple.x,
            top: ripple.y,
            width: 28,
            height: 28,
            translateX: "-50%",
            translateY: "-50%",
            borderColor: beam,
          }}
          initial={{ scale: 0.3, opacity: 0.8 }}
          animate={{ scale: 1.6, opacity: 0 }}
          transition={{ duration: 0.5, ease: "easeOut" }}
          onAnimationComplete={() => setRipple(null)}
        />
      )}
    </>
  );
}
