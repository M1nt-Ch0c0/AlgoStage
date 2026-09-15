/**
 * local-seed 题目源：仓库内置元数据 + 自产内容（docs/01 §2-①）
 */
import { HOT100 } from "./hot100";
import { TWO_SUM_SOLUTIONS } from "./solutions/two-sum";
import type {
  ProblemDetail,
  ProblemMeta,
  ProblemSource,
  ReferenceSolution,
  TestCase,
} from "./types";

const STATEMENTS: Record<string, string> = {
  // 改写版题面（自产文字），其余题走 leetcode-live 源或 AI 生成
  "two-sum": `给定一个整数数组 \`nums\` 和一个整数目标值 \`target\`，请你在数组中找出**和为目标值**的那两个整数，并返回它们的下标。

你可以假设每种输入只会对应一个答案，并且不能使用两次相同的元素。

**示例**：\`nums = [2,7,11,15], target = 9\` → 返回 \`[0,1]\`。`,
};

const SOLUTIONS: Record<string, ReferenceSolution[]> = {
  "two-sum": TWO_SUM_SOLUTIONS,
};

const TEST_CASES: Record<string, TestCase[]> = {
  "two-sum": [
    { input: "[2,7,11,15], 9", expected: "[0,1]" },
    { input: "[3,2,4], 6", expected: "[1,2]" },
    { input: "[3,3], 6", expected: "[0,1]" },
  ],
};

export const localSeedSource: ProblemSource = {
  name: "local-seed",

  async list(): Promise<ProblemMeta[]> {
    return HOT100;
  },

  async detail(slug: string): Promise<ProblemDetail> {
    const meta = HOT100.find((p) => p.slug === slug);
    if (!meta) throw new Error(`Unknown problem: ${slug}`);
    return {
      ...meta,
      statement: STATEMENTS[slug],
      referenceSolutions: SOLUTIONS[slug],
      testCases: TEST_CASES[slug],
    };
  },
};
