/**
 * TeachingScript 的 zod 校验（docs/03 §5）
 * AI 输出经此 schema 强约束，校验失败自动重试一次。
 */
import { z } from "zod";
import { EFFECT_WHITELIST } from "./types";

const effectTarget = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("code-line"), start: z.number().int().min(1), end: z.number().int().min(1).optional() }),
  z.object({ kind: z.literal("code-token"), line: z.number().int().min(1), match: z.string() }),
  z.object({ kind: z.literal("statement"), blockId: z.string() }),
  z.object({ kind: z.literal("viz-node"), nodeId: z.string() }),
  z.object({ kind: z.literal("dom"), selector: z.string() }),
]);

const beamColor = z.enum(["gold", "cyan", "violet", "rose", "mint"]);

const effectCall = z.object({
  effect: z.enum(EFFECT_WHITELIST),
  targetIndex: z.number().int().min(0).optional(),
  color: beamColor.optional(),
  intensity: z.enum(["whisper", "normal", "shout"]).optional(),
  params: z.record(z.string(), z.unknown()).optional(),
});

const vizFrame = z.object({
  type: z.string(),
  state: z.unknown(),
  captions: z.array(z.object({ nodeId: z.string(), text: z.string() })).optional(),
});

export const teachingStepSchema = z.object({
  id: z.string(),
  narration: z.string().min(1),
  targets: z.array(effectTarget).min(1),
  effects: z.array(effectCall).default([]),
  viz: vizFrame.optional(),
  awaitNarration: z.boolean().optional(),
  dwellMs: z.number().int().min(0).optional(),
});

export const teachingScriptSchema = z.object({
  problemSlug: z.string(),
  mode: z.enum(["lecture", "review"]),
  language: z.enum(["zh", "en"]),
  solutionLanguage: z.enum(["typescript", "python"]),
  steps: z.array(teachingStepSchema).min(1),
});
