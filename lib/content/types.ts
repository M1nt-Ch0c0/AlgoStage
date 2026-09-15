/**
 * 内容层契约 · ProblemSource 插件点（docs/01 §2-①）
 * 仓库只内置元数据（docs/05），题面由实现运行时获取。
 */

export type Difficulty = "easy" | "medium" | "hard";

export interface ProblemMeta {
  slug: string; // 'two-sum'
  title: string; // 中文标题
  number: number; // LeetCode 题号
  difficulty: Difficulty;
  /** 所属算法模式分类（官方 Hot 100 章节结构） */
  category: string; // '哈希' | '双指针' | ...
  /** 模式标签（掌握度雷达图维度） */
  patterns: string[];
  /** 前置知识（路线图依赖树） */
  prereqs: string[];
  /** 路线图排序 */
  order: number;
  /** 可视化器类型（docs/03 §4），无则不渲染可视化区 */
  vizType?: string;
}

export interface ProblemDetail extends ProblemMeta {
  /** 题面 HTML/Markdown；local-seed 提供改写版，leetcode-live 运行时拉取 */
  statement?: string;
  /** 自产参考题解 */
  referenceSolutions?: ReferenceSolution[];
  /** playground 测试用例 */
  testCases?: TestCase[];
}

export interface ReferenceSolution {
  language: "typescript" | "python";
  code: string;
}

export interface TestCase {
  input: string;
  expected: string;
}

/** 插件点①：题目源接口 */
export interface ProblemSource {
  name: string;
  list(): Promise<ProblemMeta[]>;
  detail(slug: string): Promise<ProblemDetail>;
}
