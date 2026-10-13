import type { EffectCall, EffectTarget, VizFrame } from "@/lib/teaching/types";

export interface AskBBox { x: number; y: number; width: number; height: number }
export type AskTargetKind = "subtitle" | "step" | "code" | "viz" | "handout";
export interface AskTarget {
  kind: AskTargetKind; id: string; stepId?: string;
  codeRange?: { startLine: number; endLine: number };
  vizHit?: { structure: string; nodeIds?: string[]; indices?: number[] };
  text?: string;
}
/** hit-test 输入：AskTarget + 当前 rect（rect 不进请求体） */
export interface AskCandidate { target: AskTarget; rect: AskBBox }
export type AskSelectionMode = "region" | "single";
export interface AskSelection { stepId: string; mode: AskSelectionMode; bbox: AskBBox; targets: AskTarget[]; question: string }
export type AskSelectionSummary = Pick<AskSelection, "mode" | "bbox" | "targets">;
export interface AnswerSegment { id: string; narration: string; targets?: EffectTarget[]; effects?: EffectCall[]; viz?: VizFrame }
export interface StepAnswer { v: 1; id: string; stepId: string; question: string; selection: AskSelectionSummary; segments: AnswerSegment[]; createdAt: string }
export type StepAnswersMap = Record<string, StepAnswer[]>;
export const ASK_LIMITS = { questionMax: 300, targetTextMax: 200, targetsMax: 20, segmentsMax: 8, narrationMax: 120, minTouchPx: 44, dragThresholdPx: 8 } as const;
