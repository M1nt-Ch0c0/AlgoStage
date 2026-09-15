/**
 * 旗舰示例讲解脚本（docs/03 §7 扩展版）：
 * 无 API Key 时也能完整体验"讲课 + 特效"的兜底内容，
 * 同时作为 AI 生成脚本的质量标杆。
 */
import type { TeachingScript } from "@/lib/teaching/types";

export const TWO_SUM_SCRIPT: TeachingScript = {
  problemSlug: "two-sum",
  mode: "lecture",
  language: "zh",
  solutionLanguage: "typescript",
  steps: [
    {
      id: "s1",
      narration: "两数之和：在数组里找两个数，使它们加起来等于 `target`。最容易想到的是两层循环两两枚举——但那是 O(n²)。",
      targets: [{ kind: "statement", blockId: "intro" }],
      effects: [{ effect: "attention-ripple" }],
      viz: {
        type: "array",
        state: { values: [2, 7, 11, 15], highlight: [], map: {}, scan: -1 },
      },
    },
    {
      id: "s2",
      narration: "关键洞察：对每个数，我们真正想知道的是**它的另一半在哪**。'查找'这件事，就该想到哈希表。",
      targets: [{ kind: "statement", blockId: "insight" }],
      effects: [
        { effect: "chalk-underline", color: "violet", params: { shape: "line" } },
      ],
      viz: {
        type: "array",
        state: { values: [2, 7, 11, 15], highlight: [0], map: {}, scan: 0 },
        captions: [{ nodeId: "a0", text: "i" }],
      },
    },
    {
      id: "s3",
      narration: "所以准备工作是：建一个 `map`，键存数值，值存下标。",
      targets: [{ kind: "code-line", start: 2, end: 3 }],
      effects: [{ effect: "laser-pointer" }, { effect: "spotlight-beam" }],
      viz: {
        type: "array",
        state: { values: [2, 7, 11, 15], highlight: [], map: {}, scan: -1 },
      },
    },
    {
      id: "s4",
      narration: "然后只遍历一遍。站在每个位置，先算出**补数** `complement = target - nums[i]`。",
      targets: [{ kind: "code-line", start: 4, end: 5 }],
      effects: [{ effect: "spotlight-beam" }],
      viz: {
        type: "array",
        state: { values: [2, 7, 11, 15], highlight: [1], map: { "2": 0 }, scan: 1 },
        captions: [{ nodeId: "a1", text: "i" }],
      },
    },
    {
      id: "s5",
      narration: "注意这里，全题的灵魂：**补数之前见过吗？** 见过，说明答案就是当时那个下标和现在的 i。",
      targets: [{ kind: "code-line", start: 6, end: 8 }],
      effects: [
        { effect: "focus-dim" },
        { effect: "spotlight-beam" },
        { effect: "chalk-underline", targetIndex: 0, color: "gold", params: { shape: "circle" } },
      ],
      viz: {
        type: "array",
        state: { values: [2, 7, 11, 15], highlight: [0, 1], map: { "2": 0 }, scan: 1, hit: true },
        captions: [
          { nodeId: "a0", text: "seen[7]=0" },
          { nodeId: "a1", text: "i" },
        ],
      },
      dwellMs: 1200,
    },
    {
      id: "s6",
      narration: "没见过就把当前数存进 `map`，继续往前走。每个数只进一次、查一次，所以整体是 O(n)。",
      targets: [{ kind: "code-line", start: 9, end: 9 }],
      effects: [{ effect: "spotlight-beam", color: "cyan" }],
      viz: {
        type: "array",
        state: { values: [2, 7, 11, 15], highlight: [], map: { "2": 0, "7": 1 }, scan: 2 },
        captions: [{ nodeId: "a2", text: "i" }],
      },
    },
    {
      id: "s7",
      narration: "总结一下套路：**枚举一个，查找另一个**。遇到'配对''互补'类问题，先把暴力枚举里的内层查找换成哈希表——这是 Hot 100 里反复出现的模式。",
      targets: [{ kind: "statement", blockId: "summary" }],
      effects: [{ effect: "attention-ripple", color: "mint" }],
      viz: {
        type: "array",
        state: { values: [2, 7, 11, 15], highlight: [0, 1], map: { "2": 0 }, scan: 1, hit: true },
      },
      dwellMs: 1500,
    },
  ],
};
