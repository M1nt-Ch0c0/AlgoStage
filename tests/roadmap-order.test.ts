import { expect, test } from "vitest";
import { nextProblem, roadmapOrder } from "../lib/content/roadmap-order";

const order = roadmapOrder();

test("first problem is two-sum", () => {
  expect(order[0]?.slug).toBe("two-sum");
});

test("nextProblem('two-sum') is group-anagrams", () => {
  expect(nextProblem("two-sum")?.slug).toBe("group-anagrams");
});

test("last of 哈希 is followed by first of 双指针", () => {
  const hash = order.filter((p) => p.category === "哈希");
  const twoPointers = order.filter((p) => p.category === "双指针");
  const lastHash = hash[hash.length - 1]!;
  expect(nextProblem(lastHash.slug)?.slug).toBe(twoPointers[0]?.slug);
  expect(order.indexOf(twoPointers[0]!) - order.indexOf(lastHash)).toBe(1);
});

test("last problem returns null", () => {
  const last = order[order.length - 1]!;
  expect(nextProblem(last.slug)).toBeNull();
});

test("unknown slug returns null", () => {
  expect(nextProblem("not-a-real-slug")).toBeNull();
});

test("100 unique problems", () => {
  expect(order).toHaveLength(100);
  expect(new Set(order.map((p) => p.slug)).size).toBe(100);
});
