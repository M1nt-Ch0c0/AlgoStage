/** 脚本进入缓存或播放器前统一校验，纠正代码锚点，保留 targetIndex 对应关系。 */
import { teachingScriptSchema } from "./schema";

export function validateScript(value: unknown, referenceCode: string) {
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
  return teachingScriptSchema.parse(script);
}
