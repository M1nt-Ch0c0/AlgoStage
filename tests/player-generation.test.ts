// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, test } from "vitest";
import type { StepAnswer } from "../lib/ask/types";
import { usePlayerStore } from "../lib/player/store";
import type { TeachingScript, TeachingStep } from "../lib/teaching/types";

const s = () => usePlayerStore.getState();

const step1: TeachingStep = { id: "s1", narration: "第一步", targets: [], effects: [] };
const step2: TeachingStep = { id: "s2", narration: "第二步", targets: [], effects: [] };

const scriptA: TeachingScript = {
  problemSlug: "two-sum",
  mode: "lecture",
  language: "zh",
  solutionLanguage: "typescript",
  steps: [step1, step2],
};

const scriptB: TeachingScript = {
  problemSlug: "valid-parentheses",
  mode: "lecture",
  language: "zh",
  solutionLanguage: "typescript",
  steps: [{ id: "b1", narration: "B 第一步", targets: [], effects: [] }],
};

beforeEach(() => {
  localStorage.clear();
  usePlayerStore.getState().reset();
});

afterEach(() => {
  usePlayerStore.getState().reset();
});

test("generation 在 reset / loadScript / beginStream 时递增", () => {
  const g0 = s().generation;
  s().reset();
  expect(s().generation).toBe(g0 + 1);

  s().loadScript(scriptA);
  expect(s().generation).toBe(g0 + 2);

  s().beginStream(scriptB);
  expect(s().generation).toBe(g0 + 3);
});

test("过期 generation 的 appendStep / updateStep / completeStream 被丢弃", () => {
  s().beginStream(scriptA);
  const staleGen = s().generation;

  // 切题或重置推进 generation
  s().beginStream(scriptB);
  const currentGen = s().generation;
  expect(currentGen).toBe(staleGen + 1);

  s().appendStep(step1, { generation: staleGen, problemSlug: "two-sum" });
  expect(s().steps).toEqual([]);
  expect(s().status).toBe("streaming");

  s().appendStep({ id: "b1", narration: "B1", targets: [], effects: [] }, { generation: currentGen, problemSlug: "valid-parentheses" });
  expect(s().steps).toHaveLength(1);

  s().updateStep({ id: "b1", narration: "被旧流篡改", targets: [], effects: [] }, { generation: staleGen });
  expect(s().steps[0]?.narration).toBe("B1");

  s().completeStream(scriptA, { generation: staleGen, problemSlug: "two-sum" });
  expect(s().script?.problemSlug).toBe("valid-parentheses");
  expect(s().receiving).toBe(true);
});

test("当前 generation 的 appendStep / updateStep / completeStream 正常生效", () => {
  s().beginStream(scriptA);
  const guard = { generation: s().generation, problemSlug: "two-sum" };

  s().appendStep(step1, guard);
  expect(s().steps).toEqual([step1]);
  expect(s().status).toBe("playing");

  const updatedStep1: TeachingStep = { ...step1, narration: "第一步（更新）" };
  s().updateStep(updatedStep1, guard);
  expect(s().steps[0]?.narration).toBe("第一步（更新）");

  const finalScript: TeachingScript = { ...scriptA, steps: [updatedStep1, step2] };
  s().completeStream(finalScript, guard);
  expect(s().receiving).toBe(false);
  expect(s().steps).toEqual([updatedStep1, step2]);
  expect(s().script).toEqual(finalScript);
});

test("problemSlug 不匹配的 appendStep / updateStep / completeStream 被丢弃", () => {
  s().beginStream(scriptA);
  const wrongSlugGuard = { generation: s().generation, problemSlug: "other-slug" };

  s().appendStep(step1, wrongSlugGuard);
  expect(s().steps).toEqual([]);

  s().appendStep(step1, { generation: s().generation, problemSlug: "two-sum" });
  expect(s().steps).toEqual([step1]);

  s().updateStep({ ...step1, narration: "篡改" }, wrongSlugGuard);
  expect(s().steps[0]?.narration).toBe("第一步");

  s().completeStream(scriptB, wrongSlugGuard);
  expect(s().script?.problemSlug).toBe("two-sum");
  expect(s().receiving).toBe(true);
});

