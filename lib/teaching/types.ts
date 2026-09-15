/**
 * TeachingScript · 讲解脚本协议类型
 * 协议说明见 docs/03-teaching-protocol.md
 */

export type EffectTarget =
  | { kind: "code-line"; start: number; end?: number }
  | { kind: "code-token"; line: number; match: string }
  | { kind: "statement"; blockId: string }
  | { kind: "viz-node"; nodeId: string }
  | { kind: "dom"; selector: string };

export type BeamColor = "gold" | "cyan" | "violet" | "rose" | "mint";
export type EffectIntensity = "whisper" | "normal" | "shout";

export interface EffectCall {
  /** EffectRegistry 注册名，如 'spotlight-beam' */
  effect: string;
  /** 作用于 targets 的第几个（默认 0） */
  targetIndex?: number;
  color?: BeamColor;
  intensity?: EffectIntensity;
  params?: Record<string, unknown>;
}

export interface VizFrame {
  /** 可视化器类型，对应 VisualizerRegistry 注册名 */
  type: string;
  /** 每帧全量状态，由对应 Visualizer 的 schema 决定 */
  state: unknown;
  captions?: { nodeId: string; text: string }[];
}

export interface TeachingStep {
  id: string;
  /** 讲解文案（markdown 子集：内联 code、加粗），≤60 字 */
  narration: string;
  targets: EffectTarget[];
  effects: EffectCall[];
  viz?: VizFrame;
  /** 默认 true：字幕打完才自动进下一步 */
  awaitNarration?: boolean;
  /** 字幕完成后额外停留 ms，默认 800 */
  dwellMs?: number;
}

export interface TeachingScript {
  problemSlug: string;
  mode: "lecture" | "review";
  language: "zh" | "en";
  solutionLanguage: "typescript" | "python";
  steps: TeachingStep[];
}

/** AI 可用特效白名单（写进系统 prompt，对应 docs/02 §4） */
export const EFFECT_WHITELIST = [
  "spotlight-beam",
  "laser-pointer",
  "chalk-underline",
  "focus-dim",
  "attention-ripple",
  "comparison-split",
] as const;

export type WhitelistEffect = (typeof EFFECT_WHITELIST)[number];
