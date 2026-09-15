/**
 * 讲解播放器状态机 · 详见 docs/02 §5.4、docs/03 §5
 * 高频状态走 Zustand，脱离 React 渲染热路径。
 */
import { create } from "zustand";
import type { TeachingScript, TeachingStep } from "@/lib/teaching/types";

export type PlayerStatus =
  | "idle" // 未加载脚本
  | "streaming" // 边收边播中
  | "playing"
  | "paused"
  | "interrupted" // 用户追问，挂起
  | "finished";

interface PlayerState {
  status: PlayerStatus;
  script: TeachingScript | null;
  /** 已收到的步骤（流式期间逐步增长） */
  steps: TeachingStep[];
  currentIndex: number;
  speed: 0.5 | 1 | 1.5 | 2;
  /** 特效强度档位：华丽/克制/极简（docs/02 §5.6） */
  effectLevel: "full" | "calm" | "minimal";

  loadScript: (script: TeachingScript) => void;
  appendStep: (step: TeachingStep) => void;
  play: () => void;
  pause: () => void;
  next: () => void;
  prev: () => void;
  goto: (index: number) => void;
  interrupt: () => void;
  resume: () => void;
  setSpeed: (speed: PlayerState["speed"]) => void;
  setEffectLevel: (level: PlayerState["effectLevel"]) => void;
  reset: () => void;
}

const initial = {
  status: "idle" as PlayerStatus,
  script: null,
  steps: [] as TeachingStep[],
  currentIndex: 0,
  speed: 1 as const,
  effectLevel: "full" as const,
};

export const usePlayerStore = create<PlayerState>((set, get) => ({
  ...initial,

  loadScript: (script) =>
    set({ script, steps: script.steps, currentIndex: 0, status: "paused" }),

  appendStep: (step) =>
    set((s) => ({ steps: [...s.steps, step], status: "streaming" })),

  play: () => {
    const { status } = get();
    if (status === "paused" || status === "idle" || status === "interrupted") {
      set({ status: "playing" });
    }
  },

  pause: () => set({ status: "paused" }),

  next: () =>
    set((s) => {
      const nextIndex = s.currentIndex + 1;
      if (nextIndex >= s.steps.length) {
        // 流式中后面可能还有步骤；非流式则结束
        return { status: s.status === "streaming" ? "streaming" : "finished" };
      }
      return { currentIndex: nextIndex };
    }),

  prev: () => set((s) => ({ currentIndex: Math.max(0, s.currentIndex - 1) })),

  goto: (index) =>
    set((s) => ({
      currentIndex: Math.max(0, Math.min(index, s.steps.length - 1)),
    })),

  interrupt: () => set({ status: "interrupted" }),
  resume: () => set({ status: "paused" }),

  setSpeed: (speed) => set({ speed }),
  setEffectLevel: (effectLevel) => set({ effectLevel }),

  reset: () => set(initial),
}));
