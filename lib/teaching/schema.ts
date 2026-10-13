/**
 * TeachingScript 的 zod 校验（docs/03 §5）
 * AI 输出经此 schema 强约束，校验失败自动重试一次。
 */
import { z } from "zod";
import { EFFECT_WHITELIST } from "./types";

export const effectTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("code-line"), start: z.number().int().min(1), end: z.number().int().min(1).optional() }),
  z.object({ kind: z.literal("code-token"), line: z.number().int().min(1), match: z.string() }),
  z.object({ kind: z.literal("statement"), blockId: z.string() }),
  z.object({ kind: z.literal("viz-node"), nodeId: z.string() }),
  z.object({ kind: z.literal("dom"), selector: z.string() }),
]);

const beamColor = z.enum(["gold", "cyan", "violet", "rose", "mint"]);

export const effectCallSchema = z.object({
  effect: z.enum(EFFECT_WHITELIST),
  targetIndex: z.number().int().min(0).optional(),
  color: beamColor.optional(),
  intensity: z.enum(["whisper", "normal", "shout"]).optional(),
  params: z.record(z.string(), z.unknown()).optional(),
});

/** 当前仅实现数组可视化；未知类型直接拒绝，避免未校验状态流入播放器。 */
export const arrayVizStateSchema = z.object({
  values: z.array(z.number().finite()),
  highlight: z.array(z.number().int().min(0)).optional(),
  map: z.record(z.string(), z.number().int().min(0)).optional(),
  scan: z.number().int().min(-1).optional(),
  hit: z.boolean().optional(),
}).superRefine((state, ctx) => {
  const inRange = (index: number) => index < state.values.length;
  state.highlight?.forEach((index, i) => {
    if (!inRange(index)) ctx.addIssue({ code: "custom", message: "高亮位置超出数组", path: ["highlight", i] });
  });
  for (const [key, index] of Object.entries(state.map ?? {})) {
    if (!inRange(index)) ctx.addIssue({ code: "custom", message: "哈希表位置超出数组", path: ["map", key] });
  }
  if (state.scan !== undefined && state.scan !== -1 && !inRange(state.scan)) {
    ctx.addIssue({ code: "custom", message: "扫描位置超出数组", path: ["scan"] });
  }
});

export const arrayVizFrameSchema = z.object({
  type: z.literal("array"),
  state: arrayVizStateSchema,
  captions: z.array(z.object({ nodeId: z.string(), text: z.string() })).optional(),
});

export type ArrayVizState = z.infer<typeof arrayVizStateSchema>;
export type ArrayVizFrame = z.infer<typeof arrayVizFrameSchema>;

export const teachingStepSchema = z.object({
  id: z.string(),
  narration: z.string().min(1),
  targets: z.array(effectTargetSchema).min(1),
  effects: z.array(effectCallSchema).default([]),
  viz: arrayVizFrameSchema.optional(),
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
