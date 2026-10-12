/** 生成内容的结构校验（生成脚本与运行时共用） */
import type { ReferenceSolution, TestCase } from "./types";

export interface GeneratedContent {
  statement: string;
  solutions: ReferenceSolution[];
  testCases: TestCase[];
}

export function validateContent(c: GeneratedContent): string | null {
  if (typeof c?.statement !== "string") return "缺少 statement";
  const paras = c.statement.split(/\n\s*\n/).filter((s) => s.trim());
  if (paras.length !== 3) return `statement 应恰好 3 段，实际 ${paras.length} 段`;
  for (const lang of ["typescript", "python"] as const) {
    const s = c.solutions?.find((x) => x.language === lang);
    if (!s?.code?.trim()) return `缺少 ${lang} 题解`;
    const n = s.code.split("\n").length;
    if (n < 3 || n > 80) return `${lang} 题解行数 ${n} 不在 3~80`;
  }
  // M1 只保证参考题解覆盖；判题用例会在 M2 继续补齐。
  if (!Array.isArray(c.testCases)) return "testCases 必须是数组";
  if (c.testCases.some((t) => typeof t.input !== "string" || typeof t.expected !== "string"))
    return "testCases 的 input/expected 必须是字符串";
  return null;
}
