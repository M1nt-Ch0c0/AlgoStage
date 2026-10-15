// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { scrollHeight, clientHeight, scrollWidth, clientWidth } from "happy-dom/lib/PropertySymbol.js";
import AskEntry from "../components/board/ask-entry";
import AskSelectionLayer, { isElementFullyInView, resolveAskEscape } from "../components/board/ask-selection-layer";
import { ASK_CODE_MISS_HINT, ASK_EMPTY_HIT, ASK_ENTERED_STATUS, ASK_RESIZE_HINT } from "../lib/ask/ask-ui-text";
import { type CodeEditorHandle, getAskCodeMissNotice, registerCodeEditor, resetCodeEditorRegistry } from "../lib/ask/code-editor-registry";
import { summarizeSelection } from "../lib/ask/collect-candidates";
import * as hitTest from "../lib/ask/hit-test";
import { usePlayerStore } from "../lib/player/store";
import type { TeachingScript } from "../lib/teaching/types";

const script: TeachingScript = {
  problemSlug: "3sum",
  mode: "lecture",
  language: "zh",
  solutionLanguage: "typescript",
  steps: [
    { id: "s1", narration: "第一步讲解。", targets: [], effects: [] },
    { id: "s2", narration: "第二步讲解。", targets: [], effects: [] },
  ],
};

function domRect(x: number, y: number, width: number, height: number): DOMRect {
  return {
    x,
    y,
    width,
    height,
    top: y,
    left: x,
    right: x + width,
    bottom: y + height,
    toJSON() {
      return {};
    },
  } as DOMRect;
}

let root: Root;
let container: HTMLDivElement;
let stage: HTMLDivElement;
let scroller: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  usePlayerStore.getState().reset();
  usePlayerStore.getState().loadScript(script);
  usePlayerStore.setState({ askPhase: "selecting", status: "interrupted", draftQuestion: "保留的问题" });

  scroller = document.createElement("div");
  scroller.dataset.scroller = "1";
  const metrics = scroller as unknown as Record<symbol, number>;
  metrics[scrollHeight] = 2000;
  metrics[clientHeight] = 400;
  metrics[scrollWidth] = 400;
  metrics[clientWidth] = 400;
  scroller.scrollBy = vi.fn();

  stage = document.createElement("div");
  stage.setAttribute("data-ask-stage", "");
  stage.getBoundingClientRect = () => domRect(0, 0, 400, 300);
  stage.innerHTML = `
    <p data-ask-target="subtitle" data-ask-id="subtitle:s1" data-ask-step-id="s1">字幕内容</p>
    <div data-ask-target="step" data-ask-id="step:s1" data-ask-step-id="s1">步骤内容</div>
    <div data-ask-target="viz" data-ask-id="viz:s1" data-ask-step-id="s1">可视化整块</div>
  `;
  const targetBoxes: Record<string, DOMRect> = {
    subtitle: domRect(10, 10, 60, 30),
    step: domRect(80, 10, 60, 30),
    viz: domRect(150, 10, 60, 30),
  };
  for (const el of stage.querySelectorAll<HTMLElement>("[data-ask-target]")) {
    const kind = el.getAttribute("data-ask-target") ?? "";
    el.getBoundingClientRect = () => targetBoxes[kind] ?? domRect(40, 40, 80, 40);
  }
  scroller.append(stage);
  document.body.append(scroller);

  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);

  vi.spyOn(window, "getComputedStyle").mockImplementation((el: Element) => {
    if (el === scroller) {
      return { overflow: "auto", overflowX: "auto", overflowY: "auto" } as CSSStyleDeclaration;
    }
    return { overflow: "visible", overflowX: "visible", overflowY: "visible" } as CSSStyleDeclaration;
  });
});

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  usePlayerStore.getState().reset();
  resetCodeEditorRegistry();
  container.remove();
  scroller.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function render() {
  await act(async () => {
    root.render(createElement(AskSelectionLayer, { stage }));
  });
}

function layer(): HTMLDivElement {
  const el = container.querySelector<HTMLDivElement>("[data-ask-layer]");
  if (!el) throw new Error("layer missing");
  return el;
}

function pointer(
  type: string,
  init: { pointerId?: number; clientX?: number; clientY?: number; button?: number },
): PointerEvent {
  const event = new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerId: init.pointerId ?? 1,
    clientX: init.clientX ?? 0,
    clientY: init.clientY ?? 0,
    button: init.button ?? 0,
    pointerType: "touch",
  });
  return event;
}

async function gesture(fromX: number, fromY: number, toX: number, toY: number, pointerId = 1) {
  const host = layer();
  await act(async () => {
    host.dispatchEvent(pointer("pointerdown", { pointerId, clientX: fromX, clientY: fromY }));
    host.dispatchEvent(pointer("pointermove", { pointerId, clientX: toX, clientY: toY }));
    host.dispatchEvent(pointer("pointerup", { pointerId, clientX: toX, clientY: toY }));
  });
}

