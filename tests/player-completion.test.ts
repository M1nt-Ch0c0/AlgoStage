import { afterEach, expect, test } from "vitest";
import { usePlayerStore } from "../lib/player/store";
import type { TeachingScript } from "../lib/teaching/types";

const script: TeachingScript = {
  problemSlug: "3sum", mode: "lecture", language: "zh", solutionLanguage: "typescript",
  steps: [
    { id: "s1", narration: "找出和为零的三个数", targets: [{ kind: "statement", blockId: "intro" }], effects: [] },
    { id: "s2", narration: "先排序，让双指针可以按大小移动", targets: [{ kind: "code-line", start: 4 }], effects: [] },
  ],
};
afterEach(() => usePlayerStore.getState().reset());

test("流式逐步播完再 completeStream，回看排序步仍有锚点且能继续播放", () => {
  const store = usePlayerStore.getState();
  store.beginStream(script);
  for (const step of script.steps) {
    store.appendStep(step);
    expect(usePlayerStore.getState().status).toBe("playing");
    store.next();
  }
  expect(usePlayerStore.getState().status).toBe("streaming");
  store.completeStream(script);
  expect(usePlayerStore.getState()).toMatchObject({ status: "paused", receiving: false });
  store.goto(1);
  expect(usePlayerStore.getState().status).not.toBe("finished");
  expect(usePlayerStore.getState().steps[1].targets).toContainEqual({ kind: "code-line", start: 4 });
  store.play();
  expect(usePlayerStore.getState()).toMatchObject({ status: "playing", currentIndex: 1 });
});

test.each(["goto", "prev"] as const)("结束后 %s 进入 paused，当前步可继续播放", action => {
  const store = usePlayerStore.getState();
  store.loadScript(script);
  usePlayerStore.setState({ status: "finished", currentIndex: 1 });
  if (action === "goto") store.goto(1); else store.prev();
  expect(usePlayerStore.getState().status).toBe("paused");
  store.play();
  expect(usePlayerStore.getState()).toMatchObject({ status: "playing", currentIndex: action === "goto" ? 1 : 0 });
});

test.each([1, 50])("finished 可从当前有效步骤继续，无有效步骤时回到第零步：%i", index => {
  const store = usePlayerStore.getState();
  store.loadScript(script);
  usePlayerStore.setState({ status: "finished", currentIndex: index });
  store.play();
  expect(usePlayerStore.getState()).toMatchObject({ status: "playing", currentIndex: index === 1 ? 1 : 0 });
});

test("生成完成不会打断尚在播放的当前步骤", () => {
  const store = usePlayerStore.getState();
  store.beginStream(script);
  script.steps.forEach((step) => store.appendStep(step));
  store.completeStream(script);
  expect(usePlayerStore.getState()).toMatchObject({ status: "playing", currentIndex: 0, receiving: false });
});
