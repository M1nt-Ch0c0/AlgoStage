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

test("awaitingContinue 时下一步按钮可见文字为下一步且热区至少 44px，点击推进", async () => {
  await act(async () => {
    setStoreState({ awaitingContinue: true });
  });
  const button = container.querySelector<HTMLButtonElement>('button[aria-label="下一步"]')!;
  expect(button.textContent).toBe("下一步");
  expect(button.classList.contains("min-h-11")).toBe(true);
  expect(button.classList.contains("min-w-11")).toBe(true);
  await act(async () => button.click());
  expect(usePlayerStore.getState().currentIndex).toBe(1);
  expect(usePlayerStore.getState().awaitingContinue).toBe(false);
});

test("最后一步默认模式下「下一步」可点，点击、Space、→ 都进入完成态", async () => {
  async function armLastStep() {
    await act(async () => {
      setStoreState({
        status: "playing",
        currentIndex: script.steps.length - 1,
        awaitingContinue: true,
        receiving: false,
      });
    });
  }

  await armLastStep();
  const button = container.querySelector<HTMLButtonElement>('button[aria-label="下一步"]')!;
  expect(button.disabled).toBe(false);
  expect(button.textContent).toBe("下一步");
  await act(async () => button.click());
  expect(usePlayerStore.getState()).toMatchObject({ status: "finished", currentIndex: 2 });

  await armLastStep();
  await act(async () => {
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
  });
  expect(usePlayerStore.getState()).toMatchObject({ status: "finished", currentIndex: 2 });

  await armLastStep();
  await act(async () => {
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  });
  expect(usePlayerStore.getState()).toMatchObject({ status: "finished", currentIndex: 2 });
});

test("非 awaitingContinue 时下一步保持图标按钮", async () => {
  const button = container.querySelector<HTMLButtonElement>('button[aria-label="下一步"]')!;
  expect(button.textContent).toBe("");
  expect(button.classList.contains("min-h-11")).toBe(false);
  expect(button.classList.contains("size-8")).toBe(true);
});

function stubPointer(coarse: boolean) {
  const original = window.matchMedia.bind(window);
  vi.stubGlobal("matchMedia", (query: string) => {
    if (query !== "(pointer: coarse)") return original(query);
    return {
      matches: coarse,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    };
  });
}

/** useCoarsePointer 只在挂载时读 matchMedia，换指针后要重新挂载。 */
async function remountControls() {
  await act(async () => root.unmount());
  root = createRoot(container);
  await act(async () => root.render(createElement(PlayerControls)));
}

test("粗指针且等待继续、下一步已就绪时，控制条显示点「下一步」继续", async () => {
  stubPointer(true);
  await act(async () => setStoreState({ awaitingContinue: true }));
  await remountControls();
  const hint = container.querySelector<HTMLElement>("[data-testid='continue-hint']");
  expect(hint?.textContent).toBe("点「下一步」继续");
  expect(hint?.getAttribute("role")).toBe("status");
  expect(hint?.getAttribute("aria-live")).toBe("polite");
  expect(container.textContent).toContain("第 1 / 3 步");
});

test("细指针等待继续时控制条不显示点「下一步」继续", async () => {
  stubPointer(false);
  await act(async () => setStoreState({ awaitingContinue: true }));
  await remountControls();
  expect(container.querySelector("[data-testid='continue-hint']")).toBeNull();
  expect(container.textContent).not.toContain("点「下一步」继续");
  expect(container.textContent).toContain("第 1 / 3 步");
});

test("粗指针且下一步准备中时控制条不显示点「下一步」继续", async () => {
  stubPointer(true);
  await act(async () => {
    setStoreState({
      awaitingContinue: true,
      receiving: true,
      currentIndex: script.steps.length - 1,
    });
  });
  await remountControls();
  expect(container.querySelector("[data-testid='continue-hint']")).toBeNull();
  expect(container.textContent).not.toContain("点「下一步」继续");
  expect(container.textContent).not.toContain("下一步准备中…");
  expect(container.textContent).toContain("第 3 / 3 步");
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
