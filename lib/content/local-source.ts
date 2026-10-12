/**
 * local-seed 题目源：仓库内置元数据 + 自产内容（docs/01 §2-①）
 */
import { JUDGING_SPECS } from "../judge/specs";
import generatedJSON from "./generated/hot100-content.json";
import { validateContent, type GeneratedContent } from "./generated-check";
import { HOT100 } from "./hot100";
import { TWO_SUM_SOLUTIONS } from "./solutions/two-sum";
import type {
  ProblemDetail,
  ProblemMeta,
  ProblemSource,
  ReferenceSolution,
  TestCase,
} from "./types";

// 生成内容入库前离线校验，运行时也检查结构，避免不完整代码进入讲课链路。
const GENERATED = generatedJSON as Record<string, GeneratedContent>;
for (const [slug, content] of Object.entries(GENERATED)) {
  const error = validateContent(content);
  if (error) throw new Error(`题目 ${slug} 的内置内容无效：${error}`);
}

const STATEMENTS: Record<string, string> = {
  // 精品题面优先，其余题使用离线整理的三段改写题面
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
      judging: JUDGING_SPECS[slug],
      statement: STATEMENTS[slug] ?? GENERATED[slug]?.statement,
      referenceSolutions: SOLUTIONS[slug] ?? GENERATED[slug]?.solutions,
      testCases: JUDGING_SPECS[slug]?.cases.map(c => ({ input: c.args.map(arg => JSON.stringify(arg)).join(", "), expected: JSON.stringify(c.expected) })) ?? TEST_CASES[slug] ?? GENERATED[slug]?.testCases,
    };
  },
};
