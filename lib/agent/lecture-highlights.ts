/** 本地校验确定性的行号错误；不发起模型自检，不把代码正文写入日志。 */
import type { TeachingStep } from "@/lib/teaching/types";

type Target = TeachingStep["targets"][number];
export type HighlightProblem = { field: string; type: string; reason: string };
export function highlightProblem(lines: string[], narration: string, target: Target): HighlightProblem | null {
  const clause = narration.split(/[，,；;。!！?？]/)[0];
  const sort = /排序|升序|\bsort(?:ing)?\b|\bsorted\s*\(/i.test(clause)
    && !/排序[后完]|复杂度|总结|(?:无需|不用|不必|不需要).*排序|sorted\s+(?:array|input)/i.test(clause);
  const isSort = (text: string) => !/^\s*(?:\/\/|#)/.test(text) && /\.sort\s*\(|\bsorted\s*\(/.test(text);
  const sortLines = lines.flatMap((text, i) => isSort(text) ? [i + 1] : []);
  if (target.kind !== "code-line" && target.kind !== "code-token") {
    if (sort && sortLines.length && target.kind === "statement" && target.blockId !== "summary") {
      return { field: "target", type: "missing_code_highlight", reason: `本步讲排序，请使用 code-line 指向实际排序语句（第 ${sortLines.join("、")} 行），不能只选题面。` };
    }
    return null;
  }
  const start = target.kind === "code-line" ? target.start : target.line;
  const end = target.kind === "code-line" ? target.end ?? start : start;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > lines.length) {
    return { field: "start", type: "highlight_range", reason: `行号必须在 1–${lines.length} 内，且末行不能小于首行。` };
  }
  if (!lines[start - 1].trim() || !lines[end - 1].trim()) {
    return { field: "start", type: "highlight_blank_line", reason: "高亮起止行不能是空白行，请选择正在讲的实际代码。" };
  }
  const selected = lines.slice(start - 1, end).filter(text => text.trim());
  const signatureOnly = selected.every(text => /^\s*(?:(?:export|default|async)\s+)*function\b.*\{\s*$|^\s*(?:async\s+)?def\b.*:\s*$|^\s*class\b.*[{:]/.test(text));
  if (signatureOnly && /排序|初始化|遍历|扫描|循环|去重|跳过|移动|指针|返回|入栈|出栈|存入|sort|loop|return|push|pop/i.test(clause)
    && !/函数|签名|参数|入口|function|signature|parameter/i.test(clause)) {
    return { field: "start", type: "highlight_signature_mismatch", reason: "当前行是函数或类签名，不能代表本步所讲的操作；请指向具体执行语句。" };
  }
  if (sort && sortLines.length && !sortLines.includes(start)) {
    return { field: "start", type: "highlight_semantic_mismatch", reason: `排序步骤的起始行必须是实际 sort/sorted 语句（第 ${sortLines.join("、")} 行），不能选注释、签名或附近语句。` };
  }
  return null;
}
