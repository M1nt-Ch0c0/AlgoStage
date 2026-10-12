/** 模式标签的中文名（看板掌握度、题目卡片用）；未收录的标签原样显示 */
export const PATTERN_LABELS: Record<string, string> = {
  dp: "动态规划",
  tree: "树",
  "two-pointers": "双指针",
  "linked-list": "链表",
  dfs: "深度优先",
  "hash-table": "哈希表",
  array: "数组",
  "binary-search": "二分查找",
  matrix: "矩阵",
  bfs: "广度优先",
  backtracking: "回溯",
  string: "字符串",
  recursion: "递归",
  greedy: "贪心",
  "divide-conquer": "分治",
  stack: "栈",
  "sliding-window": "滑动窗口",
  heap: "堆",
  design: "设计",
  sorting: "排序",
  "prefix-sum": "前缀和",
  "monotonic-stack": "单调栈",
  graph: "图",
  trie: "字典树",
  bst: "二叉搜索树",
  "bit-manipulation": "位运算",
  voting: "投票法",
  "union-find": "并查集",
  "topological-sort": "拓扑排序",
  simulation: "模拟",
  quickselect: "快速选择",
  "monotonic-queue": "单调队列",
  math: "数学",
  knapsack: "背包",
  "expand-center": "中心扩展",
  "bucket-sort": "桶排序",
};

export function patternLabel(pattern: string): string {
  return PATTERN_LABELS[pattern] ?? pattern;
}

export const DIFFICULTY_LABEL: Record<string, string> = {
  easy: "简单",
  medium: "中等",
  hard: "困难",
};

/** 难度的文字色 / 圆点色（与 LeetCode 习惯一致：绿 · 金 · 红） */
export const DIFFICULTY_TEXT: Record<string, string> = {
  easy: "text-beam-mint",
  medium: "text-beam-gold",
  hard: "text-beam-rose",
};

export const DIFFICULTY_DOT: Record<string, string> = {
  easy: "bg-beam-mint",
  medium: "bg-beam-gold",
  hard: "bg-beam-rose",
};

export function isSolved(status: string | undefined): boolean {
  return status === "solved" || status === "mastered";
}
