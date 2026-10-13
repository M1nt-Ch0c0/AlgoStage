// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import PlayerControls from "../components/board/player-controls";
import { usePlayerStore } from "../lib/player/store";
import type { TeachingScript } from "../lib/teaching/types";

type AutoplayState = {
  autoAdvance: boolean;
  setAutoAdvance(v: boolean): void;
  awaitingContinue: boolean;
  setAwaitingContinue(v: boolean): void;
};
type StoreState = ReturnType<typeof usePlayerStore.getState>;
const setStoreState = (patch: Partial<StoreState & AutoplayState>) =>
  usePlayerStore.setState(patch as unknown as Partial<StoreState>);

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

let root: Root, container: HTMLDivElement;

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  usePlayerStore.getState().reset();
  usePlayerStore.getState().loadScript(script);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(PlayerControls)));
});

afterEach(async () => {
  await act(async () => root.unmount());
  usePlayerStore.getState().reset();
  container.remove();
  vi.unstubAllGlobals();
});

test("输入框、textarea、contenteditable 与 .monaco-editor 子节点内的 Space 和 ArrowRight 不触发步进", async () => {
  await act(async () => {
    setStoreState({ awaitingContinue: true });
  });

  const input = document.createElement("input");
  const textarea = document.createElement("textarea");
  const editable = document.createElement("div");
  editable.setAttribute("contenteditable", "true");
  const monaco = document.createElement("div");
  monaco.className = "monaco-editor";
  const monacoChild = document.createElement("div");
  monaco.append(monacoChild);

  container.append(input, textarea, editable, monaco);

  for (const target of [input, textarea, editable, monacoChild]) {
    await act(async () => {
      target.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
      target.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    expect(usePlayerStore.getState().currentIndex).toBe(0);
  }
});

test("awaitingContinue 时在 document.body 按 Space 或 ArrowRight 推进步骤", async () => {
  await act(async () => {
    setStoreState({ awaitingContinue: true });
  });
  expect(usePlayerStore.getState().currentIndex).toBe(0);

  await act(async () => {
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
  });
  expect(usePlayerStore.getState().currentIndex).toBe(1);

  await act(async () => {
    setStoreState({ awaitingContinue: true });
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  });
  expect(usePlayerStore.getState().currentIndex).toBe(2);
});

test("非 awaitingContinue 且 paused 时按 Space 切换为 playing 且不改变 currentIndex", async () => {
  await act(async () => {
    setStoreState({ status: "paused", awaitingContinue: false });
  });
  expect(usePlayerStore.getState().currentIndex).toBe(0);

  await act(async () => {
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
  });
  expect(usePlayerStore.getState().status).toBe("playing");
  expect(usePlayerStore.getState().currentIndex).toBe(0);
});
