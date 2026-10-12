import { judgeSignature, pythonEntryPoints } from "@/lib/judge/entry-points";
import type { JudgeLanguage, ProblemJudgingSpec } from "@/lib/judge/types";

export default function JudgeSignature({ problem, language }: { problem?: ProblemJudgingSpec; language: JudgeLanguage }) {
  if (!problem) return null;
  return <div className="shrink-0 px-3 py-2 text-xs text-chalk-300">
    <span>函数签名：</span><code>{judgeSignature(problem, language)}</code>
    {language === "python" && <span className="ml-3 text-chalk-500">也支持 class Solution：{pythonEntryPoints(problem.entryPoints.python).join(" / ")}</span>}
  </div>;
}
