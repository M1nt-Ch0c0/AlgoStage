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

/**
 * 字幕条「讲完了」面板是否在显示。备课中（lectureBusy）主按钮仍是「备课中…」，
 * 面板不出现，Space / → 也不按结束面板拦截。页面顶栏、字幕条与播放器键盘共用这一条件。
 */
export function endPanelShowing(state: {
  status: PlayerStatus;
  steps: readonly unknown[];
  currentIndex: number;
  lectureBusy?: boolean;
}): boolean {
  const step = state.steps[state.currentIndex];
  return state.status === "finished" && step != null && !state.lectureBusy;
}

export type StreamGuard = { generation: number; problemSlug?: string };

interface PlayerState {
  status: PlayerStatus;
  receiving: boolean;
  /** 本地重播已有教案；为 true 时不重复上报讲解进度 */
  replaying: boolean;
  script: TeachingScript | null;
  /** 已收到的步骤（流式期间逐步增长） */
  steps: TeachingStep[];
  currentIndex: number;
  generation: number;
  speed: 0.5 | 1 | 1.5 | 2;
  /** 特效强度档位：华丽/克制/极简（docs/02 §5.6） */
  effectLevel: "full" | "calm" | "minimal";
  /** 讲解默认不自动翻页；全局偏好，reset / loadScript / beginStream 不改它 */
  autoAdvance: boolean;
  /** 挂载后才从 localStorage 读入；此前 toggle 用占位，避免服务端与首帧读到旧值 */
  autoAdvanceHydrated: boolean;
  setAutoAdvance: (v: boolean) => void;
  hydrateAutoAdvance: () => void;
  /** 当前步已讲完，等待用户继续；自动翻页关闭时由播放器置位 */
  awaitingContinue: boolean;
  setAwaitingContinue: (v: boolean) => void;

