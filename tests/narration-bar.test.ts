// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import NarrationBar from "../components/board/narration-bar";
import { usePlayerStore } from "../lib/player/store";
import type { TeachingScript } from "../lib/teaching/types";

const sentences = ["第一句从头解释算法，之后再介绍代码。", "第二句说明为什么需要使用哈希表。"]; 
const script: TeachingScript = {
  problemSlug: "two-sum", mode: "lecture", language: "zh", solutionLanguage: "typescript",
  steps: sentences.map((narration, i) => ({ id: `s${i + 1}`, narration, targets: [{ kind: "code-line", start: i + 1 }], effects: [], dwellMs: 5000 })),
};
let root: Root, container: HTMLDivElement;
const visible = () => container.querySelectorAll("p")[1].textContent;
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  usePlayerStore.getState().reset(); usePlayerStore.getState().loadScript(script);
  container = document.createElement("div"); document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  usePlayerStore.getState().reset(); container.remove();
  vi.useRealTimers(); vi.unstubAllGlobals();
});

test.each(["paused", "interrupted", "idle"] as const)("%s 状态切步骤立即显示整句", async status => {
  usePlayerStore.setState({ status });
  await act(async () => root.render(createElement(NarrationBar)));
  expect(visible()).toBe(sentences[0]);
  await act(async () => usePlayerStore.getState().goto(1));
  expect(visible()).toBe(sentences[1]);
  await act(async () => vi.advanceTimersByTimeAsync(500));
  expect(visible()).toBe(sentences[1]);
});

test("手动暂停补全正在打字的句子，恢复播放不重新打字", async () => {
  usePlayerStore.getState().play();
  await act(async () => root.render(createElement(NarrationBar)));
  expect(visible()).toBe("");
  await act(async () => vi.advanceTimersByTimeAsync(250));
  expect(visible()!.length).toBeGreaterThan(0);
  expect(visible()!.length).toBeLessThan(sentences[0].length);
  await act(async () => usePlayerStore.getState().pause());
  expect(visible()).toBe(sentences[0]);
  await act(async () => usePlayerStore.getState().play());
  expect(visible()).toBe(sentences[0]);
});

test("仅 playing 切到新步骤时清零，随后继续逐字显示", async () => {
  usePlayerStore.getState().play();
  await act(async () => root.render(createElement(NarrationBar)));
  await act(async () => vi.advanceTimersByTimeAsync(250));
  await act(async () => usePlayerStore.getState().goto(1));
  expect(visible()).toBe("");
  await act(async () => vi.advanceTimersByTimeAsync(250));
  expect(visible()!.length).toBeGreaterThan(0);
  expect(visible()!.length).toBeLessThan(sentences[1].length);
});
