/**
 * 讲解播放器状态机 · 详见 docs/02 §5.4、docs/03 §5
 * 高频状态走 Zustand，脱离 React 渲染热路径。
 * 提问 slice 与播放器共用一次 set（M5 D1）。
 */
import { create } from "zustand";
import { appendAnswer } from "@/lib/ask/answers";
import type { AnswerSegment, AskSelectionSummary, StepAnswer, StepAnswersMap } from "@/lib/ask/types";
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

export type AskPhase =
  | "idle"
  | "selecting"
  | "drafting"
  | "sending"
  | "streaming"
  | "playing"
  | "done"
  | "error";

export type AskDisabledReason = "builtin" | "receiving" | "unfinished" | "stepDisabled" | "busy";

export interface LectureAnswerMeta {
  cacheKey: string;
  scriptVersion: string;
  askDisabledStepIds: string[];
  storageMode: "pending" | "server" | "browser";
}

export interface AskContext {
  stepId: string;
  stepIndex: number;
  prevStatus: PlayerStatus;
  prevAwaitingContinue: boolean;
  answerId: string | null;
  segmentIndex: number;
  token: number | null;
}

export interface AskRequestGuard extends StreamGuard {
  cacheKey: string;
  scriptVersion: string;
  stepId: string;
  token: number;
}

export interface PendingEnterIntent {
  stepId: string;
  generation: number;
}

export interface AskAvailability {
  visible: boolean;
  disabled: boolean;
  reason: AskDisabledReason | null;
}

const EMPTY_ANSWER_META: LectureAnswerMeta = {
  cacheKey: "",
  scriptVersion: "",
  askDisabledStepIds: [],
  storageMode: "pending",
};

function emptyAnswers(): StepAnswersMap {
  return Object.create(null) as StepAnswersMap;
}

/** 前台发送 / 流式 / 播放占用入口。selecting、drafting、error 不算 busy。 */
const BUSY_PHASES: ReadonlySet<AskPhase> = new Set(["sending", "streaming", "playing"]);

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
  speedUserSet: boolean;
  effectLevelUserSet: boolean;
  prefsHydrated: boolean;
  hydratePrefs: () => void;
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
  setSpeed: (speed: PlayerState["speed"]) => boolean;
  setEffectLevel: (level: PlayerState["effectLevel"]) => boolean;
  reset: () => void;

  askPhase: AskPhase;
  /**
   * 这次提问截图失败。挂在 store 上，避免回答落地把 phase 拉到 playing、
   * 面板按阶段卸载后本地 state 把「没截到图」提示丢掉。
   */
  askCaptureFallback: boolean;
  askContext: AskContext | null;
  answerMeta: LectureAnswerMeta;
  answers: StepAnswersMap;
  answersReady: boolean;
  expandedAnswerIds: Set<string>;
  selection: AskSelectionSummary | null;
  draftQuestion: string;
  draftStepId: string | null;
  previewSegments: AnswerSegment[];
  askErrorCode: string | null;
  askErrorRetryable: boolean;
  askPlaybackRun: number;
  askPlaybackPaused: boolean;
  askStartedAt: number | null;
  pendingEnterIntent: PendingEnterIntent | null;
  /** 内置课（TWO_SUM 本地加载、无 cacheKey）。页面在装载时写入。 */
  askBuiltin: boolean;
  /** 讲课中断且没有 cacheKey/scriptVersion。页面在装载时写入。 */
  askUnfinished: boolean;

  /** 非 pending 时等价 enterAsk；pending 只记意图，身份落定后由 flush 进入。 */
  requestEnterAsk: () => void;
  /** 身份落定后消化 pendingEnterIntent。不可用时返回 reason 并清意图；已进入或无意图返回 null。 */
  flushPendingEnterAsk: () => AskDisabledReason | null;
  enterAsk: () => void;
  setAskSelection: (selection: AskSelectionSummary) => void;
  setAskQuestion: (question: string) => void;
  /** resize：selecting/drafting/error → selecting，清选区，保留问题与 draftStepId。 */
  clearAskSelection: () => void;
  closeAskPanel: () => void;
  exitAsk: () => void;
  askSent: (guard: AskRequestGuard) => void;
  askStarted: (answerId: string, guard: AskRequestGuard) => void;
  answerSegmentArrived: (segment: AnswerSegment, guard: AskRequestGuard) => void;
  answerArrived: (answer: StepAnswer, guard: AskRequestGuard) => void;
  answerFailed: (code: string, retryable: boolean, guard: AskRequestGuard) => void;
  askCancelled: (guard: AskRequestGuard) => void;
  playAnswer: (answerId: string) => void;
  nextAnswerSegment: (run: number) => void;
  setAnswerPlaybackPaused: (paused: boolean) => void;
  returnToStep: () => void;
  toggleAnswer: (answerId: string) => void;
  setAnswers: (map: StepAnswersMap) => void;
  clearAnswers: () => void;
  setLectureAnswerMeta: (meta: LectureAnswerMeta) => void;
  setAskBuiltin: (v: boolean) => void;
  setAskUnfinished: (v: boolean) => void;
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