test("不传 guard 的调用仍然正常工作", () => {
  s().beginStream(scriptA);

  s().appendStep(step1);
  expect(s().steps).toEqual([step1]);

  const updated: TeachingStep = { ...step1, narration: "无 guard 更新" };
  s().updateStep(updated);
  expect(s().steps[0]?.narration).toBe("无 guard 更新");

  const finalScript: TeachingScript = { ...scriptA, steps: [updated, step2] };
  s().completeStream(finalScript);
  expect(s().receiving).toBe(false);
  expect(s().steps).toHaveLength(2);
});

test("题目 A 播放至完成态（status 为 finished 且 awaitingContinue 为 true）后切题 reset：回到 idle、清空步骤、清除 awaitingContinue 与 receiving", () => {
  s().loadScript(scriptA);
  s().play();
  expect(s().status).toBe("playing");

  s().next(); // index 1
  s().next(); // finished
  s().setAwaitingContinue(true);
  expect(s().status).toBe("finished");
  expect(s().awaitingContinue).toBe(true);

  const prevGen = s().generation;
  s().reset();

  expect(s().generation).toBe(prevGen + 1);
  expect(s().status).toBe("idle");
  expect(s().steps).toEqual([]);
  expect(s().script).toBeNull();
  expect(s().currentIndex).toBe(0);
  expect(s().awaitingContinue).toBe(false);
  expect(s().receiving).toBe(false);
  expect(s().replaying).toBe(false);
});

test("播放中途切题（mid-play switch）：重置播放状态并丢弃旧题目后续流事件", () => {
  s().beginStream(scriptA);
  const guardA = { generation: s().generation, problemSlug: scriptA.problemSlug };

  s().appendStep(step1, guardA);
  s().setAwaitingContinue(true);
  expect(s().status).toBe("playing");
  expect(s().currentIndex).toBe(0);
  expect(s().awaitingContinue).toBe(true);
  expect(s().receiving).toBe(true);

  // 中途切题 reset
  s().reset();
  expect(s().status).toBe("idle");
  expect(s().steps).toEqual([]);
  expect(s().currentIndex).toBe(0);
  expect(s().awaitingContinue).toBe(false);
  expect(s().receiving).toBe(false);

  // 旧流迟到的 step / complete 被拦截，不会重新触发“下一步准备中”或“讲完了”
  s().appendStep(step2, guardA);
  s().completeStream(scriptA, guardA);
  expect(s().status).toBe("idle");
  expect(s().steps).toEqual([]);
  expect(s().receiving).toBe(false);
});

test("beginStream 把 answersReady 置为 false 并保留 answers；只有 clearAnswers 清空 map", () => {
  const answer: StepAnswer = {
    v: 1,
    id: "keep",
    stepId: "s1",
    question: "为什么",
    selection: { mode: "single", bbox: { x: 0, y: 0, width: 1, height: 1 }, targets: [] },
    segments: [{ id: "seg-1", narration: "因为" }],
    createdAt: "2026-10-13T00:00:00.000Z",
  };
  s().loadScript(scriptA);
  s().setAnswers({ s1: [answer] });
  usePlayerStore.setState({ answersReady: true });
  expect(s().answersReady).toBe(true);
  expect(s().answers.s1?.[0]?.id).toBe("keep");

  s().beginStream(scriptB);
  expect(s().answersReady).toBe(false);
  expect(s().answers.s1?.[0]?.id).toBe("keep");
  expect(s().answers.s1).toHaveLength(1);

  s().clearAnswers();
  expect(s().answers.s1).toBeUndefined();
  expect(Object.keys(s().answers)).toHaveLength(0);
  expect(s().answersReady).toBe(false);
});