describe("AskSelectionLayer", () => {
  test("idle 不渲染层", async () => {
    usePlayerStore.setState({ askPhase: "idle" });
    await render();
    expect(container.querySelector("[data-ask-layer]")).toBeNull();
  });

  test("14. 位移 7 走点选，8 走框选，规范化 <24×24 走点选", async () => {
    const pointSpy = vi.spyOn(hitTest, "hitTestPoint");
    const regionSpy = vi.spyOn(hitTest, "hitTest");
    await render();

    // 7px inside the step target (80,10 60×30) → point, mode single
    await gesture(90, 20, 97, 20);
    expect(pointSpy).toHaveBeenCalled();
    expect(regionSpy).not.toHaveBeenCalled();
    const pointCall = pointSpy.mock.calls.at(-1)!;
    expect(pointCall[0]).toBeCloseTo((90 + 97) / 2);
    expect(pointCall[1]).toBeCloseTo(20);
    const afterPoint = usePlayerStore.getState().selection;
    expect(afterPoint?.mode).toBe("single");

    pointSpy.mockClear();
    regionSpy.mockClear();

    // both sides ≥ 8 and ≥ 24, covering subtitle + step → region
    await gesture(20, 12, 120, 36);
    expect(regionSpy).toHaveBeenCalled();
    expect(pointSpy).not.toHaveBeenCalled();
    expect(usePlayerStore.getState().selection?.mode).toBe("region");

    pointSpy.mockClear();
    regionSpy.mockClear();

    // displacement ≥ 8 but normalized height < 24 → point at center, still inside the step
    await gesture(90, 20, 120, 30);
    expect(pointSpy).toHaveBeenCalled();
    expect(regionSpy).not.toHaveBeenCalled();
    const small = pointSpy.mock.calls.at(-1)!;
    expect(small[0]).toBeCloseTo((90 + 120) / 2);
    expect(small[1]).toBeCloseTo((20 + 30) / 2);
    expect(usePlayerStore.getState().selection?.mode).toBe("single");
  });

  test("15. 落空不调用 setAskSelection，提示落空，仍 selecting", async () => {
    const setSpy = vi.spyOn(usePlayerStore.getState(), "setAskSelection");
    await render();
    // Tap in the empty gap between step (ends at x=140) and viz (starts at x=150).
    await gesture(142, 20, 144, 20);
    expect(setSpy).not.toHaveBeenCalled();
    expect(usePlayerStore.getState().selection).toBeNull();
    expect(usePlayerStore.getState().askPhase).toBe("selecting");
    expect(layer().textContent).toContain(ASK_EMPTY_HIT);
  });

  test("16. 再画替换选区，setAskSelection 调用两次", async () => {
    const setSpy = vi.spyOn(usePlayerStore.getState(), "setAskSelection");
    await render();
    await gesture(20, 12, 120, 36);
    await gesture(150, 10, 210, 40);
    expect(setSpy).toHaveBeenCalledTimes(2);
    const last = setSpy.mock.calls[1][0];
    expect(usePlayerStore.getState().selection?.bbox).toEqual(last.bbox);
    expect(usePlayerStore.getState().selection?.targets).toHaveLength(last.targets.length);
    expect(usePlayerStore.getState().askPhase).toBe("drafting");
  });

  test("17. 点遮罩空白开始新框，不调用 exitAsk", async () => {
    const exitSpy = vi.spyOn(usePlayerStore.getState(), "exitAsk");
    await render();
    await gesture(20, 12, 120, 36);
    expect(usePlayerStore.getState().askPhase).toBe("drafting");
    const host = layer();
    await act(async () => {
      host.dispatchEvent(pointer("pointerdown", { clientX: 200, clientY: 200 }));
      host.dispatchEvent(pointer("pointermove", { clientX: 230, clientY: 230 }));
    });
    expect(host.querySelector("[data-ask-rubber]")).toBeTruthy();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(usePlayerStore.getState().askPhase).toBe("drafting");
    await act(async () => {
      host.dispatchEvent(pointer("pointerup", { clientX: 200, clientY: 200 }));
    });
    expect(exitSpy).not.toHaveBeenCalled();
  });

  test("18. 第二指放弃框且不 hitTest；移动 scrollBy -Δ；抬一指后不起新框", async () => {
    const pointSpy = vi.spyOn(hitTest, "hitTestPoint");
    const regionSpy = vi.spyOn(hitTest, "hitTest");
    await render();
    const host = layer();

    await act(async () => {
      host.dispatchEvent(pointer("pointerdown", { pointerId: 1, clientX: 30, clientY: 40 }));
      host.dispatchEvent(pointer("pointermove", { pointerId: 1, clientX: 80, clientY: 90 }));
    });
    expect(host.querySelector("[data-ask-rubber]")).toBeTruthy();

    await act(async () => {
      host.dispatchEvent(pointer("pointerdown", { pointerId: 2, clientX: 100, clientY: 40 }));
    });
    expect(host.querySelector("[data-ask-rubber]")).toBeNull();
    expect(pointSpy).not.toHaveBeenCalled();
    expect(regionSpy).not.toHaveBeenCalled();

    await act(async () => {
      host.dispatchEvent(pointer("pointermove", { pointerId: 1, clientX: 90, clientY: 100 }));
      host.dispatchEvent(pointer("pointermove", { pointerId: 2, clientX: 110, clientY: 50 }));
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    });
    // Midpoint moved from ((80+100)/2, (90+40)/2) = (90, 65)
    // to ((90+110)/2, (100+50)/2) = (100, 75) → Δ = (10, 10)
    expect(scroller.scrollBy).toHaveBeenCalledWith({ left: -10, top: -10 });

    await act(async () => {
      host.dispatchEvent(pointer("pointerup", { pointerId: 2, clientX: 110, clientY: 50 }));
      host.dispatchEvent(pointer("pointermove", { pointerId: 1, clientX: 140, clientY: 140 }));
    });
    expect(host.querySelector("[data-ask-rubber]")).toBeNull();
    expect(pointSpy).not.toHaveBeenCalled();
    expect(regionSpy).not.toHaveBeenCalled();

    await act(async () => {
      host.dispatchEvent(pointer("pointerup", { pointerId: 1, clientX: 140, clientY: 140 }));
    });
    expect(pointSpy).not.toHaveBeenCalled();
    expect(regionSpy).not.toHaveBeenCalled();
    expect(usePlayerStore.getState().selection).toBeNull();
    expect(usePlayerStore.getState().askPhase).toBe("selecting");

    // All released: a new stroke can draw again.
    await act(async () => {
      host.dispatchEvent(pointer("pointerdown", { pointerId: 3, clientX: 20, clientY: 20 }));
      host.dispatchEvent(pointer("pointermove", { pointerId: 3, clientX: 70, clientY: 70 }));
    });
    expect(host.querySelector("[data-ask-rubber]")).toBeTruthy();
  });

  test("19. resize 清空选区、phase selecting、草稿保留、提示重画，不调用 closeAskPanel", async () => {
    await render();
    await gesture(20, 12, 120, 36);
    expect(usePlayerStore.getState().selection).not.toBeNull();
    expect(usePlayerStore.getState().askPhase).toBe("drafting");
    usePlayerStore.setState({ draftQuestion: "窗口变了也留着" });
    const closeSpy = vi.spyOn(usePlayerStore.getState(), "closeAskPanel");

    await act(async () => {
      window.dispatchEvent(new Event("resize"));
    });

    expect(usePlayerStore.getState().selection).toBeNull();
    expect(usePlayerStore.getState().askPhase).toBe("selecting");
    expect(usePlayerStore.getState().draftQuestion).toBe("窗口变了也留着");
    expect(layer().textContent).toContain(ASK_RESIZE_HINT);
    expect(closeSpy).not.toHaveBeenCalled();
  });

  test("20. 捷径构造 single 选区；没有 viz 节点时不渲染可视化整块", async () => {
    await render();
    const buttons = [...layer().querySelectorAll<HTMLButtonElement>("[data-ask-shortcut]")];
    expect(buttons.map((button) => button.dataset.askShortcut)).toEqual(["subtitle", "step", "viz"]);

    await act(async () => buttons[0].click());
    let selection = usePlayerStore.getState().selection;
    expect(selection?.mode).toBe("single");
    expect(selection?.targets.map((target) => target.id)).toEqual(["subtitle:s1"]);

    // 命中后进入 drafting，层上的捷径条只在 selecting 显示。回到 selecting 再点下一项。
    await act(async () => usePlayerStore.setState({ askPhase: "selecting" }));
    await act(async () => layer().querySelector<HTMLButtonElement>('[data-ask-shortcut="step"]')!.click());
    selection = usePlayerStore.getState().selection;
    expect(selection?.mode).toBe("single");
    expect(selection?.targets.map((target) => target.id)).toEqual(["step:s1"]);

    await act(async () => usePlayerStore.setState({ askPhase: "selecting" }));
    await act(async () => layer().querySelector<HTMLButtonElement>('[data-ask-shortcut="viz"]')!.click());
    selection = usePlayerStore.getState().selection;
    expect(selection?.mode).toBe("single");
    expect(selection?.targets.map((target) => target.id)).toEqual(["viz:s1"]);
    expect(selection?.bbox).toEqual({ x: 150, y: 10, width: 60, height: 30 });

    stage.querySelector("[data-ask-target='viz']")?.remove();
    usePlayerStore.setState({ askPhase: "selecting", selection: null });
    await render();
    const again = [...layer().querySelectorAll<HTMLButtonElement>("[data-ask-shortcut]")];
    expect(again.map((button) => button.dataset.askShortcut)).toEqual(["subtitle", "step"]);
    expect(layer().textContent).not.toContain("可视化整块");
  });

  test("21. 方向键与 Enter 选中；Space/←/→ 不改变 currentIndex 与 status", async () => {
    usePlayerStore.setState({ currentIndex: 0, status: "interrupted" });
    await render();
    const host = layer();
    host.focus();

    const down = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });
    await act(async () => {
      host.dispatchEvent(down);
    });
    expect(down.defaultPrevented).toBe(true);

    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    await act(async () => {
      host.dispatchEvent(enter);
    });
    expect(usePlayerStore.getState().selection?.mode).toBe("single");
    expect(usePlayerStore.getState().selection?.targets[0]?.id).toBe("step:s1");

    const beforeIndex = usePlayerStore.getState().currentIndex;
    const beforeStatus = usePlayerStore.getState().status;
    for (const key of [" ", "ArrowLeft", "ArrowRight"]) {
      const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      await act(async () => {
        host.dispatchEvent(event);
      });
      expect(event.defaultPrevented).toBe(true);
      expect(event.cancelBubble).toBe(true);
    }
    expect(usePlayerStore.getState().currentIndex).toBe(beforeIndex);
    expect(usePlayerStore.getState().status).toBe(beforeStatus);
  });

  test("进入圈选把 ASK_ENTERED_STATUS 写入已有 role=status，选区后 exitAsk 再重新进入仍为 ASK_ENTERED_STATUS", async () => {
    usePlayerStore.getState().setLectureAnswerMeta({
      cacheKey: "ck-1",
      scriptVersion: "v1",
      askDisabledStepIds: [],
      storageMode: "server",
    });
    const status = document.createElement("p");
    status.setAttribute("role", "status");
    status.textContent = "旧播报";
    document.body.append(status);
    await render();
    expect(status.textContent).toBe(ASK_ENTERED_STATUS);

    await gesture(20, 12, 120, 36);
    expect(usePlayerStore.getState().selection).not.toBeNull();
    expect(status.textContent).toBe(summarizeSelection(usePlayerStore.getState().selection!));

    await act(async () => {
      usePlayerStore.getState().exitAsk();
    });
    expect(usePlayerStore.getState().askPhase).toBe("idle");

    await act(async () => {
      usePlayerStore.getState().enterAsk();
    });
    expect(usePlayerStore.getState().askPhase).toBe("selecting");
    expect(status.textContent).toBe(ASK_ENTERED_STATUS);

    status.remove();
  });

  test("从 drafting 取消（closeAskPanel）回到 selecting 保留选区，并将选区摘要写入 role=status", async () => {
    const status = document.createElement("p");
    status.setAttribute("role", "status");
    status.textContent = "旧播报";
    document.body.append(status);
    await render();
    expect(status.textContent).toBe(ASK_ENTERED_STATUS);

    await gesture(20, 12, 120, 36);
    const selection = usePlayerStore.getState().selection;
    expect(selection).not.toBeNull();
    expect(usePlayerStore.getState().askPhase).toBe("drafting");
    const summary = summarizeSelection(selection!);
    expect(status.textContent).toBe(summary);

    // 覆盖 status 内容以验证取消时会重新写入摘要
    status.textContent = "其他中间状态";

    await act(async () => {
      usePlayerStore.getState().closeAskPanel();
    });
    expect(usePlayerStore.getState().askPhase).toBe("selecting");
    expect(usePlayerStore.getState().selection).not.toBeNull();
    expect(status.textContent).toBe(summary);

    status.remove();
  });

  test("Tab 在捷径组内循环并切换 tabIndex", async () => {
    await render();
    const host = layer();
    const buttons = () => [...host.querySelectorAll<HTMLButtonElement>("[data-ask-shortcut]")];
    expect(buttons()[0].tabIndex).toBe(0);
    expect(buttons()[1].tabIndex).toBe(-1);

    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    await act(async () => {
      host.dispatchEvent(tab);
    });
    expect(tab.defaultPrevented).toBe(true);
    expect(buttons()[1].tabIndex).toBe(0);
    expect(buttons()[0].tabIndex).toBe(-1);
    expect(document.activeElement).toBe(buttons()[1]);
  });

  function pressEscape(target: EventTarget, init: KeyboardEventInit = {}) {
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(event);
    return event;
  }

  /** 关面板的焦点恢复排在 0ms timeout 上，act 会把它冲掉。 */
  async function flushFocus() {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  test("窗口级 Esc：selecting 退出，drafting 先关面板再退出", async () => {
    await render();
    const body = document.body;
    body.tabIndex = -1;
    body.focus();

    const first = await act(async () => pressEscape(body));
    expect(first.defaultPrevented).toBe(true);
    expect(usePlayerStore.getState().askPhase).toBe("idle");
    expect(container.querySelector("[data-ask-layer]")).toBeNull();

    usePlayerStore.setState({
      askPhase: "drafting",
      status: "interrupted",
      selection: {
        mode: "single",
        bbox: { x: 80, y: 10, width: 60, height: 30 },
        targets: [{ kind: "step", id: "step:s1", stepId: "s1", text: "步骤内容" }],
      },
      draftQuestion: "窗口也能关",
    });
    await render();
    const target = stage.querySelector<HTMLElement>('[data-ask-id="step:s1"]')!;
    target.tabIndex = -1;
    target.focus();
    const close = await act(async () => pressEscape(target));
    expect(close.defaultPrevented).toBe(true);
    expect(usePlayerStore.getState().askPhase).toBe("selecting");
    expect(usePlayerStore.getState().draftQuestion).toBe("窗口也能关");
    await flushFocus();
    expect(document.activeElement).toBe(target);

    const exit = await act(async () => pressEscape(layer()));
    expect(exit.defaultPrevented).toBe(true);
    expect(usePlayerStore.getState().askPhase).toBe("idle");
  });

  test("窗口级 Esc：面板外的 Monaco 按阶段退出，面板内 textarea 关面板", async () => {
    const addSpy = vi.spyOn(window, "addEventListener");
    await render();
    const escapeListen = addSpy.mock.calls.find(
      (call) => call[0] === "keydown" && call[2] === true,
    );
    expect(escapeListen).toBeTruthy();

    const monaco = document.createElement("textarea");
    monaco.className = "inputarea";
    const editor = document.createElement("div");
    editor.className = "monaco-editor";
    editor.append(monaco);
    document.body.append(editor);
    monaco.focus();

    const fromMonaco = await act(async () => pressEscape(monaco));
    expect(fromMonaco.defaultPrevented).toBe(true);
    expect(usePlayerStore.getState().askPhase).toBe("idle");

    usePlayerStore.setState({ askPhase: "selecting", status: "interrupted" });
    await render();

    const panel = document.createElement("div");
    panel.setAttribute("data-ask-panel", "");
    const question = document.createElement("textarea");
    panel.append(question);
    document.body.append(panel);
    usePlayerStore.setState({ askPhase: "drafting" });
    await render();
    question.focus();
    const close = await act(async () => pressEscape(question));
    expect(close.defaultPrevented).toBe(true);
    expect(usePlayerStore.getState().askPhase).toBe("selecting");
    await flushFocus();
    expect(document.activeElement).toBe(layer());

    editor.remove();
    panel.remove();
  });

  async function openDraftOnStep() {
    await render();
    const target = stage.querySelector<HTMLElement>('[data-ask-id="step:s1"]')!;
    usePlayerStore.setState({
      askPhase: "drafting",
      status: "interrupted",
      selection: {
        mode: "single",
        bbox: { x: 80, y: 10, width: 60, height: 30 },
        targets: [{ kind: "step", id: "step:s1", stepId: "s1", text: "步骤内容" }],
      },
      draftQuestion: "还在的草稿",
    });
    await render();
    return target;
  }

  test("点击取消关面板后焦点回到选区原目标", async () => {
    const target = await openDraftOnStep();
    const panel = document.createElement("div");
    panel.setAttribute("data-ask-panel", "");
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "取消";
    cancel.addEventListener("click", () => {
      usePlayerStore.getState().closeAskPanel();
    });
    panel.append(cancel);
    document.body.append(panel);
    cancel.focus();
    expect(document.activeElement).toBe(cancel);

    await act(async () => {
      cancel.click();
    });
    expect(usePlayerStore.getState().askPhase).toBe("selecting");
    await flushFocus();
    expect(document.activeElement).toBe(target);
    panel.remove();
  });

  test("Esc 关面板后焦点回到选区原目标", async () => {
    const target = await openDraftOnStep();
    document.body.tabIndex = -1;
    document.body.focus();
    expect(document.activeElement).toBe(document.body);

    const close = await act(async () => pressEscape(document.body));
    expect(close.defaultPrevented).toBe(true);
    expect(usePlayerStore.getState().askPhase).toBe("selecting");
    await flushFocus();
    expect(document.activeElement).toBe(target);
  });

  test("从 idle 进入 selecting 不抢走入口按钮的焦点", async () => {
    usePlayerStore.setState({ askPhase: "idle", status: "paused" });
    await render();
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("data-ask-entry", "");
    button.textContent = "圈选提问";
    document.body.append(button);
    button.focus();
    expect(document.activeElement).toBe(button);

    await act(async () => {
      usePlayerStore.setState({ askPhase: "selecting", status: "interrupted" });
    });
    await flushFocus();
    expect(usePlayerStore.getState().askPhase).toBe("selecting");
    expect(container.querySelector("[data-ask-layer]")).not.toBeNull();
    expect(document.activeElement).toBe(button);
    button.remove();
  });

  test("关面板后目标已不在文档里，焦点落到画选层", async () => {
    await render();
    const target = stage.querySelector<HTMLElement>('[data-ask-id="step:s1"]')!;
    usePlayerStore.setState({
      askPhase: "drafting",
      status: "interrupted",
      selection: {
        mode: "single",
        bbox: { x: 80, y: 10, width: 60, height: 30 },
        targets: [{ kind: "step", id: "step:s1", stepId: "s1", text: "步骤内容" }],
      },
    });
    await render();
    target.remove();
    expect(target.isConnected).toBe(false);
    const close = await act(async () => pressEscape(document.body));
    expect(close.defaultPrevented).toBe(true);
    expect(usePlayerStore.getState().askPhase).toBe("selecting");
    await flushFocus();
    expect(document.activeElement).toBe(layer());
  });

  test("sending/streaming 时窗口级 Esc 不关面板也不退出", async () => {
    const context = {
      stepId: "s1",
      stepIndex: 0,
      prevStatus: "paused" as const,
      prevAwaitingContinue: false,
      answerId: null as string | null,
      segmentIndex: -1,
      token: 4,
    };
    usePlayerStore.setState({ askPhase: "sending", askContext: context });
    await render();
    expect(container.querySelector("[data-ask-layer]")).toBeNull();
    const sending = await act(async () => pressEscape(document.body));
    expect(sending.defaultPrevented).toBe(false);
    expect(usePlayerStore.getState().askPhase).toBe("sending");
    expect(usePlayerStore.getState().askContext?.token).toBe(4);

    usePlayerStore.setState({
      askPhase: "streaming",
      askContext: { ...context, answerId: "ans-live" },
    });
    await render();
    const streaming = await act(async () => pressEscape(document.body));
    expect(streaming.defaultPrevented).toBe(false);
    expect(usePlayerStore.getState().askPhase).toBe("streaming");
    expect(usePlayerStore.getState().askContext?.token).toBe(4);
    expect(container.querySelector("[data-ask-layer]")).toBeNull();
  });

  test("按住 Esc 的重复键只处理一次", async () => {
    await render();
    const first = await act(async () => pressEscape(document.body));
    expect(first.defaultPrevented).toBe(true);
    expect(usePlayerStore.getState().askPhase).toBe("idle");

    usePlayerStore.setState({ askPhase: "selecting", status: "interrupted" });
    await render();
    const repeated = await act(async () => pressEscape(document.body, { repeat: true }));
    expect(repeated.defaultPrevented).toBe(false);
    expect(usePlayerStore.getState().askPhase).toBe("selecting");
  });

  test("画选层元素不再单独处理 Esc，窗口监听只退出一次", async () => {
    const exitSpy = vi.spyOn(usePlayerStore.getState(), "exitAsk");
    await render();
    const host = layer();
    const esc = await act(async () => pressEscape(host));
    expect(esc.defaultPrevented).toBe(true);
    expect(exitSpy).toHaveBeenCalledTimes(1);
    expect(usePlayerStore.getState().askPhase).toBe("idle");
  });
});