export function writeSpeed(v: PlayerState["speed"]): boolean {
  try {
    if (typeof window === "undefined") return false;
    window.localStorage.setItem(SPEED_KEY, String(v));
    return true;
  } catch {
    return false;
  }
}

export function writeEffectLevel(v: PlayerState["effectLevel"]): boolean {
  try {
    if (typeof window === "undefined") return false;
    window.localStorage.setItem(EFFECT_LEVEL_KEY, v);
    return true;
  } catch {
    return false;
  }
}

const initial = {
  status: "idle" as PlayerStatus,
  receiving: false,
  replaying: false,
  script: null as TeachingScript | null,
  steps: [] as TeachingStep[],
  currentIndex: 0,
  generation: 0,
  speed: 1 as PlayerState["speed"],
  effectLevel: "full" as PlayerState["effectLevel"],
  awaitingContinue: false,
};

const askInitial = {
  askPhase: "idle" as AskPhase,
  askCaptureFallback: false,
  askContext: null as AskContext | null,
  answerMeta: { ...EMPTY_ANSWER_META, askDisabledStepIds: [] as string[] },
  answers: emptyAnswers(),
  answersReady: false,
  expandedAnswerIds: new Set<string>(),
  selection: null as AskSelectionSummary | null,
  draftQuestion: "",
  draftStepId: null as string | null,
  previewSegments: [] as AnswerSegment[],
  askErrorCode: null as string | null,
  askErrorRetryable: false,
  askPlaybackRun: 0,
  askPlaybackPaused: false,
  askStartedAt: null as number | null,
  pendingEnterIntent: null as PendingEnterIntent | null,
  askBuiltin: false,
  askUnfinished: false,
};

type AskMemory = typeof askInitial;

/** 当前教案题号；无脚本时为 null。供字幕条等不把 problemSlug 写进组件源码的读取。 */
export const selectScriptSlug = (s: { script: TeachingScript | null }) => s.script?.problemSlug ?? null;

function currentStep(state: Pick<PlayerState, "steps" | "currentIndex">): TeachingStep | undefined {
  return state.steps[state.currentIndex];
}

/**
 * 入口是否可见、置灰及原因。pending 不是 reason。
 * 顺序：builtin → receiving → unfinished → stepDisabled → busy。
 */
export function selectAskAvailability(
  state: Pick<
    PlayerState,
    | "script"
    | "steps"
    | "currentIndex"
    | "receiving"
    | "askBuiltin"
    | "askUnfinished"
    | "answerMeta"
    | "askPhase"
  >,
): AskAvailability {
  const step = currentStep(state);
  if (state.script == null || step == null) {
    return { visible: false, disabled: true, reason: null };
  }
  if (state.askBuiltin) return { visible: true, disabled: true, reason: "builtin" };
  if (state.receiving) return { visible: true, disabled: true, reason: "receiving" };
  if (state.askUnfinished) return { visible: true, disabled: true, reason: "unfinished" };
  if (state.answerMeta.askDisabledStepIds.includes(step.id)) {
    return { visible: true, disabled: true, reason: "stepDisabled" };
  }
  if (BUSY_PHASES.has(state.askPhase)) return { visible: true, disabled: true, reason: "busy" };
  return { visible: true, disabled: false, reason: null };
}

/**
 * 回答正在播放的当前段。targets / effects / viz 只在这段非空时临时覆盖原步。
 */
export function selectAskPresentation(
  state: Pick<PlayerState, "askPhase" | "askContext" | "answers">,
): AnswerSegment | null {
  if (state.askPhase !== "playing" || state.askContext == null) return null;
  const { stepId, answerId, segmentIndex } = state.askContext;
  if (answerId == null || segmentIndex < 0) return null;
  const list = state.answers[stepId];
  if (!list) return null;
  const answer = list.find((item) => item.id === answerId);
  return answer?.segments[segmentIndex] ?? null;
}

function isForegroundGuard(state: PlayerState, guard: AskRequestGuard): boolean {
  return (
    state.askContext != null &&
    state.askContext.token === guard.token &&
    state.askContext.stepId === guard.stepId
  );
}

