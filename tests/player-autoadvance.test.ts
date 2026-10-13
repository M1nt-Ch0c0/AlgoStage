// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from "vitest";
import { AUTO_ADVANCE_KEY, readAutoAdvance, usePlayerStore } from "../lib/player/store";
import type { TeachingScript } from "../lib/teaching/types";

const script: TeachingScript = {
  problemSlug: "3sum",
  mode: "lecture",
  language: "zh",
  solutionLanguage: "typescript",
  steps: [
    { id: "s1", narration: "第一步", targets: [], effects: [] },
    { id: "s2", narration: "第二步", targets: [], effects: [] },
  ],
};

afterEach(() => {
  localStorage.removeItem(AUTO_ADVANCE_KEY);
  usePlayerStore.getState().setAutoAdvance(false);
  usePlayerStore.getState().reset();
  vi.restoreAllMocks();
});

test("默认不自动翻页，且未在等待继续", () => {
  localStorage.removeItem(AUTO_ADVANCE_KEY);
  expect(readAutoAdvance()).toBe(false);
  expect(usePlayerStore.getState().autoAdvance).toBe(false);
  expect(usePlayerStore.getState().awaitingContinue).toBe(false);
});

test("setAutoAdvance(true) 写入 localStorage", () => {
  usePlayerStore.getState().setAutoAdvance(true);
  expect(localStorage.getItem("algostage.autoAdvance")).toBe("true");
  expect(localStorage.getItem(AUTO_ADVANCE_KEY)).toBe("true");
  expect(usePlayerStore.getState().autoAdvance).toBe(true);
});

test("reset() 保留 autoAdvance，并清除 awaitingContinue", () => {
  usePlayerStore.getState().setAutoAdvance(true);
  usePlayerStore.getState().setAwaitingContinue(true);
  usePlayerStore.getState().reset();
  expect(usePlayerStore.getState().autoAdvance).toBe(true);
  expect(usePlayerStore.getState().awaitingContinue).toBe(false);
  expect(localStorage.getItem(AUTO_ADVANCE_KEY)).toBe("true");
});

test("next() 在等待继续时仍前进，并清除 awaitingContinue，状态保持 playing", () => {
  const store = usePlayerStore.getState();
  store.loadScript(script);
  store.play();
  usePlayerStore.setState({ awaitingContinue: true });
  expect(usePlayerStore.getState()).toMatchObject({ status: "playing", currentIndex: 0, awaitingContinue: true });
  usePlayerStore.getState().next();
  expect(usePlayerStore.getState()).toMatchObject({
    status: "playing",
    currentIndex: 1,
    awaitingContinue: false,
  });
});

test("localStorage 抛错时 setAutoAdvance 不抛出，仍更新状态", () => {
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("quota");
  });
  expect(() => usePlayerStore.getState().setAutoAdvance(true)).not.toThrow();
  expect(usePlayerStore.getState().autoAdvance).toBe(true);
});
