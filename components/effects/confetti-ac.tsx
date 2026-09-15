/**
 * Confetti AC · 通关礼花（docs/02 §4.8）
 * 轻量自研 canvas 粒子（不引 canvas-confetti）：板色系 + 金色纸屑，
 * 重力下坠 + 旋转 + 风摆，1.8s 自然消散。
 * 既作为注册特效（target 锚点中心喷发），也可传 origin 显式指定喷发点（如运行按钮）。
 */
"use client";

import { useEffect, useRef } from "react";
import type { EffectProps } from "@/lib/effects/registry";
import { useFx } from "./fx-context";

const PALETTE = ["#ffd166", "#f4f1e8", "#cfc9b8", "#52e0a4", "#8f887a"];
const COUNT = 120;
const LIFE_MS = 1800;

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  vrot: number;
  w: number;
  h: number;
  color: string;
  swaySeed: number;
}

export interface ConfettiACProps extends EffectProps {
  /** 显式喷发点（viewport 坐标），优先于 target 锚点 */
  origin?: { x: number; y: number };
}

export default function ConfettiAC({ target, origin, onDone }: ConfettiACProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { reduced } = useFx();

  useEffect(() => {
    if (reduced) {
      onDone?.();
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = window.innerWidth * dpr;
    canvas.height = window.innerHeight * dpr;
    ctx.scale(dpr, dpr);

    let raf = 0;
    let cancelled = false;

    // lib/anchors 顶层依赖 DOMRect，仅浏览器端动态加载（SSR 安全）
    import("@/lib/anchors").then(({ resolveAnchor }) => {
      if (cancelled) return;
      const anchorRect = resolveAnchor(target);
      const ox = origin?.x ?? anchorRect.left + anchorRect.width / 2;
      const oy = origin?.y ?? anchorRect.top + anchorRect.height / 2;

      const particles: Particle[] = Array.from({ length: COUNT }, () => {
        const angle = -Math.PI / 2 + (Math.random() - 0.5) * 1.2; // 向上扇形喷出
        const speed = 320 + Math.random() * 420;
        return {
          x: ox,
          y: oy,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          rot: Math.random() * Math.PI * 2,
          vrot: (Math.random() - 0.5) * 12,
          w: 5 + Math.random() * 5,
          h: 7 + Math.random() * 6,
          color: PALETTE[Math.floor(Math.random() * PALETTE.length)],
          swaySeed: Math.random() * Math.PI * 2,
        };
      });

      const start = performance.now();
      let last = start;
      let doneFired = false;

      const tick = (now: number) => {
        const elapsed = now - start;
        const dt = Math.min(0.05, (now - last) / 1000);
        last = now;
        ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);

        const fade = Math.max(0, 1 - Math.max(0, elapsed - 1200) / (LIFE_MS - 1200));
        for (const p of particles) {
          p.vy += 980 * dt; // 重力
          p.x += (p.vx + Math.sin(elapsed / 180 + p.swaySeed) * 36) * dt; // 风摆
          p.y += p.vy * dt;
          p.rot += p.vrot * dt;
          ctx.save();
          ctx.globalAlpha = fade;
          ctx.translate(p.x, p.y);
          ctx.rotate(p.rot);
          ctx.fillStyle = p.color;
          ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
          ctx.restore();
        }

        if (elapsed < LIFE_MS) {
          raf = requestAnimationFrame(tick);
        } else {
          ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
          if (!doneFired) {
            doneFired = true;
            onDone?.();
          }
        }
      };
      raf = requestAnimationFrame(tick);
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduced]);

  if (reduced) return null;
  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none fixed inset-0 z-50 h-full w-full"
    />
  );
}