/** 教案已废弃，或答案身份与当前 meta 不一致。后台请求不要求 askContext.token。 */
function isAskGuardRejected(state: PlayerState, guard: AskRequestGuard): boolean {
  if (isStale(state, guard)) return true;
  if (!state.answersReady) return true;
  if (guard.cacheKey !== state.answerMeta.cacheKey) return true;
  if (guard.scriptVersion !== state.answerMeta.scriptVersion) return true;
  return false;
}

function freshAskMemory(playbackRun: number): AskMemory {
  return {
    ...askInitial,
    answerMeta: { ...EMPTY_ANSWER_META, askDisabledStepIds: [] },
    answers: emptyAnswers(),
    expandedAnswerIds: new Set<string>(),
    previewSegments: [],
    askPlaybackRun: playbackRun,
  };
}

/** 换步 / 跳走 / 重播：丢掉前台草稿、选区、上下文、预览和错误，保留 answers。 */
function clearForegroundDraft(): Pick<
  PlayerState,
  | "askPhase"
  | "askCaptureFallback"
  | "askContext"
  | "selection"
  | "draftQuestion"
  | "draftStepId"
  | "previewSegments"
  | "askErrorCode"
  | "askErrorRetryable"
  | "askStartedAt"
  | "askPlaybackPaused"
  | "pendingEnterIntent"
> {
  return {
    askPhase: "idle",
    askCaptureFallback: false,
    askContext: null,
    selection: null,
    draftQuestion: "",
    draftStepId: null,
    previewSegments: [],
    askErrorCode: null,
    askErrorRetryable: false,
    askStartedAt: null,
    askPlaybackPaused: false,
    pendingEnterIntent: null,
  };
}

function findAnswer(state: PlayerState, answerId: string): StepAnswer | undefined {
  const step = currentStep(state);
  if (!step) return undefined;
  return state.answers[step.id]?.find((item) => item.id === answerId);
}

/**
 * 进入提问。不可用或已有前台流程时返回 reason 且不改状态。
 * error 重进保留原来记下的 prevStatus，避免把 interrupted 再存一次。
 */
function applyEnterAsk(state: PlayerState): Partial<PlayerState> | AskDisabledReason {
  const availability = selectAskAvailability(state);
  if (!availability.visible || availability.disabled) {
    return availability.reason ?? "busy";
  }
  if (state.askPhase === "sending" || state.askPhase === "streaming" || state.askPhase === "playing") {
    return "busy";
  }
  if (state.askPhase !== "idle" && state.askPhase !== "done" && state.askPhase !== "error") {
    return "busy";
  }
  const step = currentStep(state);
  if (!step) return "busy";

  const keepDraft = state.draftStepId === step.id;
  const resumeError =
    state.askPhase === "error" &&
    state.askContext != null &&
    state.askContext.stepId === step.id &&
    state.askContext.stepIndex === state.currentIndex;

  const selection = keepDraft ? state.selection : null;
  const hasSelection = selection != null && selection.targets.length > 0;

  const askContext: AskContext = resumeError
    ? {
        ...state.askContext!,
        answerId: null,
        segmentIndex: -1,
        token: null,
      }
    : {
        stepId: step.id,
        stepIndex: state.currentIndex,
        prevStatus: state.status,
        prevAwaitingContinue: state.awaitingContinue,
        answerId: null,
        segmentIndex: -1,
        token: null,
      };

  return {
    askPhase: hasSelection ? "drafting" : "selecting",
    askCaptureFallback: false,
    askContext,
    status: "interrupted",
    awaitingContinue: false,
    selection,
    draftQuestion: keepDraft ? state.draftQuestion : "",
    draftStepId: keepDraft ? state.draftStepId : null,
    previewSegments: [],
    askErrorCode: null,
    askErrorRetryable: false,
    askPlaybackPaused: false,
    askStartedAt: null,
    pendingEnterIntent: null,
  };
}

/** 未完成请求改后台：不 abort、不增加 generation。播放中的回答另停 run。 */
function applyBackgroundize(state: PlayerState, bumpRun: boolean): Partial<PlayerState> {
  return {
    ...clearForegroundDraft(),
    ...(bumpRun
      ? { askPlaybackRun: state.askPlaybackRun + 1, expandedAnswerIds: new Set<string>() }
      : {}),
  };
}

/** 圈选中禁止换步。同一步 goto 不清提问字段。 */
function blockStepChange(state: PlayerState, targetIndex: number): boolean {
  if (targetIndex === state.currentIndex) return false;
  return state.askPhase === "selecting" || state.askPhase === "drafting";
}

