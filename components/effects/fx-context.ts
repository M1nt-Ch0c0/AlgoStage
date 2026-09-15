/**
 * 特效舞台上下文：强度档位（docs/02 §5.6）+ 系统减少动效偏好（§7）
 * 特效组件通过 useFx() 取降级信息，EffectStage / playground 负责 Provider。
 */
"use client";

import { createContext, useContext, useEffect, useState } from "react";
import type { BeamColor } from "@/lib/teaching/types";

export type EffectLevel = "full" | "calm" | "minimal";

export interface FxContextValue {
  /** 华丽 / 克制 / 极简 */
  level: EffectLevel;
  /** prefers-reduced-motion: reduce */
  reduced: boolean;
}

export const FxContext = createContext<FxContextValue>({
  level: "full",
  reduced: false,
});

export function useFx(): FxContextValue {
  return useContext(FxContext);
}

/** 监听系统减少动效偏好（SSR 安全） */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

/** 特效色 → CSS 变量引用（beam 光谱，globals.css @theme） */
export function beamColorVar(color?: BeamColor): string {
  return `var(--color-beam-${color ?? "gold"})`;
}

/** 强度 → 缩放系数（whisper 收敛 / shout 张扬） */
export function intensityScale(intensity?: "whisper" | "normal" | "shout"): number {
  switch (intensity) {
    case "whisper":
      return 0.7;
    case "shout":
      return 1.3;
    default:
      return 1;
  }
}
