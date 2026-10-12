/** 完整校验后先恢复参考代码，再加载教案；内置课程与 AI 课程共用。 */
import type { ProblemDetail } from "@/lib/content/types";
import type { TeachingScript } from "@/lib/teaching/types";
import { teachingScriptSchema } from "@/lib/teaching/schema";
import { validateScript } from "@/lib/teaching/validated-script";

export function loadLectureForPlayback(value: unknown, detail: ProblemDetail, controls: {
  setCode: (code: string) => void;
  loadScript: (script: TeachingScript) => void;
  play: () => void;
}) {
  const parsed = teachingScriptSchema.parse(value);
  if (parsed.problemSlug !== detail.slug) throw new Error("教案与当前题目不匹配，请重试。");
  const referenceCode = detail.referenceSolutions?.find(s => s.language === parsed.solutionLanguage)?.code;
  if (!referenceCode?.trim()) throw new Error("这道题的参考代码还没加载好，请稍后再试。");
  const script = validateScript(parsed, referenceCode);
  // 练习时可能删过代码；任何重新开课都必须恢复与教案一致的全文。
  controls.setCode(referenceCode);
  controls.loadScript(script);
  controls.play();
}
