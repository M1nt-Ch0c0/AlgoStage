/**
 * Ask 协议的 zod 校验。
 * effectTarget / effectCall 在 lib/teaching/schema.ts 里未导出，这里按同一形状最小重写。
 */
import { z } from "zod";
import { arrayVizFrameSchema } from "@/lib/teaching/schema";
import { EFFECT_WHITELIST } from "@/lib/teaching/types";
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

/** Mirrors the unexported `effectTarget` in lib/teaching/schema.ts. */
const effectTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("code-line"), start: z.number().int().min(1), end: z.number().int().min(1).optional() }),
  z.object({ kind: z.literal("code-token"), line: z.number().int().min(1), match: z.string() }),
  z.object({ kind: z.literal("statement"), blockId: z.string() }),
  z.object({ kind: z.literal("viz-node"), nodeId: z.string() }),
  z.object({ kind: z.literal("dom"), selector: z.string() }),
]);

/** Mirrors the unexported `effectCall` in lib/teaching/schema.ts. */
const effectCallSchema = z.object({
  effect: z.enum(EFFECT_WHITELIST),
  targetIndex: z.number().int().min(0).optional(),
  color: z.enum(["gold", "cyan", "violet", "rose", "mint"]).optional(),
  intensity: z.enum(["whisper", "normal", "shout"]).optional(),
  params: z.record(z.string(), z.unknown()).optional(),
});

export const answerSegmentSchema = z.object({
  id: z.string(),
  narration: z.string().min(1).max(ASK_LIMITS.narrationMax),
  targets: z.array(effectTargetSchema).optional(),
  effects: z.array(effectCallSchema).optional(),
  viz: arrayVizFrameSchema.optional(),
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