  loadScript: (script: TeachingScript) => void;
  beginStream: (metadata: Omit<TeachingScript, "steps">) => void;
  appendStep: (step: TeachingStep, guard?: StreamGuard) => void;
  updateStep: (step: TeachingStep, guard?: StreamGuard) => void;
  completeStream: (script: TeachingScript, guard?: StreamGuard) => void;
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

export function isStale(
  state: Pick<PlayerState, "generation" | "script">,
  guard?: StreamGuard,
): boolean {
  if (!guard || typeof guard !== "object") return false;
  if (guard.generation !== state.generation) return true;
  if (guard.problemSlug !== undefined && guard.problemSlug !== state.script?.problemSlug) {
    return true;
  }
  return false;
}

export const AUTO_ADVANCE_KEY = "algostage.autoAdvance";
export const SPEED_KEY = "algostage.speed";
export const EFFECT_LEVEL_KEY = "algostage.effectLevel";

/** true 仅当浏览器里该键恰好为 "true"；无 window、读失败或其它值都视为关闭 */
export function readAutoAdvance(): boolean {
  try {
    return typeof window !== "undefined" && window.localStorage.getItem(AUTO_ADVANCE_KEY) === "true";
  } catch {
    return false;
  }
}

export function readSpeed(): 0.5 | 1 | 1.5 | 2 {
  try {
    if (typeof window === "undefined") return 1;
    const raw = window.localStorage.getItem(SPEED_KEY);
    if (raw === null) return 1;
    const parsed = Number(raw);
    if (parsed === 0.5 || parsed === 1 || parsed === 1.5 || parsed === 2) {
      return parsed;
    }
    return 1;
  } catch {
    return 1;
  }
}

export function readEffectLevel(): "full" | "calm" | "minimal" {
  try {
    if (typeof window === "undefined") return "full";
    const raw = window.localStorage.getItem(EFFECT_LEVEL_KEY);
    if (raw === "full" || raw === "calm" || raw === "minimal") {
      return raw;
    }
    return "full";
  } catch {
    return "full";
  }
}

const initial = {
  status: "idle" as PlayerStatus,
  receiving: false,
  replaying: false,
  script: null,
  steps: [] as TeachingStep[],
  currentIndex: 0,
  generation: 0,
  awaitingContinue: false,
};

/** 当前教案题号；无脚本时为 null。供字幕条等不把 problemSlug 写进组件源码的读取。 */
export const selectScriptSlug = (s: { script: TeachingScript | null }) => s.script?.problemSlug ?? null;

export const usePlayerStore = create<PlayerState>((set, get) => ({
  ...initial,
  // 模块初始化不读 localStorage，避免服务端/首帧与挂载后不一致。
  autoAdvance: false,
  autoAdvanceHydrated: false,

  setAutoAdvance: (v) => {
    try {
      if (typeof window !== "undefined") {
        window.localStorage.setItem(AUTO_ADVANCE_KEY, v ? "true" : "false");
      }
    } catch {
      // localStorage 不可用时只更新内存，不把异常抛给调用方
    }
    set({ autoAdvance: v, autoAdvanceHydrated: true });
  },
  hydrateAutoAdvance: () => {
    if (get().autoAdvanceHydrated) return;
    set({ autoAdvance: readAutoAdvance(), autoAdvanceHydrated: true });
  },
  setAwaitingContinue: (v) => set({ awaitingContinue: v }),

  loadScript: (script) =>
    set({
      script,
      receiving: false,
      replaying: false,
      steps: script.steps,
      currentIndex: 0,
      generation: get().generation + 1,
      status: "paused",
      awaitingContinue: false,
    }),

  beginStream: (metadata) =>
    set({
      script: { ...metadata, steps: [] },
      steps: [],
      currentIndex: 0,
      generation: get().generation + 1,
      status: "streaming",
      receiving: true,
      replaying: false,
      awaitingContinue: false,
    }),
  appendStep: (step, guard) =>
    set((s) => {
      if (isStale(get(), guard)) return s;
      const steps = [...s.steps, step];
      const waiting = s.status === "streaming";
      return {
        steps,
        script: s.script ? { ...s.script, steps } : null,
        currentIndex: waiting ? steps.length - 1 : s.currentIndex,
        status: waiting ? "playing" : s.status,
      };
    }),
  updateStep: (step, guard) =>
    set((s) => {
      if (isStale(get(), guard)) return s;
      const steps = s.steps.map((old) => (old.id === step.id ? step : old));
      return { steps, script: s.script ? { ...s.script, steps } : null };
    }),
  completeStream: (script, guard) =>
    set((s) => {
      if (isStale(get(), guard)) return s;
      return {
        script,
        steps: script.steps,
        receiving: false,
        // 已追上最后一步时停在当前步；生成完成不等于播放器不可再操作。
        status: s.status === "streaming" || s.status === "finished" ? "paused" : s.status,
      };
    }),
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
    set((s) => {
      const currentIndex = Math.max(0, Math.min(index, s.steps.length - 1));
      // 点当前时间线节点只是再选中本步，不能清掉「等用户继续」。
      const sameStep = currentIndex === s.currentIndex;
      return {
        currentIndex,
        status: s.status === "finished" ? "paused" : s.status === "streaming" && s.steps.length ? "playing" : s.status,
        awaitingContinue: sameStep ? s.awaitingContinue : false,
      };
    }),

  interrupt: () => set({ status: "interrupted", awaitingContinue: false }),
  resume: () => set({ status: "paused" }),

  setSpeed: (speed) => {
    try {
      if (typeof window !== "undefined") {
        window.localStorage.setItem(SPEED_KEY, String(speed));
      }
    } catch {
      // localStorage 不可用时只更新内存，不把异常抛给调用方
    }
    set({ speed });
  },
  setEffectLevel: (effectLevel) => {
    try {
      if (typeof window !== "undefined") {
        window.localStorage.setItem(EFFECT_LEVEL_KEY, effectLevel);
      }
    } catch {
      // localStorage 不可用时只更新内存，不把异常抛给调用方
    }
    set({ effectLevel });
  },

  reset: () => set({ ...initial, autoAdvance: get().autoAdvance, generation: get().generation + 1 }),
}));
