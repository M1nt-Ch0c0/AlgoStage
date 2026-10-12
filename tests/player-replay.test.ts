import { afterEach, expect, test, vi } from "vitest";
import { usePlayerStore } from "../lib/player/store";
import type { TeachingScript } from "../lib/teaching/types";

const script: TeachingScript = {
  problemSlug: "3sum", mode: "lecture", language: "zh", solutionLanguage: "typescript",
  steps: [
    { id: "s1", narration: "第一步", targets: [], effects: [] },
    { id: "s2", narration: "第二步", targets: [], effects: [] },
    { id: "s3", narration: "第三步", targets: [], effects: [] },
  ],
};
afterEach(() => { usePlayerStore.getState().reset(); vi.restoreAllMocks(); });

function finishStreamed() {
  const store = usePlayerStore.getState();
  store.beginStream(script);
  for (const step of script.steps) { store.appendStep(step); store.next(); }
  store.completeStream(script);
  usePlayerStore.setState({ currentIndex: 2 });
  store.next();
  expect(usePlayerStore.getState()).toMatchObject({ status: "finished", receiving: false });
}

test("完成→重播：不发请求，从第 0 步播放已有步骤", () => {
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  finishStreamed();
  const before = usePlayerStore.getState().steps;
  usePlayerStore.getState().replay();
  expect(usePlayerStore.getState()).toMatchObject({ status: "playing", currentIndex: 0, receiving: false });
  expect(usePlayerStore.getState().steps).toBe(before);
  usePlayerStore.getState().next();
  usePlayerStore.getState().next();
  expect(usePlayerStore.getState()).toMatchObject({ currentIndex: 2, status: "playing" });
  usePlayerStore.getState().next();
  expect(usePlayerStore.getState().status).toBe("finished");
  expect(fetchSpy).not.toHaveBeenCalled();
});

test("重播中暂停后可从暂停步继续", () => {
  finishStreamed();
  const store = usePlayerStore.getState();
  store.replay();
  store.next();
  store.pause();
  expect(usePlayerStore.getState()).toMatchObject({ status: "paused", currentIndex: 1 });
  store.play();
  expect(usePlayerStore.getState()).toMatchObject({ status: "playing", currentIndex: 1 });
});

test("流式中或无步骤时 replay 不生效", () => {
  const store = usePlayerStore.getState();
  store.replay();
  expect(usePlayerStore.getState().status).toBe("idle");
  store.beginStream(script);
  store.appendStep(script.steps[0]);
  store.appendStep(script.steps[1]);
  store.next();
  store.replay();
  expect(usePlayerStore.getState()).toMatchObject({ currentIndex: 1, receiving: true });
});

test("完成→重新生成：beginStream 清空旧步骤，从新流开始", () => {
  finishStreamed();
  const store = usePlayerStore.getState();
  store.beginStream(script);
  expect(usePlayerStore.getState()).toMatchObject({ status: "streaming", steps: [], currentIndex: 0, receiving: true });
});