function settleAfterStepChange(
  state: PlayerState,
  targetIndex: number,
  playerPatch: Partial<PlayerState>,
): Partial<PlayerState> {
  if (targetIndex === state.currentIndex) return playerPatch;
  const phase = state.askPhase;
  if (phase === "sending" || phase === "streaming") {
    return { ...playerPatch, ...clearForegroundDraft(), status: "paused", awaitingContinue: false };
  }
  if (phase === "playing") {
    return {
      ...playerPatch,
      ...clearForegroundDraft(),
      askPlaybackRun: state.askPlaybackRun + 1,
      status: "paused",
      awaitingContinue: false,
    };
  }
  if (phase === "idle" || phase === "done" || phase === "error") {
    const uninterrupt = phase === "error" ? { status: "paused" as const } : {};
    return {
      ...playerPatch,
      ...uninterrupt,
      ...clearForegroundDraft(),
      askPhase: "idle",
    };
  }
  return playerPatch;
}

export const usePlayerStore = create<PlayerState>((set, get) => ({
  ...initial,
  ...askInitial,
  answers: emptyAnswers(),
  expandedAnswerIds: new Set<string>(),
  // 模块初始化不读 localStorage，避免服务端/首帧与挂载后不一致。
  autoAdvance: false,
  autoAdvanceHydrated: false,
  speedUserSet: false,
  effectLevelUserSet: false,
  prefsHydrated: false,

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
  hydratePrefs: () => {
    if (get().prefsHydrated) return;
    const { speedUserSet, effectLevelUserSet } = get();
    set({
      ...(speedUserSet ? {} : { speed: readSpeed() }),
      ...(effectLevelUserSet ? {} : { effectLevel: readEffectLevel() }),
      prefsHydrated: true,
    });
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
      // 页面在成功装载后另调 setAnswers / setLectureAnswerMeta。这里只清前台提问。
      ...clearForegroundDraft(),
      expandedAnswerIds: new Set<string>(),
      askPlaybackRun: get().askPlaybackRun + 1,
      askPlaybackPaused: false,
      answersReady: false,
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
      // REGEN_CONFIRM_OK：answersReady=false，旧 answers 留在内存但不展示。
      ...clearForegroundDraft(),
      expandedAnswerIds: new Set<string>(),
      askPlaybackRun: get().askPlaybackRun + 1,
      answersReady: false,
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
    const state = get();
    const { status, steps, currentIndex, askPhase } = state;
    if (
      askPhase === "selecting" ||
      askPhase === "drafting" ||
      askPhase === "sending" ||
      askPhase === "streaming" ||
      askPhase === "error"
    ) {
      return;
    }
    if (askPhase === "playing") {
      set({ askPlaybackPaused: false });
      return;
    }
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

  pause: () => {
    const { askPhase } = get();
    if (askPhase === "playing") {
      set({ askPlaybackPaused: true });
      return;
    }
    if (
      askPhase === "selecting" ||
      askPhase === "drafting" ||
      askPhase === "sending" ||
      askPhase === "streaming" ||
      askPhase === "error"
    ) {
      return;
    }
    set({ status: "paused", awaitingContinue: false });
  },

  replay: () => {
    const state = get();
    const { steps, receiving, askPhase } = state;
    // 圈选中、流式中或无步骤时不动，重新生成走页面的备课流程。
    if (!steps.length || receiving || askPhase === "selecting" || askPhase === "drafting") {
      return;
    }
    const stopPlayback = askPhase === "playing" || askPhase === "done";
    set({
      ...applyBackgroundize(state, stopPlayback),
      expandedAnswerIds: new Set<string>(),
      currentIndex: 0,
      status: "playing",
      replaying: true,
      awaitingContinue: false,
    });
  },

  next: () =>
    set((s) => {
      // 回答播放时控件转下一段，不推进原课。
      if (s.askPhase === "playing") {
        if (s.askPlaybackPaused || s.askContext == null) return s;
        const presented = selectAskPresentation(s);
        if (!presented) return s;
        const answer = s.answers[s.askContext.stepId]?.find((item) => item.id === s.askContext!.answerId);
        const segments = answer?.segments ?? [];
        const nextSegment = s.askContext.segmentIndex + 1;
        if (nextSegment >= segments.length) {
          return {
            askPhase: "done",
            status: "paused",
            awaitingContinue: true,
            askContext: { ...s.askContext, segmentIndex: -1, token: null },
            selection: null,
            draftQuestion: "",
            draftStepId: null,
            askPlaybackPaused: false,
            previewSegments: [],
          };
        }
        return { askContext: { ...s.askContext, segmentIndex: nextSegment } };
      }
      if (s.askPhase === "sending" || s.askPhase === "streaming") return s;
      const nextIndex = s.currentIndex + 1;
      if (blockStepChange(s, nextIndex >= s.steps.length ? s.currentIndex : nextIndex) && nextIndex < s.steps.length) {
        return s;
      }
      if (nextIndex >= s.steps.length) {
        // 流式中后面可能还有步骤；非流式则结束。结束不换步，不清草稿。
        if (s.receiving) return { status: "streaming", awaitingContinue: false };
        // 重播播完即退出重播态，之后回看按正常进度上报
        return { status: "finished", replaying: false, awaitingContinue: false };
      }
      const playerPatch = { currentIndex: nextIndex, awaitingContinue: false };
      return settleAfterStepChange(s, nextIndex, playerPatch);
    }),

  prev: () =>
    set((s) => {
      const currentIndex = Math.max(0, s.currentIndex - 1);
      if (blockStepChange(s, currentIndex)) return s;
      // 已在第 0 步时下标不变：不清草稿和 awaitingContinue，但状态仍要落地。
      if (currentIndex === s.currentIndex) {
        if (s.status === "finished") return { status: "paused" };
        if (s.status === "streaming" && s.steps.length) return { status: "playing" };
        return s;
      }
      const playerPatch = {
        currentIndex,
        status: (s.status === "finished"
          ? "paused"
          : s.status === "streaming" && s.steps.length
            ? "playing"
            : s.status) as PlayerStatus,
        awaitingContinue: false,
      };
      return settleAfterStepChange(s, currentIndex, playerPatch);
    }),

  goto: (index) =>
    set((s) => {
      if (!s.steps.length) return s;
      const currentIndex = Math.max(0, Math.min(index, s.steps.length - 1));
      // 点当前时间线节点只是再选中本步：不清 draft / awaitingContinue / backgroundize。
      // PlayerStatus 仍要更新，否则结束后无法继续播、流式等待时点当前步无法开播。
      if (currentIndex === s.currentIndex) {
        if (s.status === "finished") return { status: "paused" };
        if (s.status === "streaming" && s.steps.length) return { status: "playing" };
        return s;
      }
      if (blockStepChange(s, currentIndex)) return s;
      const playerPatch = {
        currentIndex,
        status: (s.status === "finished"
          ? "paused"
          : s.status === "streaming" && s.steps.length
            ? "playing"
            : s.status) as PlayerStatus,
        awaitingContinue: false,
      };
      return settleAfterStepChange(s, currentIndex, playerPatch);
    }),

  interrupt: () => set({ status: "interrupted", awaitingContinue: false }),
  resume: () => {
    const { askPhase } = get();
    if (
      askPhase === "selecting" ||
      askPhase === "drafting" ||
      askPhase === "sending" ||
      askPhase === "streaming" ||
      askPhase === "error"
    ) {
      return;
    }
    if (askPhase === "playing") {
      set({ askPlaybackPaused: false });
      return;
    }
    set({ status: "paused" });
  },

  setSpeed: (speed) => {
    const ok = writeSpeed(speed);
    set({ speed, speedUserSet: true });
    return ok;
  },
  setEffectLevel: (effectLevel) => {
    const ok = writeEffectLevel(effectLevel);
    set({ effectLevel, effectLevelUserSet: true });
    return ok;
  },

  reset: () =>
    set({
      ...initial,
      ...freshAskMemory(get().askPlaybackRun + 1),
      speed: get().speed,
      effectLevel: get().effectLevel,
      autoAdvance: get().autoAdvance,
      autoAdvanceHydrated: get().autoAdvanceHydrated,
      speedUserSet: get().speedUserSet,
      effectLevelUserSet: get().effectLevelUserSet,
      prefsHydrated: get().prefsHydrated,
      generation: get().generation + 1,
    }),

  requestEnterAsk: () => {
    const state = get();
    const step = currentStep(state);
    if (!step || state.script == null) return;
    if (state.answerMeta.storageMode === "pending") {
      set({ pendingEnterIntent: { stepId: step.id, generation: state.generation } });
      return;
    }
    set({ pendingEnterIntent: null });
    const entered = applyEnterAsk(get());
    if (typeof entered !== "string") set(entered);
  },

  flushPendingEnterAsk: () => {
    const state = get();
    const intent = state.pendingEnterIntent;
    if (!intent) return null;
    const step = currentStep(state);
    const stale =
      state.askPhase !== "idle" ||
      step == null ||
      step.id !== intent.stepId ||
      state.generation !== intent.generation ||
      state.answerMeta.storageMode === "pending";
    if (stale) {
      set({ pendingEnterIntent: null });
      return null;
    }
    const availability = selectAskAvailability(state);
    if (!availability.visible || availability.disabled) {
      set({ pendingEnterIntent: null });
      return availability.reason;
    }
    const entered = applyEnterAsk({ ...state, pendingEnterIntent: null });
    if (typeof entered === "string") {
      set({ pendingEnterIntent: null });
      return entered;
    }
    set(entered);
    return null;
  },

  enterAsk: () => {
    const state = get();
    if (state.answerMeta.storageMode === "pending") return;
    const entered = applyEnterAsk(state);
    if (typeof entered !== "string") set(entered);
  },

  setAskSelection: (selection) => {
    const state = get();
    if (
      state.askPhase !== "selecting" &&
      state.askPhase !== "drafting" &&
      state.askPhase !== "error"
    ) {
      return;
    }
    if (selection.targets.length === 0) return;
    const step = currentStep(state);
    if (!step) return;
    set({
      askPhase: "drafting",
      selection,
      draftStepId: step.id,
      status: "interrupted",
      awaitingContinue: false,
      askErrorCode: null,
      askErrorRetryable: false,
    });
  },

  setAskQuestion: (question) => {
    const { askPhase } = get();
    if (askPhase !== "selecting" && askPhase !== "drafting" && askPhase !== "error") return;
    set({ draftQuestion: question });
  },

  clearAskSelection: () => {
    const { askPhase } = get();
    if (askPhase !== "selecting" && askPhase !== "drafting" && askPhase !== "error") return;
    set({
      askPhase: "selecting",
      selection: null,
      askErrorCode: null,
      askErrorRetryable: false,
      status: "interrupted",
      awaitingContinue: false,
    });
  },

  closeAskPanel: () => {
    const { askPhase } = get();
    if (askPhase !== "drafting" && askPhase !== "error") return;
    set({
      askPhase: "selecting",
      askErrorCode: null,
      askErrorRetryable: false,
      status: "interrupted",
      awaitingContinue: false,
    });
  },

  exitAsk: () => {
    const state = get();
    if (state.askPhase !== "selecting" && state.askPhase !== "drafting" && state.askPhase !== "error") {
      return;
    }
    const ctx = state.askContext;
    set({
      askPhase: "idle",
      askCaptureFallback: false,
      status: ctx?.prevStatus ?? "paused",
      awaitingContinue: ctx?.prevAwaitingContinue ?? false,
      askContext: null,
      previewSegments: [],
      askErrorCode: null,
      askErrorRetryable: false,
      askStartedAt: null,
      askPlaybackPaused: false,
      pendingEnterIntent: null,
    });
  },

  askSent: (guard) => {
    const state = get();
    if (state.askPhase !== "drafting" && state.askPhase !== "error") return;
    if (isAskGuardRejected(state, guard)) return;
    const step = currentStep(state);
    if (!step || step.id !== guard.stepId) return;
    if (!state.selection || state.selection.targets.length === 0) return;
    const question = state.draftQuestion.trim();
    if (question.length < 1 || question.length > 300) return;
    const availability = selectAskAvailability({ ...state, askPhase: "idle" });
    if (!availability.visible || availability.disabled) return;
    const base = state.askContext;
    set({
      askPhase: "sending",
      status: "interrupted",
      awaitingContinue: false,
      askContext: {
        stepId: step.id,
        stepIndex: state.currentIndex,
        prevStatus: base?.prevStatus ?? state.status,
        prevAwaitingContinue: base?.prevAwaitingContinue ?? state.awaitingContinue,
        answerId: null,
        segmentIndex: -1,
        token: guard.token,
      },
      previewSegments: [],
      askErrorCode: null,
      askErrorRetryable: false,
      askStartedAt: Date.now(),
      askPlaybackPaused: false,
    });
  },

  askStarted: (answerId, guard) => {
    const state = get();
    if (state.askPhase !== "sending") return;
    if (isAskGuardRejected(state, guard) || !isForegroundGuard(state, guard)) return;
    if (state.askContext?.stepId !== guard.stepId) return;
    set({
      askPhase: "streaming",
      status: "interrupted",
      awaitingContinue: false,
      askContext: state.askContext ? { ...state.askContext, answerId } : state.askContext,
    });
  },

  answerSegmentArrived: (segment, guard) => {
    const state = get();
    if (state.askPhase !== "streaming") return;
    if (isAskGuardRejected(state, guard) || !isForegroundGuard(state, guard)) return;
    set({
      previewSegments: [...state.previewSegments, segment],
      status: "interrupted",
      awaitingContinue: false,
    });
  },

  answerArrived: (answer, guard) => {
    const state = get();
    if (isAskGuardRejected(state, guard)) return;
    if (answer.stepId !== guard.stepId) return;
    const foreground =
      state.askPhase === "streaming" &&
      isForegroundGuard(state, guard) &&
      state.askContext?.stepId === answer.stepId &&
      (state.askContext.answerId == null || state.askContext.answerId === answer.id) &&
      currentStep(state)?.id === answer.stepId;
    const answers = appendAnswer(state.answers, answer);
    if (!foreground) {
      // 截图失败标记留到 exitAsk / 下一次 enterAsk。非前台落地只追加 answers。
      set({ answers });
      return;
    }
    const expanded = new Set(state.expandedAnswerIds);
    expanded.add(answer.id);
    set({
      answers,
      askPhase: "playing",
      status: "interrupted",
      awaitingContinue: false,
      expandedAnswerIds: expanded,
      askContext: state.askContext
        ? { ...state.askContext, segmentIndex: 0, answerId: answer.id }
        : state.askContext,
      askPlaybackRun: state.askPlaybackRun + 1,
      askPlaybackPaused: false,
      previewSegments: [],
      askErrorCode: null,
      askErrorRetryable: false,
      selection: null,
      draftQuestion: "",
      draftStepId: null,
    });
  },

  answerFailed: (code, retryable, guard) => {
    const state = get();
    if (isAskGuardRejected(state, guard)) return;
    const foreground =
      (state.askPhase === "sending" || state.askPhase === "streaming") &&
      isForegroundGuard(state, guard);
    if (!foreground) return;
    set({
      askPhase: "error",
      status: "interrupted",
      awaitingContinue: false,
      previewSegments: [],
      askErrorCode: code,
      askErrorRetryable: retryable,
      askStartedAt: null,
      askContext: state.askContext
        ? { ...state.askContext, answerId: null, segmentIndex: -1, token: null }
        : state.askContext,
    });
  },

  askCancelled: (guard) => {
    const state = get();
    if (state.askPhase !== "sending" && state.askPhase !== "streaming") return;
    if (!isForegroundGuard(state, guard)) return;
    if (isStale(state, guard)) return;
    set({
      askPhase: "drafting",
      status: "interrupted",
      awaitingContinue: false,
      previewSegments: [],
      askErrorCode: null,
      askErrorRetryable: false,
      askStartedAt: null,
      askContext: state.askContext
        ? { ...state.askContext, answerId: null, segmentIndex: -1, token: null }
        : state.askContext,
    });
  },

  playAnswer: (answerId) => {
    const state = get();
    if (state.askPhase !== "idle" && state.askPhase !== "done" && state.askPhase !== "error") return;
    const availability = selectAskAvailability({ ...state, askPhase: "idle" });
    if (!availability.visible || availability.disabled) return;
    const answer = findAnswer(state, answerId);
    const step = currentStep(state);
    if (!answer || !step || answer.segments.length === 0) return;
    const expanded = new Set(state.expandedAnswerIds);
    expanded.add(answerId);
    set({
      askPhase: "playing",
      status: "interrupted",
      awaitingContinue: false,
      expandedAnswerIds: expanded,
      askPlaybackRun: state.askPlaybackRun + 1,
      askPlaybackPaused: false,
      previewSegments: [],
      askErrorCode: null,
      askErrorRetryable: false,
      askStartedAt: null,
      pendingEnterIntent: null,
      askContext: {
        stepId: step.id,
        stepIndex: state.currentIndex,
        prevStatus: state.askPhase === "error" && state.askContext ? state.askContext.prevStatus : state.status,
        prevAwaitingContinue:
          state.askPhase === "error" && state.askContext
            ? state.askContext.prevAwaitingContinue
            : state.awaitingContinue,
        answerId,
        segmentIndex: 0,
        token: null,
      },
    });
  },

  nextAnswerSegment: (run) => {
    const state = get();
    if (state.askPhase !== "playing" || state.askPlaybackPaused) return;
    if (run !== state.askPlaybackRun) return;
    if (!state.askContext || state.askContext.answerId == null) return;
    const answer = state.answers[state.askContext.stepId]?.find((item) => item.id === state.askContext!.answerId);
    if (!answer) return;
    const nextSegment = state.askContext.segmentIndex + 1;
    if (nextSegment < answer.segments.length) {
      set({
        askContext: { ...state.askContext, segmentIndex: nextSegment },
        status: "interrupted",
        awaitingContinue: false,
      });
      return;
    }
    set({
      askPhase: "done",
      status: "paused",
      awaitingContinue: true,
      askContext: { ...state.askContext, segmentIndex: -1, token: null },
      selection: null,
      draftQuestion: "",
      draftStepId: null,
      askPlaybackPaused: false,
      previewSegments: [],
      askCaptureFallback: false,
    });
  },

  setAnswerPlaybackPaused: (paused) => {
    if (get().askPhase !== "playing") return;
    set({ askPlaybackPaused: paused });
  },

  returnToStep: () => {
    const state = get();
    if (state.askPhase === "sending" || state.askPhase === "streaming") {
      set({
        ...clearForegroundDraft(),
        askPhase: "done",
        status: "paused",
        awaitingContinue: true,
        askPlaybackRun: state.askPlaybackRun + 1,
      });
      return;
    }
    if (state.askPhase !== "playing" && state.askPhase !== "done") return;
    const ctx = state.askContext;
    const step = currentStep(state);
    if (ctx && step && (ctx.stepId !== step.id || ctx.stepIndex !== state.currentIndex)) return;
    const expanded = new Set(state.expandedAnswerIds);
    if (ctx?.answerId) expanded.delete(ctx.answerId);
    set({
      askPhase: "done",
      status: "paused",
      awaitingContinue: true,
      askPlaybackRun: state.askPlaybackRun + 1,
      askPlaybackPaused: false,
      expandedAnswerIds: expanded,
      askContext: ctx ? { ...ctx, segmentIndex: -1, token: null } : null,
      previewSegments: [],
      selection: null,
      draftQuestion: "",
      draftStepId: null,
    });
  },

  toggleAnswer: (answerId) => {
    const state = get();
    const step = currentStep(state);
    if (!step) return;
    const belongs = state.answers[step.id]?.some((item) => item.id === answerId) ?? false;
    if (!belongs) return;
    const playingThis =
      state.askPhase === "playing" && state.askContext?.answerId === answerId;
    if (playingThis) {
      const expanded = new Set(state.expandedAnswerIds);
      expanded.delete(answerId);
      set({
        askPhase: "done",
        status: "paused",
        awaitingContinue: true,
        askPlaybackRun: state.askPlaybackRun + 1,
        askPlaybackPaused: false,
        expandedAnswerIds: expanded,
        askContext: state.askContext
          ? { ...state.askContext, segmentIndex: -1, token: null }
          : null,
        previewSegments: [],
        selection: null,
        draftQuestion: "",
        draftStepId: null,
      });
      return;
    }
    if (state.askPhase !== "idle" && state.askPhase !== "done" && state.askPhase !== "error") return;
    const expanded = new Set(state.expandedAnswerIds);
    if (expanded.has(answerId)) expanded.delete(answerId);
    else expanded.add(answerId);
    set({ expandedAnswerIds: expanded });
  },

  setAnswers: (map) => {
    // 不同归属必须走教案装载；这里只替换内存 map 并默认折叠，不清草稿、不改 phase。
    set({ answers: appendAll(map), expandedAnswerIds: new Set<string>() });
  },

  clearAnswers: () => {
    set({
      ...clearForegroundDraft(),
      answers: emptyAnswers(),
      expandedAnswerIds: new Set<string>(),
    });
  },

  setLectureAnswerMeta: (meta) => {
    const prev = get().answerMeta.storageMode;
    set({
      answerMeta: {
        cacheKey: meta.cacheKey,
        scriptVersion: meta.scriptVersion,
        askDisabledStepIds: [...meta.askDisabledStepIds],
        storageMode: meta.storageMode,
      },
    });
    if (prev === "pending" && meta.storageMode !== "pending") {
      get().flushPendingEnterAsk();
    }
  },

  setAskBuiltin: (v) => set({ askBuiltin: v }),
  setAskUnfinished: (v) => set({ askUnfinished: v }),
}));

function appendAll(map: StepAnswersMap): StepAnswersMap {
  let next = emptyAnswers();
  for (const list of Object.values(map)) {
    for (const answer of list) next = appendAnswer(next, answer);
  }
  return next;
}

export function syncPrefsFromStorage(event: StorageEvent): void {
  if (event.key === SPEED_KEY) {
    usePlayerStore.setState({ speed: readSpeed() });
  } else if (event.key === EFFECT_LEVEL_KEY) {
    usePlayerStore.setState({ effectLevel: readEffectLevel() });
  } else if (event.key === null) {
    usePlayerStore.setState({
      speed: readSpeed(),
      effectLevel: readEffectLevel(),
    });
  }
}
