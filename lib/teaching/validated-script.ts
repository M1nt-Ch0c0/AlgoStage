/** 脚本进入缓存或播放器前统一校验，纠正代码锚点，保留 targetIndex 对应关系。 */
import { z } from "zod";
import { findDuplicateStepIds } from "@/lib/ask/answers";
import { teachingScriptSchema } from "./schema";
import type { TeachingScript } from "./types";

export interface ValidateScriptOptions {
  /** strict（默认）拒绝重复或空 step id；lenient 留给读旧缓存。 */
  stepIds?: "strict" | "lenient";
}

export function validateScript(value: unknown, referenceCode: string, opts?: ValidateScriptOptions) {
  const script = teachingScriptSchema.parse(value);
  const lineCount = referenceCode.trim() ? referenceCode.split("\n").length : 0;
  const clamp = (line: number) => Math.min(lineCount, Math.max(1, line));
  for (const step of script.steps) {
    step.targets = step.targets.map((target) => {
      if (target.kind !== "code-line" && target.kind !== "code-token") return target;
      // 没有参考代码时改用题面，绝不将不存在的行传给播放器。
      if (!lineCount) return { kind: "statement", blockId: "intro" };
      if (target.kind === "code-token") return { ...target, line: clamp(target.line) };
      const start = clamp(target.start);
      return { ...target, start, ...(target.end === undefined ? {} : { end: Math.max(start, clamp(target.end)) }) };
    });
    step.effects = step.effects.filter((effect) => effect.targetIndex === undefined || effect.targetIndex < step.targets.length);
  }
  const validated = teachingScriptSchema.parse(script);
  const mode = opts?.stepIds ?? "strict";
  if (mode === "strict") {
    const duplicates = findDuplicateStepIds(validated.steps);
    if (duplicates.length > 0) {
      throw new z.ZodError([{
        code: "custom",
        message: `duplicate or empty step id: ${duplicates.map((id) => JSON.stringify(id)).join(", ")}`,
        path: ["steps"],
      }]);
    }
  }
  return validated;
}

/** Non-empty step ids that appear exactly once. */
export function askableStepIds(script: Pick<TeachingScript, "steps">): Set<string> {
  const counts = new Map<string, number>();
  for (const step of script.steps) {
    counts.set(step.id, (counts.get(step.id) ?? 0) + 1);
  }
  const askable = new Set<string>();
  for (const [id, count] of counts) {
    if (id !== "" && count === 1) askable.add(id);
  }
  return askable;
}

/** Unique ids of steps that are not askable, in first-seen order (includes ""). */
export function disabledStepIds(script: Pick<TeachingScript, "steps">): string[] {
  const askable = askableStepIds(script);
  const disabled: string[] = [];
  const seen = new Set<string>();
  for (const step of script.steps) {
    if (askable.has(step.id) || seen.has(step.id)) continue;
    seen.add(step.id);
    disabled.push(step.id);
  }
  return disabled;
}
