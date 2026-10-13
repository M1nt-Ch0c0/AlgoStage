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
  receiving: boolean;
  /** 本地重播已有教案；为 true 时不重复上报讲解进度 */
  replaying: boolean;
  script: TeachingScript | null;
  /** 已收到的步骤（流式期间逐步增长） */
  steps: TeachingStep[];
  currentIndex: number;
  speed: 0.5 | 1 | 1.5 | 2;
  /** 特效强度档位：华丽/克制/极简（docs/02 §5.6） */
  effectLevel: "full" | "calm" | "minimal";
  /** 讲解默认不自动翻页；全局偏好，reset / loadScript / beginStream 不改它 */
  autoAdvance: boolean;
  setAutoAdvance: (v: boolean) => void;
  /** 当前步已讲完，等待用户继续；自动翻页关闭时由播放器置位 */
  awaitingContinue: boolean;
  setAwaitingContinue: (v: boolean) => void;

  loadScript: (script: TeachingScript) => void;
  beginStream: (metadata: Omit<TeachingScript, "steps">) => void;
  appendStep: (step: TeachingStep) => void;
  updateStep: (step: TeachingStep) => void;
  completeStream: (script: TeachingScript) => void;
  stopStream: () => void;
  play: () => void;
  pause: () => void;
  /** 完成态从第 0 步本地重播已生成的教案，不发起任何请求 */
  replay: () => void;
  next: () => void;
  prev: () => void;
  goto: (index: number) => void;
  interrupt: () => void;
  resume: () => void;
  setSpeed: (speed: PlayerState["speed"]) => void;
  setEffectLevel: (level: PlayerState["effectLevel"]) => void;
  reset: () => void;
}

export const AUTO_ADVANCE_KEY = "algostage.autoAdvance";

/** true 仅当浏览器里该键恰好为 "true"；无 window、读失败或其它值都视为关闭 */
export function readAutoAdvance(): boolean {
  try {
    return typeof window !== "undefined" && window.localStorage.getItem(AUTO_ADVANCE_KEY) === "true";
  } catch {
    return false;
  }
}

const initial = {
  status: "idle" as PlayerStatus,
  receiving: false,
  replaying: false,
  script: null,
  steps: [] as TeachingStep[],
  currentIndex: 0,
  speed: 1 as const,
  effectLevel: "full" as const,
  awaitingContinue: false,
};

/** 当前教案题号；无脚本时为 null。供字幕条等不把 problemSlug 写进组件源码的读取。 */
export const selectScriptSlug = (s: { script: TeachingScript | null }) => s.script?.problemSlug ?? null;

export const usePlayerStore = create<PlayerState>((set, get) => ({
  ...initial,
  autoAdvance: readAutoAdvance(),

  setAutoAdvance: (v) => {
    try {
      if (typeof window !== "undefined") {
        window.localStorage.setItem(AUTO_ADVANCE_KEY, v ? "true" : "false");
      }
    } catch {
      // localStorage 不可用时只更新内存，不把异常抛给调用方
    }
    set({ autoAdvance: v });
  },
  setAwaitingContinue: (v) => set({ awaitingContinue: v }),

  loadScript: (script) =>
    set({
      script,
      receiving: false,
      replaying: false,
      steps: script.steps,
      currentIndex: 0,
      status: "paused",
      awaitingContinue: false,
    }),

  beginStream: (metadata) =>
    set({
      script: { ...metadata, steps: [] },
      steps: [],
      currentIndex: 0,
      status: "streaming",
      receiving: true,
      replaying: false,
      awaitingContinue: false,
    }),
  appendStep: (step) =>
    set((s) => {
      const steps = [...s.steps, step];
      const waiting = s.status === "streaming";
      return {
        steps,
        script: s.script ? { ...s.script, steps } : null,
        currentIndex: waiting ? steps.length - 1 : s.currentIndex,
        status: waiting ? "playing" : s.status,
      };
    }),
  updateStep: (step) =>
    set((s) => {
      const steps = s.steps.map((old) => (old.id === step.id ? step : old));
      return { steps, script: s.script ? { ...s.script, steps } : null };
    }),
  completeStream: (script) =>
    set((s) => ({
      script,
      steps: script.steps,
      receiving: false,
      // 已追上最后一步时停在当前步；生成完成不等于播放器不可再操作。
      status: s.status === "streaming" || s.status === "finished" ? "paused" : s.status,
    })),
  stopStream: () =>
    set((s) => ({
      receiving: false,
      status: s.steps.length ? "paused" : "idle",
    })),

  play: () => {
    const { status, steps, currentIndex } = get();
    if (status === "paused" || status === "idle" || status === "interrupted" || status === "finished") {
      set({
        status: steps.length ? "playing" : "streaming",
        currentIndex: steps[currentIndex] ? currentIndex : 0,
        awaitingContinue: false,
      });
      return;
    }
    set({ awaitingContinue: false });
  },

  pause: () => set({ status: "paused", awaitingContinue: false }),

  replay: () => {
    const { steps, receiving } = get();
    // 只重播完整教案；流式中或无步骤时不动，重新生成走页面的备课流程。
    if (!steps.length || receiving) {
      set({ awaitingContinue: false });
      return;
    }
    set({ currentIndex: 0, status: "playing", replaying: true, awaitingContinue: false });
  },

  next: () =>
    set((s) => {
      const nextIndex = s.currentIndex + 1;
      if (nextIndex >= s.steps.length) {
        // 流式中后面可能还有步骤；非流式则结束
        if (s.receiving) return { status: "streaming", awaitingContinue: false };
        // 重播播完即退出重播态，之后回看按正常进度上报
        return { status: "finished", replaying: false, awaitingContinue: false };
      }
      // 等待继续时仍按普通翻页前进，播放态保持 playing
      return { currentIndex: nextIndex, awaitingContinue: false };
    }),

  prev: () =>
    set((s) => ({
      currentIndex: Math.max(0, s.currentIndex - 1),
      status: s.status === "finished" ? "paused" : s.status === "streaming" && s.steps.length ? "playing" : s.status,
      awaitingContinue: false,
    })),

  goto: (index) =>
    set((s) => ({
      currentIndex: Math.max(0, Math.min(index, s.steps.length - 1)),
      status: s.status === "finished" ? "paused" : s.status === "streaming" && s.steps.length ? "playing" : s.status,
      awaitingContinue: false,
    })),

  interrupt: () => set({ status: "interrupted", awaitingContinue: false }),
  resume: () => set({ status: "paused" }),

  setSpeed: (speed) => set({ speed }),
  setEffectLevel: (effectLevel) => set({ effectLevel }),

  reset: () => set({ ...initial, autoAdvance: get().autoAdvance }),
}));
