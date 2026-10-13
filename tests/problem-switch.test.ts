// @vitest-environment node
import { afterEach, expect, test, vi } from "vitest";
import { switchProblemForPlayback } from "../lib/player/load-lecture";
import { usePlayerStore, type StreamGuard } from "../lib/player/store";
import type { TeachingScript, TeachingStep } from "../lib/teaching/types";

const stepA1: TeachingStep = { id: "a1", narration: "A 第一步", targets: [], effects: [] };
const stepA2: TeachingStep = { id: "a2", narration: "A 第二步", targets: [], effects: [] };
const stepB1: TeachingStep = { id: "b1", narration: "B 第一步", targets: [], effects: [] };

const scriptA: TeachingScript = {
  problemSlug: "two-sum",
  mode: "lecture",
  language: "zh",
  solutionLanguage: "typescript",
  steps: [stepA1, stepA2],
};

afterEach(() => {
  usePlayerStore.getState().reset();
  vi.restoreAllMocks();
});

test("switch mid-play: aborts lecture, clears lecture UI, and resets store to idle", () => {
  const store = usePlayerStore.getState();
  store.loadScript(scriptA);
  store.play();
  store.next();
  expect(usePlayerStore.getState()).toMatchObject({
    status: "playing",
    currentIndex: 1,
    script: scriptA,
  });

  const abort = vi.fn();
  let busy = true;
  switchProblemForPlayback({
    abort,
    clearLectureUi: () => {
      busy = false;
    },
    reset: usePlayerStore.getState().reset,
  });

  expect(abort).toHaveBeenCalledTimes(1);
  expect(busy).toBe(false);
  expect(usePlayerStore.getState()).toMatchObject({
    status: "idle",
    steps: [],
    script: null,
    currentIndex: 0,
  });
});

test("switch while finished (end panel): clears finished status, awaitingContinue, and receiving", () => {
  const store = usePlayerStore.getState();
  store.loadScript(scriptA);
  store.play();
  store.next();
  store.next();
  store.setAwaitingContinue(true);
  expect(usePlayerStore.getState()).toMatchObject({
    status: "finished",
    awaitingContinue: true,
  });

  switchProblemForPlayback({
    abort: () => {},
    clearLectureUi: () => {},
    reset: usePlayerStore.getState().reset,
  });

  const after = usePlayerStore.getState();
  expect(after.status).not.toBe("finished");
  expect(after.status).toBe("idle");
  expect(after.awaitingContinue).toBe(false);
  expect(after.receiving).toBe(false);
});

test("switch during generation: late stream events with old guard do not affect new problem B", () => {
  const store = usePlayerStore.getState();
  store.beginStream({
    problemSlug: "two-sum",
    mode: "lecture",
    language: "zh",
    solutionLanguage: "typescript",
  });
  const guardA: StreamGuard = {
    generation: usePlayerStore.getState().generation,
    problemSlug: "two-sum",
  };
  store.appendStep(stepA1, guardA);
  expect(usePlayerStore.getState().steps).toEqual([stepA1]);

  switchProblemForPlayback({
    abort: () => {},
    clearLectureUi: () => {},
    reset: usePlayerStore.getState().reset,
  });

  store.beginStream({
    problemSlug: "3sum",
    mode: "lecture",
    language: "zh",
    solutionLanguage: "typescript",
  });
  const guardB: StreamGuard = {
    generation: usePlayerStore.getState().generation,
    problemSlug: "3sum",
  };
  store.appendStep(stepB1, guardB);

  // Late events from problem A with stale guardA
  store.appendStep(stepA2, guardA);
  store.updateStep({ ...stepB1, narration: "被 A 污染" }, guardA);
  store.completeStream(scriptA, guardA);

  const state = usePlayerStore.getState();
  expect(state.script?.problemSlug).toBe("3sum");
  expect(state.steps).toEqual([stepB1]);
  expect(state.receiving).toBe(true);
});
