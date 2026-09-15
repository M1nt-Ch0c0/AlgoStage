import type { ProblemMeta } from "./types";

/**
 * LeetCode Hot 100 元数据（官方章节结构，共 100 题）。
 * 仅含事实性元数据 + 自研编排，合规说明见 docs/05-content-license.md。
 */
export const HOT100: ProblemMeta[] = [
  // ── 哈希 ──────────────────────────────────────────────
  { slug: "two-sum", title: "两数之和", number: 1, difficulty: "easy", category: "哈希", patterns: ["hash-table"], prereqs: [], order: 1, vizType: "array" },
  { slug: "group-anagrams", title: "字母异位词分组", number: 49, difficulty: "medium", category: "哈希", patterns: ["hash-table", "string"], prereqs: ["two-sum"], order: 2 },
  { slug: "longest-consecutive-sequence", title: "最长连续序列", number: 128, difficulty: "medium", category: "哈希", patterns: ["hash-table", "union-find"], prereqs: ["two-sum"], order: 3, vizType: "array" },

  // ── 双指针 ────────────────────────────────────────────
  { slug: "move-zeroes", title: "移动零", number: 283, difficulty: "easy", category: "双指针", patterns: ["two-pointers", "array"], prereqs: [], order: 4, vizType: "array" },
  { slug: "container-with-most-water", title: "盛最多水的容器", number: 11, difficulty: "medium", category: "双指针", patterns: ["two-pointers", "greedy"], prereqs: ["move-zeroes"], order: 5, vizType: "array" },
  { slug: "3sum", title: "三数之和", number: 15, difficulty: "medium", category: "双指针", patterns: ["two-pointers", "sorting"], prereqs: ["two-sum"], order: 6 },
  { slug: "trapping-rain-water", title: "接雨水", number: 42, difficulty: "hard", category: "双指针", patterns: ["two-pointers", "dp", "monotonic-stack"], prereqs: ["container-with-most-water"], order: 7, vizType: "array" },

  // ── 滑动窗口 ──────────────────────────────────────────
  { slug: "longest-substring-without-repeating-characters", title: "无重复字符的最长子串", number: 3, difficulty: "medium", category: "滑动窗口", patterns: ["sliding-window", "hash-table"], prereqs: [], order: 8, vizType: "array" },
  { slug: "find-all-anagrams-in-a-string", title: "找到字符串中所有字母异位词", number: 438, difficulty: "medium", category: "滑动窗口", patterns: ["sliding-window", "hash-table"], prereqs: ["longest-substring-without-repeating-characters"], order: 9 },

  // ── 子串 ──────────────────────────────────────────────
  { slug: "subarray-sum-equals-k", title: "和为 K 的子数组", number: 560, difficulty: "medium", category: "子串", patterns: ["prefix-sum", "hash-table"], prereqs: ["two-sum"], order: 10 },
  { slug: "sliding-window-maximum", title: "滑动窗口最大值", number: 239, difficulty: "hard", category: "子串", patterns: ["monotonic-queue", "sliding-window"], prereqs: ["longest-substring-without-repeating-characters"], order: 11, vizType: "array" },
  { slug: "min-window-substring", title: "最小覆盖子串", number: 76, difficulty: "hard", category: "子串", patterns: ["sliding-window", "hash-table"], prereqs: ["find-all-anagrams-in-a-string"], order: 12 },

  // ── 普通数组 ──────────────────────────────────────────
  { slug: "max-subarray", title: "最大子数组和", number: 53, difficulty: "medium", category: "普通数组", patterns: ["dp", "array"], prereqs: [], order: 13, vizType: "array" },
  { slug: "merge-intervals", title: "合并区间", number: 56, difficulty: "medium", category: "普通数组", patterns: ["sorting", "array"], prereqs: [], order: 14 },
  { slug: "rotate-array", title: "轮转数组", number: 189, difficulty: "medium", category: "普通数组", patterns: ["array", "two-pointers"], prereqs: [], order: 15 },
  { slug: "product-of-array-except-self", title: "除自身以外数组的乘积", number: 238, difficulty: "medium", category: "普通数组", patterns: ["prefix-sum", "array"], prereqs: [], order: 16 },
  { slug: "first-missing-positive", title: "缺失的第一个正数", number: 41, difficulty: "hard", category: "普通数组", patterns: ["array", "hash-table"], prereqs: [], order: 17 },

  // ── 矩阵 ──────────────────────────────────────────────
  { slug: "set-matrix-zeroes", title: "矩阵置零", number: 73, difficulty: "medium", category: "矩阵", patterns: ["matrix"], prereqs: [], order: 18 },
  { slug: "spiral-matrix", title: "螺旋矩阵", number: 54, difficulty: "medium", category: "矩阵", patterns: ["matrix", "simulation"], prereqs: [], order: 19 },
  { slug: "rotate-image", title: "旋转图像", number: 48, difficulty: "medium", category: "矩阵", patterns: ["matrix"], prereqs: [], order: 20 },
  { slug: "search-a-2d-matrix-ii", title: "搜索二维矩阵 II", number: 240, difficulty: "medium", category: "矩阵", patterns: ["matrix", "binary-search"], prereqs: [], order: 21 },

  // ── 链表 ──────────────────────────────────────────────
  { slug: "intersection-of-two-linked-lists", title: "相交链表", number: 160, difficulty: "easy", category: "链表", patterns: ["linked-list", "two-pointers"], prereqs: [], order: 22, vizType: "linked-list" },
  { slug: "reverse-linked-list", title: "反转链表", number: 206, difficulty: "easy", category: "链表", patterns: ["linked-list", "recursion"], prereqs: [], order: 23, vizType: "linked-list" },
  { slug: "palindrome-linked-list", title: "回文链表", number: 234, difficulty: "easy", category: "链表", patterns: ["linked-list", "two-pointers"], prereqs: ["reverse-linked-list"], order: 24 },
  { slug: "linked-list-cycle", title: "环形链表", number: 141, difficulty: "easy", category: "链表", patterns: ["linked-list", "two-pointers"], prereqs: [], order: 25 },
  { slug: "linked-list-cycle-ii", title: "环形链表 II", number: 142, difficulty: "medium", category: "链表", patterns: ["linked-list", "two-pointers"], prereqs: ["linked-list-cycle"], order: 26 },
  { slug: "merge-two-sorted-lists", title: "合并两个有序链表", number: 21, difficulty: "easy", category: "链表", patterns: ["linked-list", "recursion"], prereqs: ["reverse-linked-list"], order: 27 },
  { slug: "add-two-numbers", title: "两数相加", number: 2, difficulty: "medium", category: "链表", patterns: ["linked-list", "math"], prereqs: ["merge-two-sorted-lists"], order: 28 },
  { slug: "remove-nth-node-from-end-of-list", title: "删除链表的倒数第 N 个结点", number: 19, difficulty: "medium", category: "链表", patterns: ["linked-list", "two-pointers"], prereqs: ["linked-list-cycle"], order: 29 },
  { slug: "swap-nodes-in-pairs", title: "两两交换链表中的节点", number: 24, difficulty: "medium", category: "链表", patterns: ["linked-list", "recursion"], prereqs: ["reverse-linked-list"], order: 30 },
  { slug: "reverse-nodes-in-k-group", title: "K 个一组翻转链表", number: 25, difficulty: "hard", category: "链表", patterns: ["linked-list", "recursion"], prereqs: ["swap-nodes-in-pairs"], order: 31 },
  { slug: "copy-list-with-random-pointer", title: "随机链表的复制", number: 138, difficulty: "medium", category: "链表", patterns: ["linked-list", "hash-table"], prereqs: [], order: 32 },
  { slug: "sort-list", title: "排序链表", number: 148, difficulty: "medium", category: "链表", patterns: ["linked-list", "sorting", "divide-conquer"], prereqs: ["merge-two-sorted-lists"], order: 33 },
  { slug: "merge-k-sorted-lists", title: "合并 K 个升序链表", number: 23, difficulty: "hard", category: "链表", patterns: ["linked-list", "heap", "divide-conquer"], prereqs: ["merge-two-sorted-lists"], order: 34 },
  { slug: "lru-cache", title: "LRU 缓存", number: 146, difficulty: "medium", category: "链表", patterns: ["linked-list", "hash-table", "design"], prereqs: [], order: 35 },

  // ── 二叉树 ────────────────────────────────────────────
  { slug: "binary-tree-inorder-traversal", title: "二叉树的中序遍历", number: 94, difficulty: "easy", category: "二叉树", patterns: ["tree", "dfs"], prereqs: [], order: 36, vizType: "tree" },
  { slug: "maximum-depth-of-binary-tree", title: "二叉树的最大深度", number: 104, difficulty: "easy", category: "二叉树", patterns: ["tree", "dfs", "bfs"], prereqs: ["binary-tree-inorder-traversal"], order: 37 },
  { slug: "invert-binary-tree", title: "翻转二叉树", number: 226, difficulty: "easy", category: "二叉树", patterns: ["tree", "dfs"], prereqs: ["maximum-depth-of-binary-tree"], order: 38 },
  { slug: "symmetric-tree", title: "对称二叉树", number: 101, difficulty: "easy", category: "二叉树", patterns: ["tree", "dfs", "bfs"], prereqs: ["invert-binary-tree"], order: 39 },
  { slug: "diameter-of-binary-tree", title: "二叉树的直径", number: 543, difficulty: "easy", category: "二叉树", patterns: ["tree", "dfs"], prereqs: ["maximum-depth-of-binary-tree"], order: 40 },
  { slug: "binary-tree-level-order-traversal", title: "二叉树的层序遍历", number: 102, difficulty: "medium", category: "二叉树", patterns: ["tree", "bfs"], prereqs: ["binary-tree-inorder-traversal"], order: 41, vizType: "tree" },
  { slug: "sorted-array-to-binary-search-tree", title: "将有序数组转换为二叉搜索树", number: 108, difficulty: "easy", category: "二叉树", patterns: ["tree", "divide-conquer"], prereqs: ["maximum-depth-of-binary-tree"], order: 42 },
  { slug: "validate-binary-search-tree", title: "验证二叉搜索树", number: 98, difficulty: "medium", category: "二叉树", patterns: ["tree", "dfs", "bst"], prereqs: ["binary-tree-inorder-traversal"], order: 43 },
  { slug: "kth-smallest-element-in-a-bst", title: "二叉搜索树中第 K 小的元素", number: 230, difficulty: "medium", category: "二叉树", patterns: ["tree", "bst"], prereqs: ["validate-binary-search-tree"], order: 44 },
  { slug: "binary-tree-right-side-view", title: "二叉树的右视图", number: 199, difficulty: "medium", category: "二叉树", patterns: ["tree", "bfs", "dfs"], prereqs: ["binary-tree-level-order-traversal"], order: 45 },
  { slug: "flatten-binary-tree-to-linked-list", title: "二叉树展开为链表", number: 114, difficulty: "medium", category: "二叉树", patterns: ["tree", "dfs"], prereqs: ["binary-tree-inorder-traversal"], order: 46 },
  { slug: "construct-binary-tree-from-preorder-and-inorder-traversal", title: "从前序与中序遍历序列构造二叉树", number: 105, difficulty: "medium", category: "二叉树", patterns: ["tree", "divide-conquer"], prereqs: ["binary-tree-inorder-traversal"], order: 47 },
  { slug: "path-sum-iii", title: "路径总和 III", number: 437, difficulty: "medium", category: "二叉树", patterns: ["tree", "prefix-sum", "dfs"], prereqs: ["subarray-sum-equals-k"], order: 48 },
  { slug: "lowest-common-ancestor-of-a-binary-tree", title: "二叉树的最近公共祖先", number: 236, difficulty: "medium", category: "二叉树", patterns: ["tree", "dfs"], prereqs: ["maximum-depth-of-binary-tree"], order: 49 },
  { slug: "binary-tree-maximum-path-sum", title: "二叉树中的最大路径和", number: 124, difficulty: "hard", category: "二叉树", patterns: ["tree", "dfs", "dp"], prereqs: ["diameter-of-binary-tree"], order: 50 },

  // ── 图论 ──────────────────────────────────────────────
  { slug: "number-of-islands", title: "岛屿数量", number: 200, difficulty: "medium", category: "图论", patterns: ["graph", "dfs", "bfs"], prereqs: [], order: 51, vizType: "graph" },
  { slug: "rotting-oranges", title: "腐烂的橘子", number: 994, difficulty: "medium", category: "图论", patterns: ["graph", "bfs"], prereqs: ["number-of-islands"], order: 52 },
  { slug: "course-schedule", title: "课程表", number: 207, difficulty: "medium", category: "图论", patterns: ["graph", "topological-sort"], prereqs: ["number-of-islands"], order: 53 },
  { slug: "implement-trie-prefix-tree", title: "实现 Trie（前缀树）", number: 208, difficulty: "medium", category: "图论", patterns: ["trie", "design"], prereqs: [], order: 54 },

  // ── 回溯 ──────────────────────────────────────────────
  { slug: "permutations", title: "全排列", number: 46, difficulty: "medium", category: "回溯", patterns: ["backtracking"], prereqs: [], order: 55, vizType: "tree" },
  { slug: "subsets", title: "子集", number: 78, difficulty: "medium", category: "回溯", patterns: ["backtracking", "bit-manipulation"], prereqs: ["permutations"], order: 56 },
  { slug: "letter-combinations-of-a-phone-number", title: "电话号码的字母组合", number: 17, difficulty: "medium", category: "回溯", patterns: ["backtracking", "string"], prereqs: ["permutations"], order: 57 },
  { slug: "combination-sum", title: "组合总和", number: 39, difficulty: "medium", category: "回溯", patterns: ["backtracking"], prereqs: ["subsets"], order: 58 },
  { slug: "generate-parentheses", title: "括号生成", number: 22, difficulty: "medium", category: "回溯", patterns: ["backtracking"], prereqs: ["subsets"], order: 59 },
  { slug: "word-search", title: "单词搜索", number: 79, difficulty: "medium", category: "回溯", patterns: ["backtracking", "matrix"], prereqs: ["number-of-islands"], order: 60 },
  { slug: "palindrome-partitioning", title: "分割回文串", number: 131, difficulty: "medium", category: "回溯", patterns: ["backtracking", "dp"], prereqs: ["subsets"], order: 61 },
  { slug: "n-queens", title: "N 皇后", number: 51, difficulty: "hard", category: "回溯", patterns: ["backtracking"], prereqs: ["word-search"], order: 62 },

  // ── 二分查找 ──────────────────────────────────────────
  { slug: "search-insert-position", title: "搜索插入位置", number: 35, difficulty: "easy", category: "二分查找", patterns: ["binary-search"], prereqs: [], order: 63, vizType: "array" },
  { slug: "search-a-2d-matrix", title: "搜索二维矩阵", number: 74, difficulty: "medium", category: "二分查找", patterns: ["binary-search", "matrix"], prereqs: ["search-insert-position"], order: 64 },
  { slug: "find-first-and-last-position-of-element-in-sorted-array", title: "在排序数组中查找元素的第一个和最后一个位置", number: 34, difficulty: "medium", category: "二分查找", patterns: ["binary-search"], prereqs: ["search-insert-position"], order: 65 },
  { slug: "search-in-rotated-sorted-array", title: "搜索旋转排序数组", number: 33, difficulty: "medium", category: "二分查找", patterns: ["binary-search"], prereqs: ["search-insert-position"], order: 66 },
  { slug: "find-minimum-in-rotated-sorted-array", title: "寻找旋转排序数组中的最小值", number: 153, difficulty: "medium", category: "二分查找", patterns: ["binary-search"], prereqs: ["search-in-rotated-sorted-array"], order: 67 },
  { slug: "median-of-two-sorted-arrays", title: "寻找两个正序数组的中位数", number: 4, difficulty: "hard", category: "二分查找", patterns: ["binary-search", "divide-conquer"], prereqs: ["find-minimum-in-rotated-sorted-array"], order: 68 },

  // ── 栈 ────────────────────────────────────────────────
  { slug: "valid-parentheses", title: "有效的括号", number: 20, difficulty: "easy", category: "栈", patterns: ["stack", "string"], prereqs: [], order: 69, vizType: "stack" },
  { slug: "min-stack", title: "最小栈", number: 155, difficulty: "medium", category: "栈", patterns: ["stack", "design"], prereqs: ["valid-parentheses"], order: 70 },
  { slug: "decode-string", title: "字符串解码", number: 394, difficulty: "medium", category: "栈", patterns: ["stack", "recursion"], prereqs: ["valid-parentheses"], order: 71 },
  { slug: "daily-temperatures", title: "每日温度", number: 739, difficulty: "medium", category: "栈", patterns: ["monotonic-stack"], prereqs: ["min-stack"], order: 72, vizType: "array" },
  { slug: "largest-rectangle-in-histogram", title: "柱状图中最大的矩形", number: 84, difficulty: "hard", category: "栈", patterns: ["monotonic-stack"], prereqs: ["daily-temperatures"], order: 73 },

  // ── 堆 ────────────────────────────────────────────────
  { slug: "kth-largest-element-in-an-array", title: "数组中的第K个最大元素", number: 215, difficulty: "medium", category: "堆", patterns: ["heap", "quickselect"], prereqs: [], order: 74 },
  { slug: "top-k-frequent-elements", title: "前 K 个高频元素", number: 347, difficulty: "medium", category: "堆", patterns: ["heap", "hash-table", "bucket-sort"], prereqs: ["kth-largest-element-in-an-array"], order: 75 },
  { slug: "find-median-from-data-stream", title: "数据流的中位数", number: 295, difficulty: "hard", category: "堆", patterns: ["heap", "design"], prereqs: ["top-k-frequent-elements"], order: 76 },

  // ── 贪心算法 ──────────────────────────────────────────
  { slug: "best-time-to-buy-and-sell-stock", title: "买卖股票的最佳时机", number: 121, difficulty: "easy", category: "贪心算法", patterns: ["greedy", "dp"], prereqs: [], order: 77, vizType: "array" },
  { slug: "jump-game", title: "跳跃游戏", number: 55, difficulty: "medium", category: "贪心算法", patterns: ["greedy", "dp"], prereqs: ["best-time-to-buy-and-sell-stock"], order: 78 },
  { slug: "jump-game-ii", title: "跳跃游戏 II", number: 45, difficulty: "medium", category: "贪心算法", patterns: ["greedy"], prereqs: ["jump-game"], order: 79 },
  { slug: "partition-labels", title: "划分字母区间", number: 763, difficulty: "medium", category: "贪心算法", patterns: ["greedy", "two-pointers"], prereqs: ["merge-intervals"], order: 80 },

  // ── 动态规划 ──────────────────────────────────────────
  { slug: "climbing-stairs", title: "爬楼梯", number: 70, difficulty: "easy", category: "动态规划", patterns: ["dp"], prereqs: [], order: 81, vizType: "array" },
  { slug: "pascals-triangle", title: "杨辉三角", number: 118, difficulty: "easy", category: "动态规划", patterns: ["dp", "array"], prereqs: ["climbing-stairs"], order: 82 },
  { slug: "house-robber", title: "打家劫舍", number: 198, difficulty: "medium", category: "动态规划", patterns: ["dp"], prereqs: ["climbing-stairs"], order: 83 },
  { slug: "perfect-squares", title: "完全平方数", number: 279, difficulty: "medium", category: "动态规划", patterns: ["dp", "bfs"], prereqs: ["coin-change"], order: 84 },
  { slug: "coin-change", title: "零钱兑换", number: 322, difficulty: "medium", category: "动态规划", patterns: ["dp", "bfs"], prereqs: ["house-robber"], order: 85 },
  { slug: "word-break", title: "单词拆分", number: 139, difficulty: "medium", category: "动态规划", patterns: ["dp", "trie"], prereqs: ["coin-change"], order: 86 },
  { slug: "longest-increasing-subsequence", title: "最长递增子序列", number: 300, difficulty: "medium", category: "动态规划", patterns: ["dp", "binary-search"], prereqs: ["house-robber"], order: 87 },
  { slug: "maximum-product-subarray", title: "乘积最大子数组", number: 152, difficulty: "medium", category: "动态规划", patterns: ["dp"], prereqs: ["max-subarray"], order: 88 },
  { slug: "partition-equal-subset-sum", title: "分割等和子集", number: 416, difficulty: "medium", category: "动态规划", patterns: ["dp", "knapsack"], prereqs: ["coin-change"], order: 89 },
  { slug: "longest-valid-parentheses", title: "最长有效括号", number: 32, difficulty: "hard", category: "动态规划", patterns: ["dp", "stack"], prereqs: ["valid-parentheses"], order: 90 },

  // ── 多维动态规划 ──────────────────────────────────────
  { slug: "unique-paths", title: "不同路径", number: 62, difficulty: "medium", category: "多维动态规划", patterns: ["dp", "matrix"], prereqs: ["climbing-stairs"], order: 91 },
  { slug: "minimum-path-sum", title: "最小路径和", number: 64, difficulty: "medium", category: "多维动态规划", patterns: ["dp", "matrix"], prereqs: ["unique-paths"], order: 92 },
  { slug: "longest-palindromic-substring", title: "最长回文子串", number: 5, difficulty: "medium", category: "多维动态规划", patterns: ["dp", "string", "expand-center"], prereqs: ["palindrome-partitioning"], order: 93 },
  { slug: "longest-common-subsequence", title: "最长公共子序列", number: 1143, difficulty: "medium", category: "多维动态规划", patterns: ["dp", "string"], prereqs: ["edit-distance"], order: 94 },
  { slug: "edit-distance", title: "编辑距离", number: 72, difficulty: "medium", category: "多维动态规划", patterns: ["dp", "string"], prereqs: ["longest-common-subsequence"], order: 95 },

  // ── 技巧 ──────────────────────────────────────────────
  { slug: "single-number", title: "只出现一次的数字", number: 136, difficulty: "easy", category: "技巧", patterns: ["bit-manipulation"], prereqs: [], order: 96 },
  { slug: "majority-element", title: "多数元素", number: 169, difficulty: "easy", category: "技巧", patterns: ["array", "voting"], prereqs: [], order: 97 },
  { slug: "sort-colors", title: "颜色分类", number: 75, difficulty: "medium", category: "技巧", patterns: ["two-pointers", "array"], prereqs: ["move-zeroes"], order: 98 },
  { slug: "next-permutation", title: "下一个排列", number: 31, difficulty: "medium", category: "技巧", patterns: ["array", "two-pointers"], prereqs: ["permutations"], order: 99 },
  { slug: "find-the-duplicate-number", title: "寻找重复数", number: 287, difficulty: "medium", category: "技巧", patterns: ["two-pointers", "binary-search"], prereqs: ["linked-list-cycle-ii"], order: 100 },
];

export const HOT100_CATEGORIES = [
  "哈希", "双指针", "滑动窗口", "子串", "普通数组", "矩阵", "链表", "二叉树",
  "图论", "回溯", "二分查找", "栈", "堆", "贪心算法", "动态规划", "多维动态规划", "技巧",
] as const;
