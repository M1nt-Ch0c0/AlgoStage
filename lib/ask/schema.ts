/**
 * Ask 协议的 zod 校验。
 * effectTargetSchema / effectCallSchema 从 lib/teaching/schema.ts 导入，与教案共用同一引用。
 * 非数组 viz 静默丢掉（保留文字），不算失败。
 */
import { z } from "zod";
import { arrayVizFrameSchema, effectCallSchema, effectTargetSchema } from "@/lib/teaching/schema";
import { ASK_LIMITS } from "@/lib/ask/types";

const finite = z.number().finite();

export const askBBoxSchema = z.object({
  x: finite,
  y: finite,
  width: finite.min(0),
  height: finite.min(0),
});

export const askTargetSchema = z.object({
  kind: z.enum(["subtitle", "step", "code", "viz", "handout"]),
  id: z.string(),
  stepId: z.string().optional(),
  codeRange: z.object({
    startLine: z.number().int().min(1),
    endLine: z.number().int(),
  }).refine((range) => range.startLine <= range.endLine, {
    message: "startLine must be <= endLine",
  }).optional(),
  vizHit: z.object({
    structure: z.string(),
    nodeIds: z.array(z.string()).optional(),
    indices: z.array(z.number().int()).optional(),
  }).optional(),
  text: z.string().max(ASK_LIMITS.targetTextMax).optional(),
});

export const askSelectionSchema = z.object({
  stepId: z.string(),
  mode: z.enum(["region", "single"]),
  bbox: askBBoxSchema,
  targets: z.array(askTargetSchema).max(ASK_LIMITS.targetsMax),
  question: z.string().trim().min(1).max(ASK_LIMITS.questionMax),
});

/** Keep a valid array frame; drop anything else without failing the segment. */
const optionalArrayViz = z.unknown().optional().transform((value) => {
  if (value === undefined) return undefined;
  const parsed = arrayVizFrameSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  console.warn("[ask] dropped non-array viz");
  return undefined;
});

export const answerSegmentSchema = z.object({
  id: z.string(),
  narration: z.string().min(1).max(ASK_LIMITS.narrationMax),
  targets: z.array(effectTargetSchema).optional(),
  effects: z.array(effectCallSchema).optional(),
  viz: optionalArrayViz,
}).transform((segment) => {
  if (segment.viz === undefined) {
    const rest = { ...segment };
    delete rest.viz;
    return rest;
  }
  return segment;
});

export const stepAnswerSchema = z.object({
  v: z.literal(1),
  id: z.string(),
  stepId: z.string(),
  question: z.string().trim().min(1).max(ASK_LIMITS.questionMax),
  selection: z.object({
    mode: z.enum(["region", "single"]),
    bbox: askBBoxSchema,
    targets: z.array(askTargetSchema).max(ASK_LIMITS.targetsMax),
  }),
  segments: z.array(answerSegmentSchema).min(1).max(ASK_LIMITS.segmentsMax),
  createdAt: z.string().datetime({ offset: true }),
});

export const stepAnswersMapSchema = z.record(z.string(), z.array(stepAnswerSchema)).superRefine((map, ctx) => {
  for (const [key, answers] of Object.entries(map)) {
    answers.forEach((answer, index) => {
      if (answer.stepId !== key) {
        ctx.addIssue({
          code: "custom",
          message: "answer.stepId must equal the map key",
          path: [key, index, "stepId"],
        });
      }
    });
  }
});