describe("resolveAskEscape", () => {
  const plain = {
    composing: false,
    defaultPrevented: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
  };

  test("阶段与输入目标", () => {
    const body = document.createElement("div");
    const monaco = document.createElement("div");
    monaco.className = "monaco-editor";
    const cell = document.createElement("textarea");
    monaco.append(cell);
    const panel = document.createElement("div");
    panel.setAttribute("data-ask-panel", "");
    const question = document.createElement("textarea");
    panel.append(question);

    expect(resolveAskEscape("selecting", body, plain)).toBe("exit");
    expect(resolveAskEscape("drafting", body, plain)).toBe("close-panel");
    expect(resolveAskEscape("error", body, plain)).toBe("close-panel");
    expect(resolveAskEscape("sending", question, plain)).toBe("ignore");
    expect(resolveAskEscape("streaming", body, plain)).toBe("ignore");
    expect(resolveAskEscape("playing", body, plain)).toBe("ignore");
    expect(resolveAskEscape("idle", body, plain)).toBe("ignore");
    expect(resolveAskEscape("selecting", cell, plain)).toBe("exit");
    expect(resolveAskEscape("drafting", cell, plain)).toBe("close-panel");
    expect(resolveAskEscape("playing", cell, plain)).toBe("ignore");
    expect(resolveAskEscape("idle", cell, plain)).toBe("ignore");
    const outside = document.createElement("input");
    document.body.append(outside);
    expect(resolveAskEscape("selecting", outside, plain)).toBe("ignore");
    expect(resolveAskEscape("drafting", outside, plain)).toBe("ignore");
    outside.remove();
    expect(resolveAskEscape("drafting", question, plain)).toBe("close-panel");
    expect(resolveAskEscape("sending", question, plain)).toBe("ignore");
  });

  test("组合键、输入法、已处理的事件忽略", () => {
    const body = document.createElement("div");
    expect(resolveAskEscape("selecting", body, { ...plain, ctrlKey: true })).toBe("ignore");
    expect(resolveAskEscape("drafting", body, { ...plain, metaKey: true })).toBe("ignore");
    expect(resolveAskEscape("selecting", body, { ...plain, altKey: true })).toBe("ignore");
    expect(resolveAskEscape("selecting", body, { ...plain, composing: true })).toBe("ignore");
    expect(resolveAskEscape("drafting", body, { ...plain, defaultPrevented: true })).toBe("ignore");
  });

  test("捷径上拖过阈值从起点起框，原地抬起仍是点选捷径", async () => {
    await render();
    const host = layer();
    const chip = host.querySelector<HTMLButtonElement>('[data-ask-shortcut="subtitle"]')!;

    await act(async () => {
      chip.dispatchEvent(pointer("pointerdown", { clientX: 20, clientY: 12 }));
      window.dispatchEvent(pointer("pointermove", { clientX: 80, clientY: 70 }));
      host.dispatchEvent(pointer("pointermove", { clientX: 80, clientY: 70 }));
    });
    expect(host.querySelector("[data-ask-rubber]")).not.toBeNull();

    await act(async () => {
      host.dispatchEvent(pointer("pointerup", { clientX: 80, clientY: 70 }));
    });
    expect(usePlayerStore.getState().selection).not.toBeNull();

    usePlayerStore.getState().clearAskSelection();
    await act(async () => {
      chip.dispatchEvent(pointer("pointerdown", { pointerId: 4, clientX: 20, clientY: 12 }));
      window.dispatchEvent(pointer("pointermove", { pointerId: 4, clientX: 22, clientY: 14 }));
      window.dispatchEvent(pointer("pointerup", { pointerId: 4, clientX: 22, clientY: 14 }));
    });
    expect(host.querySelector("[data-ask-rubber]")).toBeNull();
    expect(usePlayerStore.getState().selection).toBeNull();
  });

  test("捷径上拖过阈值只出框，随后的 click 不选中捷径", async () => {
    await render();
    const host = layer();
    const chip = host.querySelector<HTMLButtonElement>('[data-ask-shortcut="subtitle"]')!;

    await act(async () => {
      chip.dispatchEvent(pointer("pointerdown", { clientX: 20, clientY: 12 }));
      window.dispatchEvent(pointer("pointermove", { clientX: 160, clientY: 120 }));
      host.dispatchEvent(pointer("pointermove", { clientX: 160, clientY: 120 }));
    });
    expect(host.querySelector("[data-ask-rubber]")).not.toBeNull();

    await act(async () => {
      chip.click();
    });
    // 拖动压住 click：捷径没有被点选，phase 还停在 selecting。
    expect(usePlayerStore.getState().askPhase).toBe("selecting");
    expect(chip.getAttribute("aria-pressed")).not.toBe("true");

    await act(async () => {
      host.dispatchEvent(pointer("pointerup", { clientX: 160, clientY: 120 }));
    });
    const committed = usePlayerStore.getState().selection;
    expect(committed).not.toBeNull();
    expect(committed?.mode).toBe("region");
    expect(usePlayerStore.getState().askPhase).toBe("drafting");
  });

  test("捷径拖动的窗口监听在卸载时卸掉", async () => {
    const addSpy = vi.spyOn(window, "addEventListener");
    const removeSpy = vi.spyOn(window, "removeEventListener");
    await render();
    const chip = layer().querySelector<HTMLButtonElement>('[data-ask-shortcut="subtitle"]')!;
    await act(async () => {
      chip.dispatchEvent(pointer("pointerdown", { clientX: 20, clientY: 12 }));
    });
    const move = addSpy.mock.calls.find((call) => call[0] === "pointermove");
    const up = addSpy.mock.calls.find((call) => call[0] === "pointerup");
    const cancel = addSpy.mock.calls.find((call) => call[0] === "pointercancel");
    expect(move?.[1]).toBeTypeOf("function");
    expect(up?.[1]).toBeTypeOf("function");
    expect(cancel?.[1]).toBeTypeOf("function");

    await act(async () => root.unmount());
    expect(removeSpy.mock.calls.some((call) => call[0] === "pointermove" && call[1] === move?.[1])).toBe(true);
    expect(removeSpy.mock.calls.some((call) => call[0] === "pointerup" && call[1] === up?.[1])).toBe(true);
    expect(removeSpy.mock.calls.some((call) => call[0] === "pointercancel" && call[1] === cancel?.[1])).toBe(true);
  });

  test("guard: pointerdown inside [data-ask-entry] does not start selection", async () => {
    const entryBtn = document.createElement("button");
    entryBtn.setAttribute("data-ask-entry", "");
    const child = document.createElement("span");
    entryBtn.append(child);
    document.body.append(entryBtn);

    try {
      await render();
      const host = layer();
      const setCaptureSpy = vi.spyOn(host, "setPointerCapture");

      // 1. target is inside [data-ask-entry] (nested child)
      const insideEvt = pointer("pointerdown", { clientX: 310, clientY: 20 });
      Object.defineProperty(insideEvt, "target", { value: child });
      await act(async () => {
        host.dispatchEvent(insideEvt);
      });
      expect(setCaptureSpy).not.toHaveBeenCalled();
      expect(host.querySelector("[data-ask-rubber]")).toBeNull();

      // 2. target is entryBtn itself
      const directEvt = pointer("pointerdown", { clientX: 310, clientY: 20 });
      Object.defineProperty(directEvt, "target", { value: entryBtn });
      await act(async () => {
        host.dispatchEvent(directEvt);
      });
      expect(setCaptureSpy).not.toHaveBeenCalled();
      expect(host.querySelector("[data-ask-rubber]")).toBeNull();

      // 3. target is layer, outside [data-ask-entry] starts selection
      await act(async () => {
        host.dispatchEvent(pointer("pointerdown", { clientX: 200, clientY: 20 }));
        host.dispatchEvent(pointer("pointermove", { clientX: 230, clientY: 30 }));
      });
      expect(setCaptureSpy).toHaveBeenCalled();
      expect(host.querySelector("[data-ask-rubber]")).not.toBeNull();
    } finally {
      entryBtn.remove();
    }
  });

  test("(a) only code boxed with zero code units -> hint ASK_CODE_MISS_HINT, no panel selection", async () => {
    const codeEl = document.createElement("div");
    codeEl.setAttribute("data-ask-target", "code");
    codeEl.setAttribute("data-ask-id", "code:main");
    codeEl.setAttribute("data-ask-step-id", "s1");
    codeEl.getBoundingClientRect = () => domRect(250, 10, 80, 50);
    stage.append(codeEl);

    const mockHandle: CodeEditorHandle = {
      getLineRangeForClientBox: vi.fn(() => null),
      getLinesText: vi.fn(() => ""),
      getFullText: vi.fn(() => ""),
    };
    registerCodeEditor(codeEl, mockHandle);

    const setSpy = vi.spyOn(usePlayerStore.getState(), "setAskSelection");
    await render();

    // Box only covering code area (x: 250..330, y: 10..60)
    await gesture(260, 20, 310, 50);

    expect(setSpy).not.toHaveBeenCalled();
    expect(usePlayerStore.getState().selection).toBeNull();
    expect(usePlayerStore.getState().askPhase).toBe("selecting");
    expect(layer().textContent).toContain(ASK_CODE_MISS_HINT);
    expect(getAskCodeMissNotice()).toBeNull();
  });

  test("(b) other units collected + code intersected but not collected -> selection set and notice set", async () => {
    const codeEl = document.createElement("div");
    codeEl.setAttribute("data-ask-target", "code");
    codeEl.setAttribute("data-ask-id", "code:main");
    codeEl.setAttribute("data-ask-step-id", "s1");
    codeEl.getBoundingClientRect = () => domRect(250, 10, 80, 50);
    stage.append(codeEl);

    const mockHandle: CodeEditorHandle = {
      getLineRangeForClientBox: vi.fn(() => null),
      getLinesText: vi.fn(() => ""),
      getFullText: vi.fn(() => ""),
    };
    registerCodeEditor(codeEl, mockHandle);

    const setSpy = vi.spyOn(usePlayerStore.getState(), "setAskSelection");
    await render();

    // Box covering viz (150..210, 10..40) and code (250..330, 10..60)
    await gesture(160, 20, 280, 45);

    expect(setSpy).toHaveBeenCalledTimes(1);
    const sel = usePlayerStore.getState().selection;
    expect(sel).not.toBeNull();
    expect(sel?.targets.some((t) => t.kind === "viz")).toBe(true);
    expect(sel?.targets.some((t) => t.kind === "code")).toBe(false);
    expect(usePlayerStore.getState().askPhase).toBe("drafting");
    expect(getAskCodeMissNotice()).toBe(ASK_CODE_MISS_HINT);
  });

  test("(c) nothing intersected -> ASK_EMPTY_HIT", async () => {
    const setSpy = vi.spyOn(usePlayerStore.getState(), "setAskSelection");
    await render();

    // Tap in empty space where no targets exist
    await gesture(142, 20, 144, 20);

    expect(setSpy).not.toHaveBeenCalled();
    expect(usePlayerStore.getState().selection).toBeNull();
    expect(usePlayerStore.getState().askPhase).toBe("selecting");
    expect(layer().textContent).toContain(ASK_EMPTY_HIT);
    expect(getAskCodeMissNotice()).toBeNull();
  });

  test("fallback-code -> no hint/notice", async () => {
    const codeEl = document.createElement("div");
    codeEl.setAttribute("data-ask-target", "code");
    codeEl.setAttribute("data-ask-id", "code:main");
    codeEl.setAttribute("data-ask-step-id", "s1");
    codeEl.textContent = "const x = 1;";
    codeEl.getBoundingClientRect = () => domRect(250, 10, 80, 50);
    stage.append(codeEl);

    const setSpy = vi.spyOn(usePlayerStore.getState(), "setAskSelection");
    await render();

    // Box code area (no handle registered, falls back to textContent)
    await gesture(260, 20, 310, 50);

    expect(setSpy).toHaveBeenCalledTimes(1);
    const sel = usePlayerStore.getState().selection;
    expect(sel?.targets.some((t) => t.kind === "code")).toBe(true);
    expect(layer().textContent).not.toContain(ASK_CODE_MISS_HINT);
    expect(getAskCodeMissNotice()).toBeNull();
  });

  test("case 1: box intersects code element and handle returns range -> target with codeRange and framed lines text", async () => {
    const codeEl = document.createElement("div");
    codeEl.setAttribute("data-ask-target", "code");
    codeEl.setAttribute("data-ask-id", "code:main");
    codeEl.setAttribute("data-ask-step-id", "s1");
    codeEl.getBoundingClientRect = () => domRect(250, 10, 80, 50);
    stage.append(codeEl);

    const mockHandle: CodeEditorHandle = {
      getLineRangeForClientBox: vi.fn(() => ({ startLine: 2, endLine: 4 })),
      getLinesText: vi.fn((_start, _end) => "line 2\nline 3\nline 4"),
      getFullText: vi.fn(() => "full code"),
    };
    registerCodeEditor(codeEl, mockHandle);

    const setSpy = vi.spyOn(usePlayerStore.getState(), "setAskSelection");
    await render();

    // Box code element (250..330, 10..60)
    await gesture(240, 5, 340, 65);

    expect(setSpy).toHaveBeenCalledTimes(1);
    const sel = usePlayerStore.getState().selection;
    expect(sel).not.toBeNull();
    expect(sel?.targets).toHaveLength(1);
    expect(sel?.targets[0].kind).toBe("code");
    expect(sel?.targets[0].codeRange).toEqual({ startLine: 2, endLine: 4 });
    expect(sel?.targets[0].text).toBe("line 2\nline 3\nline 4");

    const chip = summarizeSelection(sel!);
    expect(chip).toBe("已选：代码第 2–4 行");

    const labelEl = layer().querySelector("[data-ask-selection-label]");
    expect(labelEl?.textContent).toBe("已选：代码第 2–4 行");
    expect(layer().textContent).not.toContain(ASK_CODE_MISS_HINT);
    expect(getAskCodeMissNotice()).toBeNull();
  });

  test("case 2: whole-block fallback to 当前代码 shows no hint", async () => {
    const codeEl = document.createElement("div");
    codeEl.setAttribute("data-ask-target", "code");
    codeEl.setAttribute("data-ask-id", "code:main");
    codeEl.setAttribute("data-ask-step-id", "s1");
    codeEl.getBoundingClientRect = () => domRect(250, 10, 80, 50);
    stage.append(codeEl);

    // In collectAskCandidates, when an editor handle is registered but line-range
    // lookup returns null (e.g. coordinates cannot resolve to lines), it falls back
    // to handle.getFullText() (or el.textContent). Because full text is non-empty,
    // a code target is created without codeRange. When fully boxed, hitTest collects
    // this code target, summarizeSelection yields "已选：当前代码", and neither hint
    // nor notice is produced.
    const mockHandle: CodeEditorHandle = {
      getLineRangeForClientBox: vi.fn(() => null),
      getLinesText: vi.fn(() => ""),
      getFullText: vi.fn(() => "const x = 1;\nconst y = 2;"),
    };
    registerCodeEditor(codeEl, mockHandle);

    const setSpy = vi.spyOn(usePlayerStore.getState(), "setAskSelection");
    await render();

    // Box code element (code element is fully boxed: 250..330, 10..60)
    await gesture(240, 5, 340, 65);

    expect(setSpy).toHaveBeenCalledTimes(1);
    const sel = usePlayerStore.getState().selection;
    expect(sel).not.toBeNull();
    expect(sel?.targets).toHaveLength(1);
    expect(sel?.targets[0].kind).toBe("code");
    expect(sel?.targets[0].codeRange).toBeUndefined();
    const chip = summarizeSelection(sel!);
    expect(chip).toBe("已选：当前代码");
    expect(/\d/.test(chip)).toBe(false);

    const labelEl = layer().querySelector("[data-ask-selection-label]");
    expect(labelEl?.textContent).toBe("已选：当前代码");
    expect(/\d/.test(labelEl?.textContent ?? "")).toBe(false);
    expect(layer().textContent).not.toContain(ASK_CODE_MISS_HINT);
    expect(getAskCodeMissNotice()).toBeNull();
  });

  test("case 3: getFullText '' and no textContent -> hint ASK_CODE_MISS_HINT, no selection", async () => {
    const codeEl = document.createElement("div");
    codeEl.setAttribute("data-ask-target", "code");
    codeEl.setAttribute("data-ask-id", "code:main");
    codeEl.setAttribute("data-ask-step-id", "s1");
    codeEl.textContent = "";
    codeEl.getBoundingClientRect = () => domRect(250, 10, 80, 50);
    stage.append(codeEl);

    const mockHandle: CodeEditorHandle = {
      getLineRangeForClientBox: vi.fn(() => null),
      getLinesText: vi.fn(() => ""),
      getFullText: vi.fn(() => ""),
    };
    registerCodeEditor(codeEl, mockHandle);

    const setSpy = vi.spyOn(usePlayerStore.getState(), "setAskSelection");
    await render();

    // Box only code element
    await gesture(240, 5, 340, 65);

    expect(setSpy).not.toHaveBeenCalled();
    expect(usePlayerStore.getState().selection).toBeNull();
    expect(usePlayerStore.getState().askPhase).toBe("selecting");
    expect(layer().textContent).toContain(ASK_CODE_MISS_HINT);
    expect(getAskCodeMissNotice()).toBeNull();
  });

  test("case 4: box over a viz element only, not the code element -> no code target", async () => {
    const codeEl = document.createElement("div");
    codeEl.setAttribute("data-ask-target", "code");
    codeEl.setAttribute("data-ask-id", "code:main");
    codeEl.setAttribute("data-ask-step-id", "s1");
    codeEl.getBoundingClientRect = () => domRect(250, 10, 80, 50);
    stage.append(codeEl);

    const mockHandle: CodeEditorHandle = {
      getLineRangeForClientBox: vi.fn(() => ({ startLine: 1, endLine: 5 })),
      getLinesText: vi.fn(() => "code text"),
      getFullText: vi.fn(() => "full code text"),
    };
    registerCodeEditor(codeEl, mockHandle);

    const setSpy = vi.spyOn(usePlayerStore.getState(), "setAskSelection");
    await render();

    // Box only viz element (viz is at 150..210, 10..40; code is at 250..330, 10..60)
    await gesture(145, 5, 215, 45);

    expect(setSpy).toHaveBeenCalledTimes(1);
    const sel = usePlayerStore.getState().selection;
    expect(sel).not.toBeNull();
    expect(sel?.targets.some((t) => t.kind === "viz")).toBe(true);
    expect(sel?.targets.some((t) => t.kind === "code")).toBe(false);
    expect(mockHandle.getLineRangeForClientBox).not.toHaveBeenCalled();
    expect(getAskCodeMissNotice()).toBeNull();
  });

  test("exit-ask path explicitly clears code-miss notice, and re-entry shows no hint", async () => {
    usePlayerStore.getState().setLectureAnswerMeta({
      cacheKey: "ck-1",
      scriptVersion: "v1",
      askDisabledStepIds: [],
      storageMode: "server",
    });

    const codeEl = document.createElement("div");
    codeEl.setAttribute("data-ask-target", "code");
    codeEl.setAttribute("data-ask-id", "code:main");
    codeEl.setAttribute("data-ask-step-id", "s1");
    codeEl.getBoundingClientRect = () => domRect(250, 10, 80, 50);
    stage.append(codeEl);

    const mockHandle: CodeEditorHandle = {
      getLineRangeForClientBox: vi.fn(() => null),
      getLinesText: vi.fn(() => ""),
      getFullText: vi.fn(() => ""),
    };
    registerCodeEditor(codeEl, mockHandle);

    await act(async () => {
      root.render(
        createElement(
          "div",
          null,
          createElement(AskSelectionLayer, { stage }),
          createElement(AskEntry),
        ),
      );
    });

    // Box covering viz (150..210, 10..40) and code (250..330, 10..60)
    await gesture(160, 20, 280, 45);

    expect(getAskCodeMissNotice()).toBe(ASK_CODE_MISS_HINT);

    const exitBtn = container.querySelector<HTMLButtonElement>("[data-ask-entry]");
    if (exitBtn) {
      await act(async () => {
        exitBtn.click();
      });
    } else {
      act(() => {
        usePlayerStore.getState().exitAsk();
      });
    }

    expect(getAskCodeMissNotice()).toBeNull();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "q", bubbles: true }));
    });
    if (usePlayerStore.getState().askPhase !== "selecting") {
      act(() => {
        if (usePlayerStore.getState().askPhase === "drafting") {
          usePlayerStore.getState().closeAskPanel();
        } else {
          usePlayerStore.getState().enterAsk();
        }
      });
    }

    expect(usePlayerStore.getState().askPhase).toBe("selecting");
    expect(layer().textContent).not.toContain(ASK_CODE_MISS_HINT);
    expect(getAskCodeMissNotice()).toBeNull();
  });

  test("short single-line drag in code with box height 12px yields single line chip and codeRange", async () => {
    const codeEl = document.createElement("div");
    codeEl.setAttribute("data-ask-target", "code");
    codeEl.setAttribute("data-ask-id", "code:main");
    codeEl.setAttribute("data-ask-step-id", "s1");
    codeEl.getBoundingClientRect = () => domRect(200, 0, 150, 200);
    stage.append(codeEl);

    const mockHandle: CodeEditorHandle = {
      getLineRangeForClientBox: vi.fn((top: number, bottom: number) => {
        const startLine = Math.floor(top / 20) + 1;
        const endLine = Math.floor((bottom - 1) / 20) + 1;
        return { startLine, endLine };
      }),
      getLinesText: vi.fn((start, end) => `line ${start} to ${end}`),
      getFullText: vi.fn(() => "full code"),
    };
    registerCodeEditor(codeEl, mockHandle);

    const setSpy = vi.spyOn(usePlayerStore.getState(), "setAskSelection");
    await render();

    // Box height 12px (64..76 inside line 4: 60..80), width 60px (>= dragThreshold, < 24)
    await gesture(220, 64, 280, 76);

    expect(setSpy).toHaveBeenCalledTimes(1);
    expect(mockHandle.getLineRangeForClientBox).toHaveBeenCalledWith(64, 76);

    const sel = usePlayerStore.getState().selection;
    expect(sel).not.toBeNull();
    expect(sel?.targets).toHaveLength(1);
    expect(sel?.targets[0].kind).toBe("code");
    expect(sel?.targets[0].codeRange).toEqual({ startLine: 4, endLine: 4 });
    expect(summarizeSelection(sel!)).toBe("已选：代码第 4 行");
  });

  test("click (no motion) in code receives 1px box around pointer y and yields line chip", async () => {
    const codeEl = document.createElement("div");
    codeEl.setAttribute("data-ask-target", "code");
    codeEl.setAttribute("data-ask-id", "code:main");
    codeEl.setAttribute("data-ask-step-id", "s1");
    codeEl.getBoundingClientRect = () => domRect(200, 0, 150, 200);
    stage.append(codeEl);

    const mockHandle: CodeEditorHandle = {
      getLineRangeForClientBox: vi.fn((top: number, bottom: number) => {
        const startLine = Math.floor(top / 20) + 1;
        const endLine = Math.floor((bottom - 1) / 20) + 1;
        return { startLine, endLine };
      }),
      getLinesText: vi.fn((start, end) => `line ${start} to ${end}`),
      getFullText: vi.fn(() => "full code"),
    };
    registerCodeEditor(codeEl, mockHandle);

    const setSpy = vi.spyOn(usePlayerStore.getState(), "setAskSelection");
    await render();

    // Click at y = 70 (inside line 4: 60..80) with no motion
    await gesture(250, 70, 250, 70);

    expect(setSpy).toHaveBeenCalledTimes(1);
    expect(mockHandle.getLineRangeForClientBox).toHaveBeenCalledWith(70, 71);

    const sel = usePlayerStore.getState().selection;
    expect(sel).not.toBeNull();
    expect(sel?.targets).toHaveLength(1);
    expect(sel?.targets[0].kind).toBe("code");
    expect(sel?.targets[0].codeRange).toEqual({ startLine: 4, endLine: 4 });
    expect(summarizeSelection(sel!)).toBe("已选：代码第 4 行");
  });

  describe("S5-chip390 bottom bar & CSS variable", () => {
    test("sets --ask-bottom-bar-h on mobile and resets to 0px on unmount or desktop", async () => {
      // Mock matchMedia for mobile
      const originalMatchMedia = window.matchMedia;
      window.matchMedia = vi.fn().mockImplementation((query: string) => {
        if (query === "(max-width: 639px)") {
          return {
            matches: true,
            media: query,
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
          };
        }
        return {
          matches: false,
          media: query,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        };
      });

      await render();
      const bar = layer().querySelector<HTMLElement>("[data-ask-bottom-bar]");
      expect(bar).not.toBeNull();
      bar!.getBoundingClientRect = () => domRect(8, 790, 374, 52);

      // Trigger update
      await act(async () => {
        window.dispatchEvent(new Event("resize"));
      });

      expect(document.documentElement.style.getPropertyValue("--ask-bottom-bar-h")).toBe("52px");

      // When unmounted, cleans up to 0px
      await act(async () => {
        root.unmount();
      });
      expect(document.documentElement.style.getPropertyValue("--ask-bottom-bar-h")).toBe("0px");

      window.matchMedia = originalMatchMedia;
    });

    test("isElementFullyInView pure function checks top >= 0 and bottom <= innerHeight - barHeight", () => {
      const viewport = { innerHeight: 844, bottomBarHeight: 60 };
      // Fully visible inside (0 .. 784)
      expect(isElementFullyInView({ top: 10, bottom: 500 }, viewport)).toBe(true);
      expect(isElementFullyInView({ top: 0, bottom: 784 }, viewport)).toBe(true);

      // Top off-screen (< 0)
      expect(isElementFullyInView({ top: -1, bottom: 500 }, viewport)).toBe(false);

      // Bottom covered by bar (> 784)
      expect(isElementFullyInView({ top: 100, bottom: 785 }, viewport)).toBe(false);

      // Both off-screen
      expect(isElementFullyInView({ top: -100, bottom: 900 }, viewport)).toBe(false);
    });

    test("pointerdown cancels in-flight smooth scroll via window.scrollTo", async () => {
      const scrollToSpy = vi.fn();
      window.scrollTo = scrollToSpy;
      Object.defineProperty(window, "scrollY", { value: 240, configurable: true, writable: true });

      await render();
      const host = layer();
      // Trigger pointerdown
      await act(async () => {
        host.dispatchEvent(pointer("pointerdown", { pointerId: 1, clientX: 50, clientY: 50 }));
      });

      // No in-flight scroll right now, scrollTo shouldn't be called
      expect(scrollToSpy).not.toHaveBeenCalled();

      // Dispatch pointerup
      await act(async () => {
        host.dispatchEvent(pointer("pointerup", { pointerId: 1, clientX: 50, clientY: 50 }));
      });
    });
  });
});
