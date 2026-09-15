/**
 * 自产参考题解（docs/05 §三）：AI 生成 + 人工校对，自有版权。
 * 一期旗舰题：two-sum，其余题由 AI 按需生成并缓存。
 */
import type { ReferenceSolution } from "../types";

export const TWO_SUM_SOLUTIONS: ReferenceSolution[] = [
  {
    language: "typescript",
    code: `function twoSum(nums: number[], target: number): number[] {
  // 哈希表：键 = 数值，值 = 下标
  const map = new Map<number, number>();
  for (let i = 0; i < nums.length; i++) {
    const complement = target - nums[i];
    // 命中：之前见过 complement
    if (map.has(complement)) {
      return [map.get(complement)!, i];
    }
    map.set(nums[i], i);
  }
  return [];
}`,
  },
  {
    language: "python",
    code: `def two_sum(nums: list[int], target: int) -> list[int]:
    # 哈希表：键 = 数值，值 = 下标
    seen = {}
    for i, num in enumerate(nums):
        complement = target - num
        # 命中：之前见过 complement
        if complement in seen:
            return [seen[complement], i]
        seen[num] = i
    return []`,
  },
];
