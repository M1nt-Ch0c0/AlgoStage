// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import NarrationBar from "../components/board/narration-bar";
import PlayerControls from "../components/board/player-controls";
import { usePlayerStore } from "../lib/player/store";
import type { TeachingScript } from "../lib/teaching/types";

type AutoplayState = {
  autoAdvance: boolean;
  autoAdvanceHydrated: boolean;
  setAutoAdvance(v: boolean): void;
  hydrateAutoAdvance(): void;
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

function pressKey(target: EventTarget, key: string) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

test("aria-modal 对话框打开时忽略 Space 与 ArrowRight，关掉后快捷键恢复", async () => {
  await act(async () => {
    setStoreState({ status: "paused", awaitingContinue: false, currentIndex: 0 });
  });

  const dialog = document.createElement("div");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  document.body.append(dialog);
  document.body.focus();

  await act(async () => {
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  });
  expect(usePlayerStore.getState()).toMatchObject({ status: "paused", currentIndex: 0 });

  dialog.remove();

  await act(async () => {
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
  });
  expect(usePlayerStore.getState()).toMatchObject({ status: "playing", currentIndex: 0 });

  await act(async () => {
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  });
  expect(usePlayerStore.getState().currentIndex).toBe(1);
});

test("焦点在 button 或链接上时只放行 Space，方向键仍步进；对话框内全部按键忽略", async () => {
  await act(async () => {
    setStoreState({ awaitingContinue: true, speed: 2 });
  });

  const speedButton = [...container.querySelectorAll("button")].find((el) => el.textContent === "1x")!;
  let speedClicks = 0;
  speedButton.addEventListener("click", () => {
    speedClicks += 1;
  });
  const speedEvent = pressKey(speedButton, " ");
  expect(speedEvent.defaultPrevented).toBe(false);
  expect(usePlayerStore.getState().currentIndex).toBe(0);
  // happy-dom 不实现按钮的键盘激活，浏览器里未 preventDefault 的 Space 会点下按钮。
  if (!speedClicks) speedButton.click();
  expect(speedClicks).toBe(1);
  expect(usePlayerStore.getState().speed).toBe(1);
  expect(usePlayerStore.getState().currentIndex).toBe(0);

  await act(async () => {
    pressKey(speedButton, "ArrowRight");
  });
  expect(usePlayerStore.getState().currentIndex).toBe(1);

  const link = document.createElement("a");
  link.href = "/roadmap";
  link.textContent = "回路线图";
  container.append(link);
  const linkSpace = pressKey(link, " ");
  expect(linkSpace.defaultPrevented).toBe(false);
  expect(usePlayerStore.getState().currentIndex).toBe(1);
  await act(async () => {
    pressKey(link, "ArrowRight");
  });
  expect(usePlayerStore.getState().currentIndex).toBe(2);

  const dialog = document.createElement("div");
  dialog.setAttribute("role", "dialog");
  const confirm = document.createElement("button");
  confirm.type = "button";
  confirm.textContent = "确定重新生成";
  let confirmClicks = 0;
  confirm.addEventListener("click", () => {
    confirmClicks += 1;
  });
  dialog.append(confirm);
  document.body.append(dialog);
  const dialogEvent = pressKey(confirm, " ");
  expect(dialogEvent.defaultPrevented).toBe(false);
  expect(usePlayerStore.getState().currentIndex).toBe(2);
  if (!confirmClicks) confirm.click();
  expect(confirmClicks).toBe(1);
  expect(usePlayerStore.getState().currentIndex).toBe(2);
  const dialogArrow = pressKey(confirm, "ArrowRight");
  expect(dialogArrow.defaultPrevented).toBe(false);
  expect(usePlayerStore.getState().currentIndex).toBe(2);
  dialog.remove();
});

test("after clicking 下一步, → still advances", async () => {
  await act(async () => {
    setStoreState({ awaitingContinue: true, currentIndex: 0 });
  });
  const button = container.querySelector<HTMLButtonElement>('button[aria-label="下一步"]')!;
  await act(async () => button.click());
  expect(usePlayerStore.getState().currentIndex).toBe(1);
  button.focus();
  expect(document.activeElement).toBe(button);

  await act(async () => {
    setStoreState({ awaitingContinue: true });
    pressKey(button, "ArrowRight");
  });
  expect(usePlayerStore.getState().currentIndex).toBe(2);
});

test("完成态焦点在「重播」上按 Space 不拦截，激活按钮后从第 0 步重播", async () => {
  await act(async () => {
    setStoreState({ status: "finished", currentIndex: script.steps.length - 1, awaitingContinue: false });
    root.render(
      createElement("div", null, createElement(PlayerControls), createElement(NarrationBar)),
    );
  });

  const replay = [...container.querySelectorAll("button")].find((el) => el.textContent === "重播")!;
  const event = pressKey(replay, " ");
  expect(event.defaultPrevented).toBe(false);
  expect(usePlayerStore.getState()).toMatchObject({ status: "finished", currentIndex: 2 });
  // happy-dom 不实现按钮的键盘激活，浏览器里未 preventDefault 的 Space 会点下「重播」。
  if (usePlayerStore.getState().status === "finished") replay.click();
  expect(usePlayerStore.getState()).toMatchObject({ status: "playing", currentIndex: 0 });
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

test("finished 且备课中时结束面板不出现，Space 与 → 也不拦截", async () => {
  await act(async () => {
    setStoreState({ status: "finished", currentIndex: script.steps.length - 1, awaitingContinue: false });
    root.render(
      createElement(
        "div",
        null,
        createElement(PlayerControls, { lectureBusy: true }),
        createElement(NarrationBar, { lectureBusy: true }),
      ),
    );
  });

  expect(container.textContent).not.toContain("讲完了");
  expect([...container.querySelectorAll("button")].some((el) => el.textContent === "重播")).toBe(false);

  await act(async () => {
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
  });
  // 面板未显示，Space 不按结束面板拦截，从完成态回到播放。
  expect(usePlayerStore.getState()).toMatchObject({ status: "playing", currentIndex: 2 });
  expect(container.textContent).not.toContain("讲完了");

  await act(async () => {
    setStoreState({ status: "finished", currentIndex: script.steps.length - 1, awaitingContinue: true });
  });
  await act(async () => {
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  });
  expect(usePlayerStore.getState()).toMatchObject({ status: "finished", currentIndex: 2 });
  expect(container.textContent).not.toContain("讲完了");

  await act(async () => {
    root.render(
      createElement(
        "div",
        null,
        createElement(PlayerControls),
        createElement(NarrationBar),
      ),
    );
  });
  expect(container.textContent).toContain("讲完了");

  await act(async () => {
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  });
  expect(usePlayerStore.getState()).toMatchObject({ status: "finished", currentIndex: 2 });
  expect(container.textContent).toContain("讲完了");
});

test("完成态下面板已显示时 Space 与 → 不离开 finished，也不改 currentIndex", async () => {
  await act(async () => {
    setStoreState({ status: "finished", currentIndex: script.steps.length - 1, awaitingContinue: false });
  });

  await act(async () => {
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
  });
  expect(usePlayerStore.getState()).toMatchObject({ status: "finished", currentIndex: 2 });

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

test("粗指针下步进按钮热区至少 44px，时间线圆点视觉仍是细条且热区不靠负边距重叠", async () => {
  const prev = container.querySelector<HTMLButtonElement>('button[aria-label="上一步"]')!;
  const play = container.querySelector<HTMLButtonElement>('button[aria-label="播放"]')!;
  const next = container.querySelector<HTMLButtonElement>('button[aria-label="下一步"]')!;
  for (const button of [prev, play, next]) {
    expect(button.className).toContain("pointer-coarse:size-11");
  }
  expect(next.classList.contains("size-8")).toBe(true);
  expect(play.className).toContain("size-9");
  expect(play.className).not.toContain("size-11 ");

  const dots = [...container.querySelectorAll<HTMLButtonElement>('button[aria-label^="跳到第"]')];
  expect(dots.length).toBe(script.steps.length);
  for (const dot of dots) {
    expect(dot.className).toContain("h-5");
    expect(dot.className).toContain("pointer-coarse:h-11");
    expect(dot.className).not.toMatch(/-m[xytrbl]?-/);
    const bar = dot.querySelector("span")!;
    expect(bar.className).toContain("h-1.5");
    expect(bar.className).toContain("w-full");
  }
});

test("细指针类名不把步进按钮和圆点放大成常驻 44px", async () => {
  const prev = container.querySelector<HTMLButtonElement>('button[aria-label="上一步"]')!;
  const next = container.querySelector<HTMLButtonElement>('button[aria-label="下一步"]')!;
  expect(prev.classList.contains("size-8")).toBe(true);
  expect(prev.classList.contains("size-11")).toBe(false);
  expect(next.classList.contains("min-h-11")).toBe(false);
  const dot = container.querySelector<HTMLButtonElement>('button[aria-label="跳到第 1 步"]')!;
  expect(dot.classList.contains("h-5")).toBe(true);
  expect(dot.classList.contains("h-11")).toBe(false);
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

test("未读 localStorage 时自动播放是禁用占位且没有 aria-pressed，读完后与存储一致", async () => {
  localStorage.setItem("algostage.autoAdvance", "true");
  await act(async () => root.unmount());
  await act(async () => {
    setStoreState({ autoAdvance: false, autoAdvanceHydrated: false });
  });

  let releaseHydrate: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    releaseHydrate = resolve;
  });
  const realHydrate = usePlayerStore.getState().hydrateAutoAdvance;
  usePlayerStore.setState({
    hydrateAutoAdvance: () => {
      void gate.then(() => realHydrate());
    },
  });

  root = createRoot(container);
  await act(async () => root.render(createElement(PlayerControls)));
  const placeholder = [...container.querySelectorAll("button")].find((el) => el.textContent === "自动播放")!;
  expect(placeholder.getAttribute("aria-busy")).toBe("true");
  expect(placeholder.hasAttribute("aria-pressed")).toBe(false);
  expect(placeholder.disabled).toBe(true);
  expect(usePlayerStore.getState()).toMatchObject({ autoAdvance: false, autoAdvanceHydrated: false });

  await act(async () => {
    releaseHydrate!();
    await gate;
  });
  const hydrated = [...container.querySelectorAll("button")].find((el) => el.textContent === "自动播放")!;
  expect(hydrated.getAttribute("aria-pressed")).toBe("true");
  expect(hydrated.hasAttribute("aria-busy")).toBe(false);
  expect(hydrated.disabled).toBe(false);
  expect(usePlayerStore.getState().autoAdvance).toBe(true);
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
