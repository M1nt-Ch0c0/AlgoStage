/** 完整校验后先恢复参考代码，再加载教案；内置课程与 AI 课程共用。 */
import type { ProblemDetail } from "@/lib/content/types";
import type { TeachingScript } from "@/lib/teaching/types";
import { teachingScriptSchema } from "@/lib/teaching/schema";
import { validateScript } from "@/lib/teaching/validated-script";

/** 取消、切换语言和进入练习共用：停止请求、清空所有锚点，再恢复相应题解。 */
export function cancelLectureForPlayback(detail: ProblemDetail | null, language: "typescript" | "python", controls: {
  abort: () => void;
  reset: () => void;
  setCode: (code: string) => void;
}) {
  controls.abort();
  controls.reset();
  controls.setCode(detail?.referenceSolutions?.find(s => s.language === language)?.code ?? "");
}

export function switchProblemForPlayback(controls: {
  abort: () => void;
  reset: () => void;
  clearLectureUi: () => void;
}) {
  controls.abort();
  controls.clearLectureUi();
  controls.reset();
}

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
