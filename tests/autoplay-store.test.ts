// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { usePlayerStore } from "../lib/player/store";
import type { TeachingScript } from "../lib/teaching/types";

type AutoplayState = {
  autoAdvance: boolean;
  setAutoAdvance(v: boolean): void;
  awaitingContinue: boolean;
  setAwaitingContinue(v: boolean): void;
};

const s = () =>
  usePlayerStore.getState() as unknown as ReturnType<typeof usePlayerStore.getState> & AutoplayState;

const script: TeachingScript = {
  problemSlug: "two-sum",
  mode: "lecture",
  language: "zh",
  solutionLanguage: "typescript",
  steps: [
    { id: "s1", narration: "第一步", targets: [], effects: [] },
    { id: "s2", narration: "第二步", targets: [], effects: [] },
    { id: "s3", narration: "第三步", targets: [], effects: [] },
  ],
};

beforeEach(() => {
  localStorage.clear();
  usePlayerStore.getState().reset();
});

afterEach(() => {
  usePlayerStore.getState().reset();
  vi.restoreAllMocks();
});

test("默认 autoAdvance 为 false，setAutoAdvance(true) 写入 localStorage 并在模块重载后保持", async () => {
  expect(s().autoAdvance).toBe(false);
  expect(s().awaitingContinue).toBe(false);

  s().setAutoAdvance(true);
  expect(s().autoAdvance).toBe(true);
  expect(localStorage.getItem("algostage.autoAdvance")).toBe("true");

  vi.resetModules();
  const { usePlayerStore: freshStore } = await import("../lib/player/store");
  const freshState = freshStore.getState() as unknown as ReturnType<typeof freshStore.getState> & AutoplayState;
  expect(freshState.autoAdvance).toBe(true);
});

test("localStorage 值为非法字符串 ('garbage') 时导入不报错且 autoAdvance 为 false", async () => {
  localStorage.setItem("algostage.autoAdvance", "garbage");
  vi.resetModules();
  let freshStore: typeof usePlayerStore | undefined;
  await expect(
    import("../lib/player/store").then((m) => {
      freshStore = m.usePlayerStore;
    }),
  ).resolves.toBeUndefined();
  const freshState = freshStore!.getState() as unknown as ReturnType<typeof usePlayerStore.getState> & AutoplayState;
  expect(freshState.autoAdvance).toBe(false);
});

test("localStorage.getItem 抛出异常时导入不报错且 autoAdvance 为 false", async () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("QuotaExceeded / SecurityError");
  });
  vi.resetModules();
  let freshStore: typeof usePlayerStore | undefined;
  await expect(
    import("../lib/player/store").then((m) => {
      freshStore = m.usePlayerStore;
    }),
  ).resolves.toBeUndefined();
  const freshState = freshStore!.getState() as unknown as ReturnType<typeof usePlayerStore.getState> & AutoplayState;
  expect(freshState.autoAdvance).toBe(false);
});

test("切题动作 (loadScript / beginStream / reset) 保留 autoAdvance 但清除 awaitingContinue", () => {
  s().setAutoAdvance(true);

  s().setAwaitingContinue(true);
  expect(s().awaitingContinue).toBe(true);
  s().loadScript(script);
  expect(s().autoAdvance).toBe(true);
  expect(s().awaitingContinue).toBe(false);

  s().setAwaitingContinue(true);
  expect(s().awaitingContinue).toBe(true);
  s().beginStream(script);
  expect(s().autoAdvance).toBe(true);
  expect(s().awaitingContinue).toBe(false);

  s().setAwaitingContinue(true);
  expect(s().awaitingContinue).toBe(true);
  s().reset();
  expect(s().autoAdvance).toBe(true);
  expect(s().awaitingContinue).toBe(false);
});

test("next / prev / goto / replay 清除 awaitingContinue，且 awaitingContinue 下 next 推进 currentIndex", () => {
  s().loadScript(script);

  s().setAwaitingContinue(true);
  expect(s().currentIndex).toBe(0);
  s().next();
  expect(s().currentIndex).toBe(1);
  expect(s().awaitingContinue).toBe(false);

  s().setAwaitingContinue(true);
  s().prev();
  expect(s().currentIndex).toBe(0);
  expect(s().awaitingContinue).toBe(false);

  s().setAwaitingContinue(true);
  s().goto(2);
  expect(s().currentIndex).toBe(2);
  expect(s().awaitingContinue).toBe(false);

  // 推进到完成态后测试 replay
  s().next();
  expect(s().status).toBe("finished");
  s().setAwaitingContinue(true);
  s().replay();
  expect(s().status).toBe("playing");
  expect(s().currentIndex).toBe(0);
  expect(s().awaitingContinue).toBe(false);
});
