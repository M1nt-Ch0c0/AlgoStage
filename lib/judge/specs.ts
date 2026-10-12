/** 前 20 题自产结构化用例，验证函数返回值或指定原地修改参数。 */
import type { Comparison, JudgeCase, ProblemJudgingSpec } from "./types";
const specs: Record<string, ProblemJudgingSpec> = {};
function add(slug: string, name: string, parameters: string[], cases: [unknown[], unknown][], comparison: Comparison = "exact", mutatesArg?: number) {
  const names = [name, name.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`)];
  specs[slug] = { entryPoints: { typescript: names, javascript: names, python: names }, parameters, cases: cases.map(([args, expected]): JudgeCase => ({ args, expected })), comparison, mutatesArg, timeLimitMs: 2000 };
}
add("two-sum", "twoSum", ["nums", "target"], [[[[2,7,11,15],9],[0,1]], [[[3,2,4],6],[1,2]], [[[3,3],6],[0,1]], [[[-3,4,3,90],0],[0,2]]], "two-sum");
add("group-anagrams", "groupAnagrams", ["strs"], [[[["eat","tea","tan","ate","nat","bat"]],[["eat","tea","ate"],["tan","nat"],["bat"]]], [[[""]],[[""]]], [[["a"]],[["a"]]], [[["ab","ba","ab"]],[["ab","ba","ab"]]]], "groups");
add("longest-consecutive-sequence", "longestConsecutive", ["nums"], [[[[100,4,200,1,3,2]],4], [[[]],0], [[[1,2,0,1]],3], [[[-2,-1,0]],3]]);
add("move-zeroes", "moveZeroes", ["nums"], [[[[0,1,0,3,12]],[1,3,12,0,0]], [[[0]],[0]], [[[1,2,3]],[1,2,3]], [[[]],[]]], "exact", 0);
add("container-with-most-water", "maxArea", ["height"], [[[[1,8,6,2,5,4,8,3,7]],49], [[[1,1]],1], [[[0,0]],0], [[[4,3,2,1,4]],16]]);
add("3sum", "threeSum", ["nums"], [[[[-1,0,1,2,-1,-4]],[[-1,-1,2],[-1,0,1]]], [[[0,1,1]],[]], [[[0,0,0,0]],[[0,0,0]]], [[[-2,0,0,2,2]],[[-2,0,2]]]], "groups");
add("trapping-rain-water", "trap", ["height"], [[[[0,1,0,2,1,0,1,3,2,1,2,1]],6], [[[4,2,0,3,2,5]],9], [[[1]],0], [[[0,0]],0]]);
add("longest-substring-without-repeating-characters", "lengthOfLongestSubstring", ["s"], [[["abcabcbb"],3], [["bbbbb"],1], [[""],0], [["abba"],2], [["pwwkew"],3]]);
add("find-all-anagrams-in-a-string", "findAnagrams", ["s", "p"], [[["cbaebabacd","abc"],[0,6]], [["abab","ab"],[0,1,2]], [["a","ab"],[]], [["baa","aa"],[1]]], "unordered");
add("subarray-sum-equals-k", "subarraySum", ["nums", "k"], [[[[1,1,1],2],2], [[[1,2,3],3],2], [[[0,0,0],0],6], [[[1,-1,0],0],3]]);
add("sliding-window-maximum", "maxSlidingWindow", ["nums", "k"], [[[[1,3,-1,-3,5,3,6,7],3],[3,3,5,5,6,7]], [[[1],1],[1]], [[[9,8,7],2],[9,8]], [[[2,2,2],1],[2,2,2]]]);
add("min-window-substring", "minWindow", ["s", "t"], [[["ADOBECODEBANC","ABC"],"BANC"], [["a","a"],"a"], [["a","aa"],""], [["aa","aa"],"aa"], [["abxba","ab"],"ab"]], "min-window");
add("max-subarray", "maxSubArray", ["nums"], [[[[-2,1,-3,4,-1,2,1,-5,4]],6], [[[-1]],-1], [[[-3,-2,-5]],-2], [[[5,4,-1,7,8]],23]]);
add("merge-intervals", "merge", ["intervals"], [[[[[1,3],[2,6],[8,10],[15,18]]],[[1,6],[8,10],[15,18]]], [[[[1,4],[4,5]]],[[1,5]]], [[[[1,4],[2,3]]],[[1,4]]], [[[[1,1]]],[[1,1]]]], "unordered");
add("rotate-array", "rotate", ["nums", "k"], [[[[1,2,3,4,5,6,7],3],[5,6,7,1,2,3,4]], [[[-1,-100,3,99],2],[3,99,-1,-100]], [[[1,2],4],[1,2]], [[[1],0],[1]]], "exact", 0);
add("product-of-array-except-self", "productExceptSelf", ["nums"], [[[[1,2,3,4]],[24,12,8,6]], [[[-1,1,0,-3,3]],[0,0,9,0,0]], [[[0,0]],[0,0]], [[[2,3]],[3,2]]]);
add("first-missing-positive", "firstMissingPositive", ["nums"], [[[[1,2,0]],3], [[[3,4,-1,1]],2], [[[7,8,9,11,12]],1], [[[1,1]],2]]);
add("set-matrix-zeroes", "setZeroes", ["matrix"], [[[[[1,1,1],[1,0,1],[1,1,1]]],[[1,0,1],[0,0,0],[1,0,1]]], [[[[0,1],[2,3]]],[[0,0],[0,3]]], [[[[1]]],[[1]]], [[[[0]]],[[0]]]], "exact", 0);
add("spiral-matrix", "spiralOrder", ["matrix"], [[[[[1,2,3],[4,5,6],[7,8,9]]],[1,2,3,6,9,8,7,4,5]], [[[[1,2,3]]],[1,2,3]], [[[[1],[2],[3]]],[1,2,3]], [[[[1]]],[1]]]);
add("rotate-image", "rotate", ["matrix"], [[[[[1,2],[3,4]]],[[3,1],[4,2]]], [[[[1]]],[[1]]], [[[[1,2,3],[4,5,6],[7,8,9]]],[[7,4,1],[8,5,2],[9,6,3]]]], "exact", 0);
export const JUDGING_SPECS = specs;
