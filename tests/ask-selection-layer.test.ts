// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { scrollHeight, clientHeight, scrollWidth, clientWidth } from "happy-dom/lib/PropertySymbol.js";
import { armAskCancelGhostSuppress, askCancelGhostUntil, finishAskCancelSync, isAskCancelGhostActive } from "../lib/ask/ask-cancel";
import AskEntry from "../components/board/ask-entry";
import AskPlayerBarVar from "../components/board/ask-player-bar-var";
import AskSelectionLayer, {
  computeBottomOcclusion,
  computeOcclusion,
  getDesktopAskEntry,
  getNextTabbableAfterEntry,
  getScrollableAncestors,
  getTabbableElements,
  handlePanelTabNavigation,
  isElementFullyInView,
  isElementTabbable,
  isEnteringScrollInFlight,
  nextRovingIndex,
  resolveAskEscape,
} from "../components/board/ask-selection-layer";
import { ASK_CODE_MISS_HINT, ASK_EMPTY_HIT, ASK_ENTERED_STATUS, ASK_RESIZE_HINT } from "../lib/ask/ask-ui-text";
import { type CodeEditorHandle, getAskCodeMissNotice, registerCodeEditor, resetCodeEditorRegistry } from "../lib/ask/code-editor-registry";
import { summarizeSelection } from "../lib/ask/collect-candidates";
import * as askOcclusion from "../lib/ask/ask-occlusion";
import { invalidateAskMeasureCache, sharedAskMeasureCache } from "../lib/ask/ask-occlusion";
import { setAskOpenSource } from "../lib/ask/ask-open-source";
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
  invalidateAskMeasureCache(sharedAskMeasureCache);
  setAskOpenSource(null);
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
  invalidateAskMeasureCache(sharedAskMeasureCache);
  setAskOpenSource(null);
  usePlayerStore.getState().reset();
  resetCodeEditorRegistry();
  container.remove();
  scroller.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function render() {
  await act(async () => {
    root.render(
      createElement(
        "div",
        null,
        createElement(AskPlayerBarVar),
        createElement(AskSelectionLayer, { stage }),
      ),
    );
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

  test("roving tabindex: ArrowRight/ArrowLeft navigate among chips", async () => {
    await render();
    const host = layer();
    const buttons = () => [...host.querySelectorAll<HTMLButtonElement>("[data-ask-shortcut]")];
    expect(buttons()[0].tabIndex).toBe(0);
    expect(buttons()[1].tabIndex).toBe(-1);

    const right = new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true });
    await act(async () => {
      buttons()[0].dispatchEvent(right);
    });
    expect(right.defaultPrevented).toBe(true);
    expect(buttons()[1].tabIndex).toBe(0);
    expect(buttons()[0].tabIndex).toBe(-1);
    expect(document.activeElement).toBe(buttons()[1]);

    const left = new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true });
    await act(async () => {
      buttons()[1].dispatchEvent(left);
    });
    expect(left.defaultPrevented).toBe(true);
    expect(buttons()[0].tabIndex).toBe(0);
    expect(buttons()[1].tabIndex).toBe(-1);
    expect(document.activeElement).toBe(buttons()[0]);
  });

  test("selected shortcut has tabIndex=0 and aria-pressed=true", async () => {
    usePlayerStore.setState({
      selection: {
        mode: "single",
        bbox: { x: 0, y: 0, width: 10, height: 10 },
        targets: [{ kind: "step", id: "s1", stepId: "s1", text: "step 1" }],
      },
      askPhase: "selecting",
    });
    await render();
    const host = layer();
    const buttons = () => [...host.querySelectorAll<HTMLButtonElement>("[data-ask-shortcut]")];

    expect(buttons()[1].tabIndex).toBe(0);
    expect(buttons()[0].tabIndex).toBe(-1);
    expect(buttons()[1].getAttribute("aria-pressed")).toBe("true");
    expect(buttons()[0].getAttribute("aria-pressed")).toBeNull();
  });

  function pressEscape(target: EventTarget, init: KeyboardEventInit = {}) {
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(event);
    return event;
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
    // Focus is owned by finishAskCancelSync, which this Esc path calls.
    // Box open (no recorded chip) returns the selection target.
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
    // No selection and no recorded chip: finishAskCancelSync falls back to the layer.
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
      finishAskCancelSync(panel, () => usePlayerStore.getState().closeAskPanel());
    });
    panel.append(cancel);
    document.body.append(panel);
    cancel.focus();
    expect(document.activeElement).toBe(cancel);

    await act(async () => {
      cancel.click();
    });
    expect(usePlayerStore.getState().askPhase).toBe("selecting");
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
    expect(usePlayerStore.getState().askPhase).toBe("selecting");
    const layerEl = container.querySelector("[data-ask-layer]");
    expect(layerEl).not.toBeNull();
    // The layer root is a full-stage overlay. Chrome inside it is excluded;
    // the root itself is not, or the stage under it would leave the screenshot.
    expect(layerEl?.hasAttribute("data-ask-capture-exclude")).toBe(false);
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
    expect(document.activeElement).toBe(layer());
  });

  test("sending pointerdown does not start selection while the layer stays mounted", async () => {
    await render();
    await act(async () => {
      usePlayerStore.setState({ askPhase: "sending" });
    });
    expect(usePlayerStore.getState().askPhase).toBe("sending");
    const host = layer();
    expect(host.isConnected).toBe(true);
    const setCaptureSpy = vi.spyOn(host, "setPointerCapture");

    await act(async () => {
      host.dispatchEvent(pointer("pointerdown", { clientX: 40, clientY: 40 }));
      host.dispatchEvent(pointer("pointermove", { clientX: 120, clientY: 90 }));
    });

    expect(setCaptureSpy).not.toHaveBeenCalled();
    expect(host.querySelector("[data-ask-rubber]")).toBeNull();
    expect(usePlayerStore.getState().askPhase).toBe("sending");
    expect(usePlayerStore.getState().selection).toBeNull();
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
    expect(container.querySelector("[data-ask-layer]")).not.toBeNull();
    expect(container.querySelector("[data-ask-shortcut]")).toBeNull();
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
    expect(container.querySelector("[data-ask-layer]")).not.toBeNull();
    expect(container.querySelector("[data-ask-shortcut]")).toBeNull();
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

    test("sets --ask-player-bar-h on mobile and resets to 0px on unmount or desktop", async () => {
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

      const playerEl = document.createElement("div");
      playerEl.setAttribute("aria-label", "讲解播放区");
      playerEl.getBoundingClientRect = () => domRect(0, 708, 390, 60);
      document.body.appendChild(playerEl);

      await render();

      await act(async () => {
        window.dispatchEvent(new Event("resize"));
      });

      expect(document.documentElement.style.getPropertyValue("--ask-player-bar-h")).toBe("60px");

      await act(async () => {
        root.unmount();
      });
      expect(document.documentElement.style.getPropertyValue("--ask-player-bar-h")).toBe("0px");

      playerEl.remove();
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

    test("computeBottomOcclusion / computeOcclusion pure helper computes total occlusion with gaps", () => {
      expect(computeBottomOcclusion({})).toBe(0);
      expect(computeOcclusion({ playerHeight: 0, barHeight: 0, panelHeight: 0 })).toBe(0);

      // Player and bar present, no panel: 60 + 52 + 8 = 120
      expect(computeBottomOcclusion({ playerHeight: 60, barHeight: 52 })).toBe(120);

      // Player and panel present (bar hidden while panel open): 60 + 200 + 8 = 268
      expect(computeOcclusion({ playerHeight: 60, barHeight: 52, panelHeight: 200 })).toBe(268);

      // Only bar present: 0 + 52 + 0 + 8 = 60
      expect(computeBottomOcclusion({ barHeight: 52 })).toBe(60);

      // Ceiling of fractional heights (bar hidden while panel open)
      expect(computeBottomOcclusion({ playerHeight: 59.4, barHeight: 51.2, panelHeight: 199.1 })).toBe(60 + 200 + 8);
    });

    test("sets --ask-bottom-occlusion on mobile and reacts to panel and unmount", async () => {
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

      const playerEl = document.createElement("div");
      playerEl.setAttribute("aria-label", "讲解播放区");
      playerEl.getBoundingClientRect = () => domRect(0, 708, 390, 60);
      document.body.appendChild(playerEl);

      await render();
      const bar = layer().querySelector<HTMLElement>("[data-ask-bottom-bar]");
      expect(bar).not.toBeNull();
      bar!.getBoundingClientRect = () => domRect(8, 790, 374, 52);

      await act(async () => {
        window.dispatchEvent(new Event("resize"));
      });

      // player 60 + bar 52 + gap 8 = 120px
      expect(document.documentElement.style.getPropertyValue("--ask-bottom-occlusion")).toBe("120px");

      // Add panel
      const panelEl = document.createElement("div");
      panelEl.setAttribute("data-ask-panel", "");
      panelEl.getBoundingClientRect = () => domRect(8, 500, 374, 200);
      document.body.appendChild(panelEl);

      await act(async () => {
        window.dispatchEvent(new Event("resize"));
      });

      // player 60 + panel 200 + gap 8 = 268px (bar hidden while panel open)
      expect(document.documentElement.style.getPropertyValue("--ask-bottom-occlusion")).toBe("268px");

      // sending keeps the shell mounted under the open panel (same as drafting).
      // The chip bar stays hidden. Occlusion still counts the panel, so 取消 does not drop.
      await act(async () => {
        usePlayerStore.setState({ askPhase: "sending" });
      });
      expect(document.querySelector("[data-ask-layer]")).not.toBeNull();
      expect(document.querySelector("[data-ask-shortcut]")).toBeNull();
      expect(document.documentElement.style.getPropertyValue("--ask-player-bar-h")).toBe("60px");
      expect(document.documentElement.style.getPropertyValue("--ask-bottom-bar-h")).toBe("0px");
      expect(document.documentElement.style.getPropertyValue("--ask-bottom-occlusion")).toBe("268px");

      panelEl.remove();
      playerEl.remove();

      await act(async () => {
        root.unmount();
      });
      expect(document.documentElement.style.getPropertyValue("--ask-bottom-occlusion")).toBe("0px");

      window.matchMedia = originalMatchMedia;
    });

    test("on mobile, closing panel (drafting -> selecting) restores bar, chip focus, and occlusion in one frame synchronously", async () => {
      const originalMatchMedia = window.matchMedia;
      window.matchMedia = vi.fn().mockImplementation((query: string) => ({
        matches: query === "(max-width: 639px)",
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }));

      const playerEl = document.createElement("div");
      playerEl.setAttribute("aria-label", "讲解播放区");
      playerEl.getBoundingClientRect = () => domRect(0, 784, 390, 60);
      document.body.appendChild(playerEl);

      await render();

      // Make a selection to enter drafting
      await gesture(20, 12, 120, 36);
      expect(usePlayerStore.getState().askPhase).toBe("drafting");
      expect(document.querySelector("[data-ask-bottom-bar]")).toBeNull();

      // Add mock panel element in DOM as AskPanel would render
      const panelEl = document.createElement("div");
      panelEl.setAttribute("data-ask-panel", "");
      panelEl.getBoundingClientRect = () => domRect(8, 500, 374, 200);
      document.body.appendChild(panelEl);

      // The button that closed the panel can still be document.activeElement
      // on the commit that returns to selecting. Chip focus has to win anyway.
      const lingering = document.createElement("button");
      lingering.textContent = "取消";
      document.body.append(lingering);
      lingering.focus();
      expect(document.activeElement).toBe(lingering);

      // Close panel. Focus is owned by finishAskCancelSync, not the layout effect.
      panelEl.remove();
      await act(async () => {
        finishAskCancelSync(null, () => usePlayerStore.getState().closeAskPanel());
      });

      expect(usePlayerStore.getState().askPhase).toBe("selecting");
      const bar = document.querySelector("[data-ask-bottom-bar]");
      expect(bar).not.toBeNull();
      const selectionEl = document.querySelector("[data-ask-selection]");
      expect(selectionEl).not.toBeNull();

      // Focus is on the roving tabIndex=0 chip
      const activeEl = document.activeElement as HTMLElement | null;
      expect(activeEl).not.toBeNull();
      expect(bar!.contains(activeEl)).toBe(true);
      expect(activeEl!.hasAttribute("data-ask-shortcut")).toBe(true);
      expect(activeEl!.tabIndex).toBe(0);

      lingering.remove();
      playerEl.remove();
      window.matchMedia = originalMatchMedia;
    });

    test("narrow matchMedia focuses the chip even when the measure cache says isMobile=false", async () => {
      const originalMatchMedia = window.matchMedia;
      // Mount and the gesture see a desktop viewport, so the measure cache
      // records isMobile=false. Cancel then sees a narrow viewport. A stale
      // cache must not send focus to [data-ask-layer].
      let narrow = false;
      window.matchMedia = vi.fn().mockImplementation((query: string) => ({
        matches: query === "(max-width: 639px)" && narrow,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }));

      await render();
      await gesture(20, 12, 120, 36);
      expect(usePlayerStore.getState().askPhase).toBe("drafting");

      // The queued frame re-measures and overwrites the cache. Snapshot the
      // boolean the cancel commit actually hands to the CSS-var write.
      const realApply = askOcclusion.applyAskSelectingRootVars;
      const isMobileAtWrite: Array<boolean | null> = [];
      vi.spyOn(askOcclusion, "applyAskSelectingRootVars").mockImplementation((cache, active, style) => {
        isMobileAtWrite.push(cache.isMobile);
        return realApply(cache, active, style);
      });
      narrow = true;

      const lingering = document.createElement("button");
      lingering.textContent = "取消";
      document.body.append(lingering);
      lingering.focus();

      await act(async () => {
        finishAskCancelSync(null, () => usePlayerStore.getState().closeAskPanel());
      });

      expect(usePlayerStore.getState().askPhase).toBe("selecting");
      expect(isMobileAtWrite[0]).toBe(false);
      const chip = document.activeElement as HTMLElement | null;
      expect(chip?.hasAttribute("data-ask-shortcut")).toBe(true);
      expect(chip?.hasAttribute("data-ask-layer")).toBe(false);

      lingering.remove();
      window.matchMedia = originalMatchMedia;
    });

    test("owns --ask-player-bar-h from selecting through sending and streaming, and resets only when the panel closes", async () => {
      const originalMatchMedia = window.matchMedia;
      const originalHeight = window.innerHeight;
      Object.defineProperty(window, "innerHeight", { configurable: true, value: 844 });
      window.matchMedia = vi.fn().mockImplementation((query: string) => ({
        matches: query === "(max-width: 639px)",
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }));

      const playerEl = document.createElement("div");
      playerEl.setAttribute("aria-label", "讲解播放区");
      playerEl.getBoundingClientRect = () => domRect(0, 682, 390, 162);
      document.body.appendChild(playerEl);

      const playerVar = () => document.documentElement.style.getPropertyValue("--ask-player-bar-h");

      await render();
      expect(usePlayerStore.getState().askPhase).toBe("selecting");
      expect(document.querySelector("[data-ask-layer]")).not.toBeNull();
      expect(playerVar()).toBe("162px");

      await act(async () => {
        usePlayerStore.setState({ askPhase: "sending" });
      });
      expect(document.querySelector("[data-ask-layer]")).not.toBeNull();
      expect(document.querySelector("[data-ask-shortcut]")).toBeNull();
      expect(playerVar()).toBe("162px");

      await act(async () => {
        usePlayerStore.setState({ askPhase: "streaming" });
      });
      expect(playerVar()).toBe("162px");

      await act(async () => {
        usePlayerStore.setState({ askPhase: "selecting" });
      });
      expect(playerVar()).toBe("162px");

      await act(async () => {
        usePlayerStore.setState({ askPhase: "idle" });
      });
      expect(playerVar()).toBe("0px");

      playerEl.remove();
      Object.defineProperty(window, "innerHeight", { configurable: true, value: originalHeight });
      window.matchMedia = originalMatchMedia;
    });

    test("--ask-player-bar-h is 0 while the virtual keyboard is open and returns after it closes", async () => {
      const originalMatchMedia = window.matchMedia;
      const originalHeight = window.innerHeight;
      const originalViewport = window.visualViewport;
      Object.defineProperty(window, "innerHeight", { configurable: true, value: 844 });
      window.matchMedia = vi.fn().mockImplementation((query: string) => ({
        matches: query === "(max-width: 639px)",
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }));

      let viewportHeight = 844;
      const listeners = new Set<() => void>();
      Object.defineProperty(window, "visualViewport", {
        configurable: true,
        value: {
          get height() {
            return viewportHeight;
          },
          offsetTop: 0,
          addEventListener: (_type: string, fn: () => void) => {
            listeners.add(fn);
          },
          removeEventListener: (_type: string, fn: () => void) => {
            listeners.delete(fn);
          },
        },
      });

      const playerEl = document.createElement("div");
      playerEl.setAttribute("aria-label", "讲解播放区");
      playerEl.getBoundingClientRect = () => domRect(0, 682, 390, 162);
      document.body.appendChild(playerEl);

      const playerVar = () => document.documentElement.style.getPropertyValue("--ask-player-bar-h");

      await render();
      expect(playerVar()).toBe("162px");

      // Keyboard covers more than 120px of layout viewport.
      viewportHeight = 400;
      await act(async () => {
        for (const listener of listeners) listener();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(playerVar()).toBe("0px");

      viewportHeight = 844;
      await act(async () => {
        for (const listener of listeners) listener();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(playerVar()).toBe("162px");

      playerEl.remove();
      Object.defineProperty(window, "innerHeight", { configurable: true, value: originalHeight });
      Object.defineProperty(window, "visualViewport", { configurable: true, value: originalViewport });
      window.matchMedia = originalMatchMedia;
    });

    test("renders exit button inside bottom bar on mobile with data-ask-entry and clicking it exits ask", async () => {
      const originalMatchMedia = window.matchMedia;
      window.matchMedia = vi.fn().mockImplementation((query: string) => ({
        matches: query === "(max-width: 639px)",
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }));

      await render();
      const bar = layer().querySelector<HTMLElement>("[data-ask-bottom-bar]");
      expect(bar).not.toBeNull();

      const exitBtn = bar!.querySelector<HTMLButtonElement>("[data-ask-entry]");
      expect(exitBtn).not.toBeNull();
      expect(exitBtn!.tabIndex).toBe(-1);
      expect(exitBtn!.textContent).toContain("退出圈选");

      await act(async () => {
        exitBtn!.click();
      });

      expect(usePlayerStore.getState().askPhase).toBe("idle");

      window.matchMedia = originalMatchMedia;
    });

    test("bar container has data-ask-layer-part and pointerdown on gap does not start selection", async () => {
      await render();
      const host = layer();
      expect(document.querySelectorAll("[data-ask-layer]").length).toBe(1);

      const bar = host.querySelector<HTMLElement>("[data-ask-bottom-bar]");
      expect(bar).not.toBeNull();
      expect(bar!.getAttribute("data-ask-layer-part")).toBe("bottom-bar");

      // Pointerdown on the bar itself (between chips)
      const pd = new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 1, clientX: 100, clientY: 100 });
      let stopped = false;
      pd.stopPropagation = () => { stopped = true; };

      bar!.dispatchEvent(pd);
      expect(stopped).toBe(true);

      // Rubberband was not started
      expect(host.querySelector("[data-ask-rubber]")).toBeNull();
    });

    test("pointerdown/up on the bar background keeps selection and phase", async () => {
      const initialSelection = {
        mode: "single" as const,
        bbox: { x: 80, y: 10, width: 60, height: 30 },
        targets: [{ kind: "step" as const, id: "step:s1", stepId: "s1", text: "步骤内容" }],
      };
      usePlayerStore.setState({
        askPhase: "selecting",
        selection: initialSelection,
      });

      await render();
      const host = layer();
      const bar = host.querySelector<HTMLElement>("[data-ask-bottom-bar]");
      expect(bar).not.toBeNull();

      const exitSpy = vi.spyOn(usePlayerStore.getState(), "exitAsk");
      const setSelectionSpy = vi.spyOn(usePlayerStore.getState(), "setAskSelection");

      // 1. Dispatch pointerdown and pointerup directly on the bar element
      const pdBar = pointer("pointerdown", { pointerId: 1, clientX: 100, clientY: 100 });
      Object.defineProperty(pdBar, "target", { value: bar });
      const puBar = pointer("pointerup", { pointerId: 1, clientX: 100, clientY: 100 });
      Object.defineProperty(puBar, "target", { value: bar });

      await act(async () => {
        bar!.dispatchEvent(pdBar);
        bar!.dispatchEvent(puBar);
      });

      expect(host.querySelector("[data-ask-rubber]")).toBeNull();
      expect(setSelectionSpy).not.toHaveBeenCalled();
      expect(exitSpy).not.toHaveBeenCalled();
      expect(usePlayerStore.getState().selection).toEqual(initialSelection);
      expect(usePlayerStore.getState().askPhase).toBe("selecting");

      // 2. Dispatch on the layer host with target set to bar background (gap between chips)
      await act(async () => {
        host.dispatchEvent(pdBar);
        host.dispatchEvent(puBar);
      });

      expect(host.querySelector("[data-ask-rubber]")).toBeNull();
      expect(setSelectionSpy).not.toHaveBeenCalled();
      expect(exitSpy).not.toHaveBeenCalled();
      expect(usePlayerStore.getState().selection).toEqual(initialSelection);
      expect(usePlayerStore.getState().askPhase).toBe("selecting");

      // 3. Dispatch on the chips container gap element inside the bar
      const chipsContainer = bar!.querySelector<HTMLElement>('[role="group"][aria-label="快捷选项"]') ?? bar!;
      const pdGap = pointer("pointerdown", { pointerId: 2, clientX: 120, clientY: 100 });
      Object.defineProperty(pdGap, "target", { value: chipsContainer });
      const puGap = pointer("pointerup", { pointerId: 2, clientX: 120, clientY: 100 });
      Object.defineProperty(puGap, "target", { value: chipsContainer });

      await act(async () => {
        chipsContainer.dispatchEvent(pdGap);
        chipsContainer.dispatchEvent(puGap);
      });

      expect(host.querySelector("[data-ask-rubber]")).toBeNull();
      expect(setSelectionSpy).not.toHaveBeenCalled();
      expect(exitSpy).not.toHaveBeenCalled();
      expect(usePlayerStore.getState().selection).toEqual(initialSelection);
      expect(usePlayerStore.getState().askPhase).toBe("selecting");

      await act(async () => {
        host.dispatchEvent(pdGap);
        host.dispatchEvent(puGap);
      });

      expect(host.querySelector("[data-ask-rubber]")).toBeNull();
      expect(setSelectionSpy).not.toHaveBeenCalled();
      expect(exitSpy).not.toHaveBeenCalled();
      expect(usePlayerStore.getState().selection).toEqual(initialSelection);
      expect(usePlayerStore.getState().askPhase).toBe("selecting");
    });
  });

  describe("nextRovingIndex", () => {
    test("ArrowRight moves forward and wraps around", () => {
      expect(nextRovingIndex(0, 3, "ArrowRight")).toBe(1);
      expect(nextRovingIndex(1, 3, "ArrowRight")).toBe(2);
      expect(nextRovingIndex(2, 3, "ArrowRight")).toBe(0);
    });

    test("ArrowLeft moves backward and wraps around", () => {
      expect(nextRovingIndex(0, 3, "ArrowLeft")).toBe(2);
      expect(nextRovingIndex(2, 3, "ArrowLeft")).toBe(1);
      expect(nextRovingIndex(1, 3, "ArrowLeft")).toBe(0);
    });

    test("Home moves to first index and End moves to last", () => {
      expect(nextRovingIndex(2, 3, "Home")).toBe(0);
      expect(nextRovingIndex(0, 3, "End")).toBe(2);
    });

    test("handles empty list gracefully", () => {
      expect(nextRovingIndex(0, 0, "ArrowRight")).toBe(0);
    });
  });

  describe("touch selection ghost click suppression", () => {
    test("touch selection suppresses the subsequent touch click within 400ms and only blocks once", async () => {
      await render();
      const host = layer();

      const down = new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 1, clientX: 20, clientY: 20, pointerType: "touch" });
      const move = new PointerEvent("pointermove", { bubbles: true, cancelable: true, pointerId: 1, clientX: 80, clientY: 80, pointerType: "touch" });
      const up = new PointerEvent("pointerup", { bubbles: true, cancelable: true, pointerId: 1, clientX: 80, clientY: 80, pointerType: "touch" });

      await act(async () => {
        host.dispatchEvent(down);
        host.dispatchEvent(move);
        host.dispatchEvent(up);
      });

      const clickEvent = new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 });
      Object.defineProperty(clickEvent, "timeStamp", { value: up.timeStamp + 50 });

      let stopped = false;
      clickEvent.stopPropagation = () => { stopped = true; };

      await act(async () => {
        document.dispatchEvent(clickEvent);
      });

      expect(clickEvent.defaultPrevented).toBe(true);
      expect(stopped).toBe(true);

      // Second click is not suppressed (only one click blocked)
      const secondClick = new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 });
      Object.defineProperty(secondClick, "timeStamp", { value: up.timeStamp + 60 });
      let secondStopped = false;
      secondClick.stopPropagation = () => { secondStopped = true; };

      await act(async () => {
        document.dispatchEvent(secondClick);
      });

      expect(secondClick.defaultPrevented).toBe(false);
      expect(secondStopped).toBe(false);
    });

    test("subsequent pointerdown clears click suppression", async () => {
      await render();
      const host = layer();

      const down = new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 1, clientX: 20, clientY: 20, pointerType: "touch" });
      const up = new PointerEvent("pointerup", { bubbles: true, cancelable: true, pointerId: 1, clientX: 80, clientY: 80, pointerType: "touch" });

      await act(async () => {
        host.dispatchEvent(down);
        host.dispatchEvent(up);
      });

      // Subsequent pointerdown (e.g. tap on bar chip)
      const nextDown = new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 2, clientX: 50, clientY: 50, pointerType: "touch" });
      await act(async () => {
        document.dispatchEvent(nextDown);
      });

      // Click arrives after the subsequent pointerdown
      const clickEvent = new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 });
      Object.defineProperty(clickEvent, "timeStamp", { value: up.timeStamp + 50 });

      await act(async () => {
        document.dispatchEvent(clickEvent);
      });

      expect(clickEvent.defaultPrevented).toBe(false);
    });

    test("keyboard click (detail === 0) and mouse clicks are never blocked", async () => {
      await render();

      // Mouse selection
      const mouseClick = new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 });
      Object.defineProperty(mouseClick, "timeStamp", { value: 100 });
      await act(async () => {
        document.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse" }));
        document.dispatchEvent(mouseClick);
      });
      expect(mouseClick.defaultPrevented).toBe(false);

      // Keyboard click
      const kbdClick = new MouseEvent("click", { bubbles: true, cancelable: true, detail: 0 });
      Object.defineProperty(kbdClick, "timeStamp", { value: 100 });
      await act(async () => {
        document.dispatchEvent(kbdClick);
      });
      expect(kbdClick.defaultPrevented).toBe(false);
    });

    test("touch that does not complete a selection does not suppress clicks", async () => {
      await render();
      const host = layer();

      const down = new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 1, clientX: 9999, clientY: 9999, pointerType: "touch" });
      const move = new PointerEvent("pointermove", { bubbles: true, cancelable: true, pointerId: 1, clientX: 10005, clientY: 10005, pointerType: "touch" });
      const up = new PointerEvent("pointerup", { bubbles: true, cancelable: true, pointerId: 1, clientX: 10005, clientY: 10005, pointerType: "touch" });

      await act(async () => {
        host.dispatchEvent(down);
        host.dispatchEvent(move);
        host.dispatchEvent(up);
      });

      const clickEvent = new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 });
      Object.defineProperty(clickEvent, "timeStamp", { value: up.timeStamp + 50 });

      await act(async () => {
        document.dispatchEvent(clickEvent);
      });

      expect(clickEvent.defaultPrevented).toBe(false);
    });

    test("mouse selection does not suppress subsequent clicks", async () => {
      await render();
      const host = layer();

      const down = new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 1, clientX: 20, clientY: 20, pointerType: "mouse" });
      const move = new PointerEvent("pointermove", { bubbles: true, cancelable: true, pointerId: 1, clientX: 80, clientY: 80, pointerType: "mouse" });
      const up = new PointerEvent("pointerup", { bubbles: true, cancelable: true, pointerId: 1, clientX: 80, clientY: 80, pointerType: "mouse" });

      await act(async () => {
        host.dispatchEvent(down);
        host.dispatchEvent(move);
        host.dispatchEvent(up);
      });

      const clickEvent = new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 });
      Object.defineProperty(clickEvent, "timeStamp", { value: up.timeStamp + 50 });

      await act(async () => {
        document.dispatchEvent(clickEvent);
      });

      expect(clickEvent.defaultPrevented).toBe(false);
    });

    test("touch pointerup on [data-ask-panel] [data-ask-cancel] when cancel activates on pointerup suppresses subsequent ghost click once", async () => {
      await render();

      await act(async () => {
        usePlayerStore.setState({ askPhase: "drafting" });
      });

      const panel = document.createElement("div");
      panel.setAttribute("data-ask-panel", "");
      const cancelBtn = document.createElement("button");
      cancelBtn.setAttribute("data-ask-cancel", "");
      cancelBtn.textContent = "取消";
      panel.append(cancelBtn);
      document.body.append(panel);

      cancelBtn.addEventListener("pointerup", () => {
        usePlayerStore.setState({ askPhase: "selecting" });
        panel.remove();
      });

      const down = new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 1, pointerType: "touch" });
      const up = new PointerEvent("pointerup", { bubbles: true, cancelable: true, pointerId: 1, pointerType: "touch" });

      await act(async () => {
        cancelBtn.dispatchEvent(down);
        cancelBtn.dispatchEvent(up);
      });

      const ghostClick = new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 });
      Object.defineProperty(ghostClick, "timeStamp", { value: up.timeStamp + 50 });

      let stopped = false;
      ghostClick.stopPropagation = () => { stopped = true; };

      await act(async () => {
        document.body.dispatchEvent(ghostClick);
      });

      expect(ghostClick.defaultPrevented).toBe(true);
      expect(stopped).toBe(true);

      // Block-once rule: second click is not blocked
      const secondClick = new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 });
      Object.defineProperty(secondClick, "timeStamp", { value: up.timeStamp + 60 });

      await act(async () => {
        document.body.dispatchEvent(secondClick);
      });

      expect(secondClick.defaultPrevented).toBe(false);
      if (panel.parentNode) panel.remove();
    });

    test("touch pointerup+click on cancel -> cancel click NOT blocked, panel closes", async () => {
      await render();

      await act(async () => {
        usePlayerStore.setState({ askPhase: "drafting" });
      });

      const panel = document.createElement("div");
      panel.setAttribute("data-ask-panel", "");
      const cancelBtn = document.createElement("button");
      cancelBtn.setAttribute("data-ask-cancel", "");
      cancelBtn.textContent = "取消";
      panel.append(cancelBtn);
      document.body.append(panel);

      cancelBtn.addEventListener("click", () => {
        usePlayerStore.getState().closeAskPanel();
        panel.remove();
      });

      const down = new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 1, pointerType: "touch" });
      const up = new PointerEvent("pointerup", { bubbles: true, cancelable: true, pointerId: 1, pointerType: "touch" });

      await act(async () => {
        cancelBtn.dispatchEvent(down);
        cancelBtn.dispatchEvent(up);
      });

      const clickEvent = new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 });
      Object.defineProperty(clickEvent, "timeStamp", { value: up.timeStamp + 50 });

      await act(async () => {
        cancelBtn.dispatchEvent(clickEvent);
      });

      expect(clickEvent.defaultPrevented).toBe(false);
      expect(usePlayerStore.getState().askPhase).toBe("selecting");

      // Verify no ghost suppression was armed (subsequent tap click is not blocked)
      const afterClick = new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 });
      Object.defineProperty(afterClick, "timeStamp", { value: up.timeStamp + 100 });

      await act(async () => {
        document.body.dispatchEvent(afterClick);
      });
      expect(afterClick.defaultPrevented).toBe(false);

      if (panel.parentNode) panel.remove();
    });

    test("ghost mousedown after a touch cancel does not move focus off the chip", async () => {
      const originalMatchMedia = window.matchMedia;
      window.matchMedia = vi.fn().mockImplementation((query: string) => ({
        matches: query === "(max-width: 639px)",
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }));

      await render();
      await act(async () => {
        usePlayerStore.setState({ askPhase: "drafting" });
      });

      const panel = document.createElement("div");
      panel.setAttribute("data-ask-panel", "");
      const cancelBtn = document.createElement("button");
      cancelBtn.setAttribute("data-ask-cancel", "");
      cancelBtn.textContent = "取消";
      panel.append(cancelBtn);
      document.body.append(panel);

      const down = new PointerEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        pointerType: "touch",
      });
      const up = new PointerEvent("pointerup", {
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        pointerType: "touch",
      });

      await act(async () => {
        cancelBtn.dispatchEvent(down);
        cancelBtn.dispatchEvent(up);
        finishAskCancelSync(panel, () => usePlayerStore.getState().closeAskPanel());
        panel.remove();
      });

      const chip = document.querySelector<HTMLElement>("[data-ask-shortcut]");
      expect(chip).not.toBeNull();
      expect(document.activeElement).toBe(chip);

      const layerEl = document.querySelector<HTMLElement>("[data-ask-layer]");
      expect(layerEl).not.toBeNull();

      const ghostDown = new MouseEvent("mousedown", { bubbles: true, cancelable: true, detail: 1 });
      Object.defineProperty(ghostDown, "timeStamp", { value: up.timeStamp + 50 });

      await act(async () => {
        layerEl!.dispatchEvent(ghostDown);
        if (!ghostDown.defaultPrevented) layerEl!.focus();
      });

      expect(ghostDown.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(chip);
      expect(document.activeElement).not.toBe(layerEl);

      window.matchMedia = originalMatchMedia;
    });

    test("ghost mousedown after a touch waiting cancel (sending -> selecting) does not move focus off the chip", async () => {
      const originalMatchMedia = window.matchMedia;
      window.matchMedia = vi.fn().mockImplementation((query: string) => ({
        matches: query === "(max-width: 639px)",
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }));

      await render();
      await act(async () => {
        usePlayerStore.setState({ askPhase: "sending" });
      });

      const panel = document.createElement("div");
      panel.setAttribute("data-ask-panel", "");
      const cancelBtn = document.createElement("button");
      cancelBtn.setAttribute("data-ask-cancel", "");
      cancelBtn.textContent = "取消";
      panel.append(cancelBtn);
      document.body.append(panel);

      const down = new PointerEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        pointerType: "touch",
      });
      const up = new PointerEvent("pointerup", {
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        pointerType: "touch",
      });

      await act(async () => {
        cancelBtn.dispatchEvent(down);
        cancelBtn.dispatchEvent(up);
        // closeAskPanel only leaves drafting|error. Waiting cancel writes selecting directly.
        finishAskCancelSync(panel, () => usePlayerStore.setState({ askPhase: "selecting" }));
        panel.remove();
      });

      expect(usePlayerStore.getState().askPhase).toBe("selecting");
      const chip = document.querySelector<HTMLElement>("[data-ask-shortcut]");
      expect(chip).not.toBeNull();
      expect(document.activeElement).toBe(chip);

      const layerEl = document.querySelector<HTMLElement>("[data-ask-layer]");
      expect(layerEl).not.toBeNull();

      const ghostDown = new MouseEvent("mousedown", { bubbles: true, cancelable: true, detail: 1 });
      Object.defineProperty(ghostDown, "timeStamp", { value: up.timeStamp + 50 });

      await act(async () => {
        layerEl!.dispatchEvent(ghostDown);
        if (!ghostDown.defaultPrevented) layerEl!.focus();
      });

      expect(ghostDown.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(chip);
      expect(document.activeElement).not.toBe(layerEl);

      window.matchMedia = originalMatchMedia;
    });

    async function flushFocusWork() {
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      await act(async () => {
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => resolve());
        });
      });
      await act(async () => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 0);
        });
      });
    }

    test("mobile sending → selecting via finishAskCancelSync leaves the opener chip focused after rAF", async () => {
      const originalMatchMedia = window.matchMedia;
      window.matchMedia = vi.fn().mockImplementation((query: string) => ({
        matches: query === "(max-width: 639px)",
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }));

      usePlayerStore.getState().setLectureAnswerMeta({
        cacheKey: "ck",
        scriptVersion: "v1",
        askDisabledStepIds: [],
        storageMode: "server",
      });
      usePlayerStore.setState({ answersReady: true, askPhase: "selecting", status: "interrupted" });

      // Entry is already mounted in selecting, then the lecture goes to sending
      // (hide effect off) and cancel returns to selecting. The effect must not
      // move focus onto the bar exit.
      const entryHost = document.createElement("div");
      document.body.append(entryHost);
      const entryRoot = createRoot(entryHost);
      await act(async () => {
        root.render(
          createElement(
            "div",
            null,
            createElement(AskPlayerBarVar),
            createElement(AskSelectionLayer, { stage }),
          ),
        );
        entryRoot.render(createElement(AskEntry));
      });

      await act(async () => {
        usePlayerStore.setState({ askPhase: "sending" });
      });
      await flushFocusWork();

      setAskOpenSource({ kind: "chip", key: "viz" });

      await act(async () => {
        finishAskCancelSync(null, () => usePlayerStore.setState({ askPhase: "selecting" }));
      });

      await flushFocusWork();

      const chip = document.querySelector<HTMLElement>('[data-ask-shortcut="viz"]');
      const exitBtn = document.querySelector<HTMLButtonElement>("[data-ask-bottom-bar] [data-ask-entry]");
      expect(chip).not.toBeNull();
      expect(exitBtn).not.toBeNull();
      expect(document.activeElement).toBe(chip);
      expect(document.activeElement).not.toBe(exitBtn);
      expect(exitBtn!.style.pointerEvents).toBe("none");

      await act(async () => entryRoot.unmount());
      entryHost.remove();
      window.matchMedia = originalMatchMedia;
    });

    test("ghost window: programmatic focus on the bar exit is restored to the chip synchronously", async () => {
      const originalMatchMedia = window.matchMedia;
      window.matchMedia = vi.fn().mockImplementation((query: string) => ({
        matches: query === "(max-width: 639px)",
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }));

      await render();
      await act(async () => {
        usePlayerStore.setState({ askPhase: "selecting" });
      });
      setAskOpenSource({ kind: "chip", key: "viz" });

      const chip = document.querySelector<HTMLElement>('[data-ask-shortcut="viz"]');
      const exitBtn = document.querySelector<HTMLButtonElement>("[data-ask-bottom-bar] [data-ask-entry]");
      expect(chip).not.toBeNull();
      expect(exitBtn).not.toBeNull();
      chip!.focus();
      expect(document.activeElement).toBe(chip);

      armAskCancelGhostSuppress();
      expect(isAskCancelGhostActive()).toBe(true);
      expect(exitBtn!.style.pointerEvents).toBe("none");

      // focus() is synchronous and fires focusin before it returns.
      exitBtn!.focus();
      expect(document.activeElement).toBe(chip);
      expect(document.activeElement).not.toBe(exitBtn);

      window.matchMedia = originalMatchMedia;
    });

    test("sending cancel then mousedown on the bar exit leaves the opener chip focused", async () => {
      const originalMatchMedia = window.matchMedia;
      window.matchMedia = vi.fn().mockImplementation((query: string) => ({
        matches: query === "(max-width: 639px)",
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }));

      await render();
      await act(async () => {
        usePlayerStore.setState({ askPhase: "sending" });
      });
      expect(document.querySelector("[data-ask-shortcut]")).toBeNull();

      setAskOpenSource({ kind: "chip", key: "viz" });

      await act(async () => {
        finishAskCancelSync(null, () => usePlayerStore.setState({ askPhase: "selecting" }));
      });

      const chip = document.querySelector<HTMLElement>('[data-ask-shortcut="viz"]');
      const exitBtn = document.querySelector<HTMLButtonElement>("[data-ask-bottom-bar] [data-ask-entry]");
      expect(chip).not.toBeNull();
      expect(exitBtn).not.toBeNull();
      expect(exitBtn!.tabIndex).toBe(-1);
      // Assert before any unmount. The bar and the exit button are still mounted.
      expect(document.querySelector("[data-ask-bottom-bar]")).not.toBeNull();
      expect(document.activeElement).toBe(chip);
      expect(askCancelGhostUntil).toBeGreaterThan(performance.now());

      const ghostDown = new MouseEvent("mousedown", { bubbles: true, cancelable: true, detail: 1 });
      await act(async () => {
        exitBtn!.dispatchEvent(ghostDown);
        if (!ghostDown.defaultPrevented) exitBtn!.focus();
      });

      expect(ghostDown.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(chip);
      expect(document.activeElement).not.toBe(exitBtn);
      expect(document.querySelector("[data-ask-bottom-bar]")).not.toBeNull();

      window.matchMedia = originalMatchMedia;
    });

    test("touch pointerup on cancel followed by new pointerdown clears suppression", async () => {
      await render();

      await act(async () => {
        usePlayerStore.setState({ askPhase: "drafting" });
      });

      const panel = document.createElement("div");
      panel.setAttribute("data-ask-panel", "");
      const cancelBtn = document.createElement("button");
      cancelBtn.setAttribute("data-ask-cancel", "");
      cancelBtn.textContent = "取消";
      panel.append(cancelBtn);

      const exitBtn = document.createElement("button");
      exitBtn.setAttribute("data-ask-entry", "");
      document.body.append(panel, exitBtn);

      cancelBtn.addEventListener("pointerup", () => {
        usePlayerStore.setState({ askPhase: "selecting" });
        panel.remove();
      });

      const down = new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 1, pointerType: "touch" });
      const up = new PointerEvent("pointerup", { bubbles: true, cancelable: true, pointerId: 1, pointerType: "touch" });

      await act(async () => {
        cancelBtn.dispatchEvent(down);
        cancelBtn.dispatchEvent(up);
      });

      // User immediately taps another button within 100ms
      const newDown = new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 2, pointerType: "touch" });
      const newUp = new PointerEvent("pointerup", { bubbles: true, cancelable: true, pointerId: 2, pointerType: "touch" });
      const clickEvent = new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 });
      Object.defineProperty(clickEvent, "timeStamp", { value: up.timeStamp + 50 });

      await act(async () => {
        exitBtn.dispatchEvent(newDown);
        exitBtn.dispatchEvent(newUp);
        exitBtn.dispatchEvent(clickEvent);
      });

      expect(clickEvent.defaultPrevented).toBe(false);

      if (panel.parentNode) panel.remove();
      exitBtn.remove();
    });

    function mobileMatchMedia() {
      return vi.fn().mockImplementation((query: string) => ({
        matches: query === "(max-width: 639px)",
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }));
    }

    /** Hold requestAnimationFrame so a commit can be observed before the frame runs. */
    function holdAnimationFrames() {
      const queued: FrameRequestCallback[] = [];
      const original = window.requestAnimationFrame.bind(window);
      const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback: FrameRequestCallback) => {
        queued.push(callback);
        return queued.length;
      });
      return {
        raf,
        pending: () => queued.length,
        async flush() {
          const batch = queued.splice(0, queued.length);
          await act(async () => {
            for (const callback of batch) callback(performance.now());
          });
        },
        restore() {
          raf.mockRestore();
          void original;
        },
      };
    }

    test("askPhase change writes --ask-bottom-bar-h on the next frame, not in the commit", async () => {
      const originalMatchMedia = window.matchMedia;
      window.matchMedia = mobileMatchMedia();

      const playerEl = document.createElement("div");
      playerEl.setAttribute("aria-label", "讲解播放区");
      playerEl.getBoundingClientRect = () => domRect(0, 708, 390, 60);
      document.body.appendChild(playerEl);

      document.documentElement.style.removeProperty("--ask-bottom-bar-h");
      document.documentElement.style.removeProperty("--ask-bottom-occlusion");

      const frames = holdAnimationFrames();
      await render();
      const bar = layer().querySelector<HTMLElement>("[data-ask-bottom-bar]");
      expect(bar).not.toBeNull();
      bar!.getBoundingClientRect = () => domRect(8, 790, 374, 52);

      // Mount schedules the first measurement; nothing is written inside the commit.
      expect(document.documentElement.style.getPropertyValue("--ask-bottom-bar-h")).toBe("");
      expect(frames.pending()).toBeGreaterThan(0);
      await frames.flush();
      expect(document.documentElement.style.getPropertyValue("--ask-bottom-bar-h")).toBe("52px");
      expect(document.documentElement.style.getPropertyValue("--ask-bottom-occlusion")).toBe("120px");

      const setProperty = vi.spyOn(document.documentElement.style, "setProperty");
      await act(async () => {
        usePlayerStore.setState({ askPhase: "drafting" });
      });
      // The commit itself does not touch the variables. The bar unmounts in
      // drafting, so the queued frame is the one that publishes 0px.
      const duringCommit = setProperty.mock.calls.filter(
        (call) => call[0] === "--ask-bottom-bar-h" || call[0] === "--ask-bottom-occlusion",
      );
      expect(duringCommit).toEqual([]);
      expect(document.documentElement.style.getPropertyValue("--ask-bottom-bar-h")).toBe("52px");
      expect(frames.pending()).toBe(1);

      await frames.flush();
      expect(document.documentElement.style.getPropertyValue("--ask-bottom-bar-h")).toBe("0px");
      expect(document.documentElement.style.getPropertyValue("--ask-bottom-occlusion")).toBe("68px");
      expect(frames.pending()).toBe(0);

      setProperty.mockRestore();
      frames.restore();
      playerEl.remove();
      window.matchMedia = originalMatchMedia;
    });

    test("cancel (drafting→selecting) sync-writes selecting CSS targets in the commit; box and bottom-bar geometry unchanged", async () => {
      const originalMatchMedia = window.matchMedia;
      window.matchMedia = mobileMatchMedia();

      const playerEl = document.createElement("div");
      playerEl.setAttribute("aria-label", "讲解播放区");
      playerEl.getBoundingClientRect = () => domRect(0, 708, 390, 60);
      document.body.appendChild(playerEl);

      document.documentElement.style.removeProperty("--ask-bottom-bar-h");
      document.documentElement.style.removeProperty("--ask-bottom-occlusion");

      const frames = holdAnimationFrames();
      // Stable rects. Cancel reuses the bar height measured while selecting,
      // so the remounted node does not have to be measured in that commit.
      const barRect = domRect(8, 790, 374, 52);
      const originalRect = HTMLElement.prototype.getBoundingClientRect;
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
        this: HTMLElement,
      ) {
        if (this.hasAttribute("data-ask-bottom-bar")) return barRect;
        if (this.hasAttribute("data-ask-selection")) return domRect(20, 12, 100, 24);
        return originalRect.call(this);
      });
      const selection = {
        mode: "region" as const,
        bbox: { x: 20, y: 12, width: 100, height: 24 },
        targets: [
          { kind: "subtitle" as const, id: "subtitle:s1", stepId: "s1", text: "字幕内容" },
          { kind: "step" as const, id: "step:s1", stepId: "s1", text: "步骤内容" },
        ],
      };
      usePlayerStore.setState({ askPhase: "selecting", selection });
      await render();

      expect(document.querySelector("[data-ask-bottom-bar]")).not.toBeNull();

      // First frame publishes selecting targets: bar 52, player 60 + bar + gap = 120.
      expect(frames.pending()).toBeGreaterThan(0);
      await frames.flush();
      expect(document.documentElement.style.getPropertyValue("--ask-bottom-bar-h")).toBe("52px");
      expect(document.documentElement.style.getPropertyValue("--ask-bottom-occlusion")).toBe("120px");
      expect(document.documentElement.style.getPropertyValue("--ask-player-bar-h")).toBe("60px");

      await act(async () => {
        usePlayerStore.setState({ askPhase: "drafting" });
      });
      const panelEl = document.createElement("div");
      panelEl.setAttribute("data-ask-panel", "");
      panelEl.getBoundingClientRect = () => domRect(8, 500, 374, 200);
      document.body.appendChild(panelEl);
      // Drafting frame: bar unmounted so bar height is 0; occlusion includes the panel.
      expect(frames.pending()).toBeGreaterThan(0);
      await frames.flush();
      expect(document.documentElement.style.getPropertyValue("--ask-bottom-bar-h")).toBe("0px");
      expect(document.documentElement.style.getPropertyValue("--ask-bottom-occlusion")).toBe("268px");

      const selectingBar = "52px";
      const selectingOcclusion = `${computeBottomOcclusion({
        playerHeight: 60,
        barHeight: 52,
        panelHeight: 0,
      })}px`;
      expect(selectingOcclusion).toBe("120px");

      const setProperty = vi.spyOn(document.documentElement.style, "setProperty");
      // Panel unmounts before the cancel commit, the way AskPanel does.
      panelEl.remove();
      await act(async () => {
        usePlayerStore.getState().closeAskPanel();
      });

      expect(usePlayerStore.getState().askPhase).toBe("selecting");
      // Selecting targets are already on the root. The queued frame has not run.
      expect(document.documentElement.style.getPropertyValue("--ask-bottom-bar-h")).toBe(selectingBar);
      expect(document.documentElement.style.getPropertyValue("--ask-bottom-occlusion")).toBe(selectingOcclusion);
      const duringCommit = setProperty.mock.calls.filter(
        (call) => call[0] === "--ask-bottom-bar-h" || call[0] === "--ask-bottom-occlusion",
      );
      expect(duringCommit).toEqual([
        ["--ask-bottom-bar-h", selectingBar],
        ["--ask-bottom-occlusion", selectingOcclusion],
      ]);
      expect(frames.pending()).toBeGreaterThan(0);

      const boxOf = (el: Element | null) => {
        const rect = el?.getBoundingClientRect();
        return rect
          ? { top: rect.top, left: rect.left, width: rect.width, height: rect.height }
          : null;
      };
      const selectionEl = document.querySelector("[data-ask-selection]");
      const barEl = document.querySelector("[data-ask-bottom-bar]");
      expect(selectionEl).not.toBeNull();
      expect(barEl).not.toBeNull();
      const boxBefore = boxOf(selectionEl);
      const barBefore = boxOf(barEl);

      await frames.flush();
      expect(document.documentElement.style.getPropertyValue("--ask-bottom-bar-h")).toBe(selectingBar);
      expect(document.documentElement.style.getPropertyValue("--ask-bottom-occlusion")).toBe(selectingOcclusion);
      expect(boxOf(document.querySelector("[data-ask-selection]"))).toEqual(boxBefore);
      expect(boxOf(document.querySelector("[data-ask-bottom-bar]"))).toEqual(barBefore);
      // The follow-up frame rebinds observers and does not rewrite a matching value.
      const afterFlush = setProperty.mock.calls.filter(
        (call) => call[0] === "--ask-bottom-bar-h" || call[0] === "--ask-bottom-occlusion",
      );
      expect(afterFlush).toEqual(duringCommit);

      setProperty.mockRestore();
      frames.restore();
      playerEl.remove();
      window.matchMedia = originalMatchMedia;
    });

    test("an update does not rewrite a CSS variable whose inline value is unchanged", async () => {
      const originalMatchMedia = window.matchMedia;
      window.matchMedia = mobileMatchMedia();

      const playerEl = document.createElement("div");
      playerEl.setAttribute("aria-label", "讲解播放区");
      playerEl.getBoundingClientRect = () => domRect(0, 708, 390, 60);
      document.body.appendChild(playerEl);

      await render();
      const bar = layer().querySelector<HTMLElement>("[data-ask-bottom-bar]");
      expect(bar).not.toBeNull();
      bar!.getBoundingClientRect = () => domRect(8, 790, 374, 52);

      await act(async () => {
        window.dispatchEvent(new Event("resize"));
      });
      expect(document.documentElement.style.getPropertyValue("--ask-bottom-bar-h")).toBe("52px");
      expect(document.documentElement.style.getPropertyValue("--ask-bottom-occlusion")).toBe("120px");

      const setProperty = vi.spyOn(document.documentElement.style, "setProperty");
      await act(async () => {
        window.dispatchEvent(new Event("resize"));
      });

      const rewritten = setProperty.mock.calls.filter(
        (call) => call[0] === "--ask-bottom-bar-h" || call[0] === "--ask-bottom-occlusion",
      );
      expect(rewritten).toEqual([]);
      expect(document.documentElement.style.getPropertyValue("--ask-bottom-bar-h")).toBe("52px");
      expect(document.documentElement.style.getPropertyValue("--ask-bottom-occlusion")).toBe("120px");

      setProperty.mockRestore();
      playerEl.remove();
      window.matchMedia = originalMatchMedia;
    });

    test("one update reads matchMedia, viewport, and element heights before any CSS write", async () => {
      const originalMatchMedia = window.matchMedia;
      const originalViewport = window.visualViewport;
      const order: string[] = [];
      window.matchMedia = vi.fn().mockImplementation((query: string) => {
        order.push(`read:matchMedia:${query}`);
        return {
          matches: query === "(max-width: 639px)",
          media: query,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        };
      });
      // happy-dom ships no visualViewport. A stub records the keyboard read.
      Object.defineProperty(window, "visualViewport", {
        configurable: true,
        value: {
          get height() {
            order.push("read:visualViewport");
            return 844;
          },
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        },
      });

      let playerHeight = 60;
      const playerEl = document.createElement("div");
      playerEl.setAttribute("aria-label", "讲解播放区");
      playerEl.getBoundingClientRect = () => domRect(0, 844 - playerHeight, 390, playerHeight);
      document.body.appendChild(playerEl);

      // AskPlayerBarVar measures the player on its own. Spying the occlusion
      // helpers records only the reads updateMeasurements takes.
      vi.spyOn(askOcclusion, "measureAskPlayerBarHeight").mockImplementation(() => {
        order.push("read:player");
        return playerHeight;
      });
      vi.spyOn(askOcclusion, "measureAskElementHeight").mockImplementation((el) => {
        order.push(el?.hasAttribute?.("data-ask-panel") ? "read:panel" : "read:bar");
        if (!el) return 0;
        return Math.ceil(el.getBoundingClientRect().height);
      });

      const rawSetProperty = CSSStyleDeclaration.prototype.setProperty;
      vi.spyOn(CSSStyleDeclaration.prototype, "setProperty").mockImplementation(function (
        this: CSSStyleDeclaration,
        property: string,
        value: string | null,
        priority?: string,
      ) {
        if (property === "--ask-bottom-bar-h" || property === "--ask-bottom-occlusion") {
          order.push(`write:${property}`);
        }
        return rawSetProperty.call(this, property, value, priority);
      });

      await render();
      const bar = layer().querySelector<HTMLElement>("[data-ask-bottom-bar]");
      expect(bar).not.toBeNull();
      let barHeight = 52;
      bar!.getBoundingClientRect = () => {
        order.push("read:rect:bar");
        return domRect(8, 790, 374, barHeight);
      };

      // Publish the current geometry first. Scroll only schedules a measurement;
      // it does not clear the selection the way resize does.
      await act(async () => {
        window.dispatchEvent(new Event("scroll"));
      });
      expect(document.documentElement.style.getPropertyValue("--ask-bottom-bar-h")).toBe("52px");

      order.length = 0;
      playerHeight = 80;
      barHeight = 40;
      await act(async () => {
        window.dispatchEvent(new Event("scroll"));
      });

      const writeAt = order.findIndex((entry) => entry.startsWith("write:"));
      expect(writeAt).toBeGreaterThan(0);
      const readsBeforeWrite = order.slice(0, writeAt);
      expect(readsBeforeWrite.some((entry) => entry.startsWith("read:matchMedia:(max-width: 639px)"))).toBe(true);
      expect(readsBeforeWrite).toContain("read:visualViewport");
      expect(readsBeforeWrite).toContain("read:player");
      expect(readsBeforeWrite).toContain("read:bar");
      expect(order.slice(writeAt).some((entry) => entry.startsWith("read:"))).toBe(false);
      expect(order.filter((entry) => entry.startsWith("write:"))).toEqual([
        "write:--ask-bottom-bar-h",
        "write:--ask-bottom-occlusion",
      ]);

      playerEl.remove();
      Object.defineProperty(window, "visualViewport", { configurable: true, value: originalViewport });
      window.matchMedia = originalMatchMedia;
    });

    test("mouse pointerup on cancel button does not block clicks", async () => {
      await render();

      const panel = document.createElement("div");
      panel.setAttribute("data-ask-panel", "");
      const cancelBtn = document.createElement("button");
      cancelBtn.setAttribute("data-ask-cancel", "");
      cancelBtn.textContent = "取消";
      panel.append(cancelBtn);
      document.body.append(panel);

      const down = new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse" });
      const up = new PointerEvent("pointerup", { bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse" });
      const clickEvent = new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 });
      Object.defineProperty(clickEvent, "timeStamp", { value: up.timeStamp + 50 });

      await act(async () => {
        cancelBtn.dispatchEvent(down);
        cancelBtn.dispatchEvent(up);
        cancelBtn.dispatchEvent(clickEvent);
      });

      expect(clickEvent.defaultPrevented).toBe(false);

      panel.remove();
    });
  });

  let fakeNow = 1000;
  let currentScrollY = 0;
  let nextRafId = 1;
  const pendingRafs = new Map<number, FrameRequestCallback>();
  let cleanupEnteringScroll: (() => void) | null = null;

  function setupEnteringScrollEnv() {
    fakeNow = 1000;
    currentScrollY = 0;
    nextRafId = 1;
    pendingRafs.clear();

    vi.spyOn(performance, "now").mockImplementation(() => fakeNow);

    const origMatchMedia = window.matchMedia;
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === "(max-width: 639px)",
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));

    Object.defineProperty(window, "scrollY", {
      get: () => currentScrollY,
      set: (v: number) => {
        currentScrollY = v;
      },
      configurable: true,
    });

    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      const id = nextRafId++;
      pendingRafs.set(id, cb);
      return id;
    });

    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
      pendingRafs.delete(id as number);
    });

    cleanupEnteringScroll = () => {
      pendingRafs.clear();
      window.matchMedia = origMatchMedia;
      delete (window as unknown as { scrollY?: number }).scrollY;
    };
  }

  function flushPendingRafs() {
    const entries = Array.from(pendingRafs.entries());
    pendingRafs.clear();
    for (const [, cb] of entries) {
      cb(fakeNow);
    }
  }

  function ensureCodeElement() {
    let codeEl = stage.querySelector<HTMLElement>('[data-ask-target="code"]');
    if (!codeEl) {
      codeEl = document.createElement("div");
      codeEl.setAttribute("data-ask-target", "code");
      stage.appendChild(codeEl);
    }
    codeEl.getBoundingClientRect = () => domRect(0, 900, 390, 200);
    codeEl.scrollIntoView = vi.fn();
    return codeEl;
  }

  async function startEnteringScroll(initialScrollY = 10) {
    ensureCodeElement();
    await render();
    await act(async () => {
      flushPendingRafs();
    });
    if (initialScrollY > 0) {
      currentScrollY = initialScrollY;
      window.dispatchEvent(new Event("scroll"));
    }
  }

  async function reenterSelectionWithScroll(newScrollY = 20) {
    ensureCodeElement();
    await act(async () => {
      usePlayerStore.setState({ askPhase: "idle" });
    });
    await act(async () => {
      usePlayerStore.setState({ askPhase: "selecting" });
    });
    await act(async () => {
      flushPendingRafs();
    });
    currentScrollY = newScrollY;
    window.dispatchEvent(new Event("scroll"));
  }

  describe("chip390-b nits N1-N3", () => {
    afterEach(() => {
      cleanupEnteringScroll?.();
      cleanupEnteringScroll = null;
    });

    test("N1: settle rAF is cancelled on pointerup and unmount", async () => {
      setupEnteringScrollEnv();
      await startEnteringScroll(10);
      const rafSpy = vi.spyOn(window, "requestAnimationFrame");
      const cancelSpy = vi.spyOn(window, "cancelAnimationFrame");
      const host = layer();

      // (a) pointerup cancels the scheduled settle rAF
      let settleRafId1: number | undefined;
      await act(async () => {
        host.dispatchEvent(pointer("pointerdown", { pointerId: 1, clientX: 20, clientY: 20 }));
        settleRafId1 = rafSpy.mock.results.at(-1)?.value;
        host.dispatchEvent(pointer("pointerup", { pointerId: 1, clientX: 20, clientY: 20 }));
      });
      expect(settleRafId1).toBeDefined();
      expect(cancelSpy).toHaveBeenCalledWith(settleRafId1);

      cancelSpy.mockClear();
      rafSpy.mockClear();

      // (b) unmount cancels any pending settle rAF
      await reenterSelectionWithScroll(20);
      cancelSpy.mockClear();
      rafSpy.mockClear();
      const host2 = layer();
      let settleRafId2: number | undefined;
      await act(async () => {
        host2.dispatchEvent(pointer("pointerdown", { pointerId: 2, clientX: 30, clientY: 30 }));
        settleRafId2 = rafSpy.mock.results.at(-1)?.value;
        root.unmount();
      });
      expect(settleRafId2).toBeDefined();
      expect(cancelSpy).toHaveBeenCalledWith(settleRafId2);

      // Re-create root for cleanup in afterEach
      root = createRoot(container);
    });

    test("N1: settle rAF is cancelled on pointercancel and before scheduling new one", async () => {
      setupEnteringScrollEnv();
      await startEnteringScroll(10);
      const rafSpy = vi.spyOn(window, "requestAnimationFrame");
      const cancelSpy = vi.spyOn(window, "cancelAnimationFrame");
      let host = layer();

      // (a) pointercancel cancels the scheduled settle rAF
      let settleRafId1: number | undefined;
      await act(async () => {
        host.dispatchEvent(pointer("pointerdown", { pointerId: 1, clientX: 20, clientY: 20 }));
        settleRafId1 = rafSpy.mock.results.at(-1)?.value;
        host.dispatchEvent(pointer("pointercancel", { pointerId: 1 }));
      });
      expect(settleRafId1).toBeDefined();
      expect(cancelSpy).toHaveBeenCalledWith(settleRafId1);

      cancelSpy.mockClear();
      rafSpy.mockClear();

      // (b) scheduling a new pointerdown cancels the previous pending settle rAF
      await reenterSelectionWithScroll(20);
      host = layer();
      cancelSpy.mockClear();
      rafSpy.mockClear();

      let settleRafId2: number | undefined;
      await act(async () => {
        host.dispatchEvent(pointer("pointerdown", { pointerId: 2, clientX: 20, clientY: 20 }));
        settleRafId2 = rafSpy.mock.results.at(-1)?.value;
        host.dispatchEvent(pointer("pointerdown", { pointerId: 3, clientX: 40, clientY: 40 }));
      });
      expect(settleRafId2).toBeDefined();
      expect(cancelSpy).toHaveBeenCalledWith(settleRafId2);
    });

    test("N2: pointerup before frame commits re-sampled start for tap and drag", async () => {
      const pointSpy = vi.spyOn(hitTest, "hitTestPoint");
      const regionSpy = vi.spyOn(hitTest, "hitTest");
      setupEnteringScrollEnv();
      await startEnteringScroll(10);
      const host = layer();

      // Tap: pointerdown -> layout shift -> pointerup before rAF runs
      await act(async () => {
        host.dispatchEvent(pointer("pointerdown", { pointerId: 1, clientX: 20, clientY: 20 }));
        // Layout settles before rAF runs (e.g. stage scrolled, rect.top shifted by 15px)
        stage.getBoundingClientRect = () => domRect(0, -15, 400, 300);
        host.dispatchEvent(pointer("pointerup", { pointerId: 1, clientX: 20, clientY: 20 }));
      });

      // Synchronously re-sampled start (y = 20 - (-15) = 35) was passed to hitTestPoint, not the pre-snap y=20
      expect(pointSpy).toHaveBeenCalledWith(20, 35, expect.anything());

      pointSpy.mockClear();
      usePlayerStore.getState().clearAskSelection();

      // Drag: pointerdown -> pointermove -> layout shift -> pointerup before rAF runs
      stage.getBoundingClientRect = () => domRect(0, 0, 400, 300);
      await reenterSelectionWithScroll(20);
      const hostDrag = layer();

      await act(async () => {
        hostDrag.dispatchEvent(pointer("pointerdown", { pointerId: 2, clientX: 20, clientY: 20 }));
        hostDrag.dispatchEvent(pointer("pointermove", { pointerId: 2, clientX: 60, clientY: 70 }));
        // Layout settles before rAF
        stage.getBoundingClientRect = () => domRect(0, -10, 400, 300);
        hostDrag.dispatchEvent(pointer("pointerup", { pointerId: 2, clientX: 60, clientY: 70 }));
      });

      // Drag bounding box should start at re-sampled y = 20 - (-10) = 30
      expect(regionSpy).toHaveBeenCalledWith(
        expect.objectContaining({ x: 20, y: 30 }),
        expect.anything(),
      );
    });

    test("N3: modified Enter/Space on focused chip: no selection / existing selection unchanged, panel phase unchanged, Ctrl+Enter and Meta+Enter reach document", async () => {
      await render();
      const host = layer();
      const chip = host.querySelector<HTMLButtonElement>('[data-ask-shortcut="step"]');
      expect(chip).not.toBeNull();
      chip!.focus();

      const docSeen: KeyboardEvent[] = [];
      const onDocKeyDown = (e: KeyboardEvent) => {
        docSeen.push(e);
      };
      document.addEventListener("keydown", onDocKeyDown);

      try {
        // 1. Shift+Enter
        const enterEv = new KeyboardEvent("keydown", {
          key: "Enter",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        });
        const stopSpyEnter = vi.spyOn(enterEv, "stopPropagation");

        await act(async () => {
          chip!.dispatchEvent(enterEv);
        });

        expect(stopSpyEnter).not.toHaveBeenCalled();
        expect(usePlayerStore.getState().selection).toBeNull();
        expect(usePlayerStore.getState().askPhase).toBe("selecting");

        // 2. Shift+Space
        const spaceEv = new KeyboardEvent("keydown", {
          key: " ",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        });
        const stopSpySpace = vi.spyOn(spaceEv, "stopPropagation");
        const prevDefaultSpySpace = vi.spyOn(spaceEv, "preventDefault");

        await act(async () => {
          chip!.dispatchEvent(spaceEv);
        });

        expect(stopSpySpace).not.toHaveBeenCalled();
        expect(prevDefaultSpySpace).not.toHaveBeenCalled();
        expect(usePlayerStore.getState().selection).toBeNull();
        expect(usePlayerStore.getState().askPhase).toBe("selecting");

        // 3. Ctrl+Enter & Meta+Enter reach document listener
        const ctrlEnterEv = new KeyboardEvent("keydown", {
          key: "Enter",
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        });
        const stopSpyCtrl = vi.spyOn(ctrlEnterEv, "stopPropagation");

        await act(async () => {
          chip!.dispatchEvent(ctrlEnterEv);
        });

        expect(stopSpyCtrl).not.toHaveBeenCalled();
        expect(usePlayerStore.getState().selection).toBeNull();
        expect(usePlayerStore.getState().askPhase).toBe("selecting");

        const metaEnterEv = new KeyboardEvent("keydown", {
          key: "Enter",
          metaKey: true,
          bubbles: true,
          cancelable: true,
        });
        const stopSpyMeta = vi.spyOn(metaEnterEv, "stopPropagation");

        await act(async () => {
          chip!.dispatchEvent(metaEnterEv);
        });

        expect(stopSpyMeta).not.toHaveBeenCalled();
        expect(usePlayerStore.getState().selection).toBeNull();
        expect(usePlayerStore.getState().askPhase).toBe("selecting");

        expect(docSeen).toContain(ctrlEnterEv);
        expect(docSeen).toContain(metaEnterEv);

        // 4. Existing selection unchanged & panel phase unchanged (selecting)
        const priorSelection = {
          mode: "single" as const,
          bbox: { x: 10, y: 10, width: 50, height: 20 },
          targets: [{ id: "subtitle:s1", kind: "subtitle" as const, text: "字幕文本" }],
        };
        usePlayerStore.setState({ selection: priorSelection, askPhase: "selecting" });

        for (const [key, mod] of [
          ["Enter", { shiftKey: true }],
          ["Enter", { ctrlKey: true }],
          ["Enter", { metaKey: true }],
          ["Enter", { altKey: true }],
          [" ", { shiftKey: true }],
          [" ", { ctrlKey: true }],
          [" ", { metaKey: true }],
          [" ", { altKey: true }],
        ] as const) {
          const ev = new KeyboardEvent("keydown", {
            key,
            ...mod,
            bubbles: true,
            cancelable: true,
          });
          const stopSpy = vi.spyOn(ev, "stopPropagation");
          await act(async () => {
            chip!.dispatchEvent(ev);
          });
          expect(stopSpy).not.toHaveBeenCalled();
          expect(usePlayerStore.getState().selection).toEqual(priorSelection);
          expect(usePlayerStore.getState().askPhase).toBe("selecting");
        }
      } finally {
        document.removeEventListener("keydown", onDocKeyDown);
      }
    });

    test("modified click on shortcut chip selects the chip as normal", async () => {
      await render();

      for (const mod of [
        { shiftKey: true },
        { ctrlKey: true },
        { altKey: true },
        { metaKey: true },
      ] as const) {
        await act(async () => usePlayerStore.setState({ askPhase: "selecting", selection: null }));
        const chip = layer().querySelector<HTMLButtonElement>('[data-ask-shortcut="subtitle"]');
        expect(chip).not.toBeNull();
        const clickEv = new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          detail: 1,
          ...mod,
        });
        await act(async () => {
          chip!.dispatchEvent(clickEv);
        });
        const selection = usePlayerStore.getState().selection;
        expect(selection?.mode).toBe("single");
        expect(selection?.targets[0]?.id).toBe("subtitle:s1");
        expect(usePlayerStore.getState().askPhase).toBe("drafting");
      }
    });

    test("synthetic click with detail 0 + ctrlKey does not select; click with detail 1 + shiftKey selects", async () => {
      await render();
      const chip = layer().querySelector<HTMLButtonElement>('[data-ask-shortcut="subtitle"]');
      expect(chip).not.toBeNull();

      // Synthetic click with detail 0 + ctrlKey does not select
      const syntheticClick = new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        detail: 0,
        ctrlKey: true,
      });
      await act(async () => {
        chip!.dispatchEvent(syntheticClick);
      });
      expect(usePlayerStore.getState().selection).toBeNull();
      expect(usePlayerStore.getState().askPhase).toBe("selecting");

      // Click with detail 1 + shiftKey selects
      const realClick = new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        detail: 1,
        shiftKey: true,
      });
      await act(async () => {
        chip!.dispatchEvent(realClick);
      });
      const selection = usePlayerStore.getState().selection;
      expect(selection?.mode).toBe("single");
      expect(selection?.targets[0]?.id).toBe("subtitle:s1");
      expect(usePlayerStore.getState().askPhase).toBe("drafting");
    });
  });

  describe("entering scroll live detection at pointerdown", () => {
    afterEach(() => {
      vi.useRealTimers();
      cleanupEnteringScroll?.();
      cleanupEnteringScroll = null;
    });

    test("idle pointerdown -> no rAF and no scrollTo (including stale-true flag with non-moving scroll)", async () => {
      setupEnteringScrollEnv();
      const rafSpy = vi.spyOn(window, "requestAnimationFrame");
      const windowScrollSpy = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
      const scrollerScrollSpy = vi.fn();
      scroller.scrollTo = scrollerScrollSpy;

      // 1. 完全空闲状态：reduced motion 为 true，不启动平滑滚动追踪器
      window.matchMedia = vi.fn().mockImplementation((query: string) => ({
        matches: query === "(prefers-reduced-motion: reduce)" || query === "(max-width: 639px)",
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }));

      await render();
      await act(async () => {
        flushPendingRafs();
      });
      rafSpy.mockClear();
      windowScrollSpy.mockClear();
      scrollerScrollSpy.mockClear();

      let host = layer();
      await act(async () => {
        host.dispatchEvent(pointer("pointerdown", { pointerId: 1, clientX: 20, clientY: 20 }));
      });

      expect(rafSpy).not.toHaveBeenCalled();
      expect(windowScrollSpy).not.toHaveBeenCalled();
      expect(scrollerScrollSpy).not.toHaveBeenCalled();

      // 清理指针状态
      await act(async () => {
        host.dispatchEvent(pointer("pointerup", { pointerId: 1, clientX: 20, clientY: 20 }));
      });
      usePlayerStore.getState().clearAskSelection();

      // 2. 残留 true 标志与静止滚动（stale-true flag with non-moving scroll）：
      // 追踪器状态激活，但当前位置与上次记录一致且最后变动超过 50ms
      window.matchMedia = vi.fn().mockImplementation((query: string) => ({
        matches: query === "(max-width: 639px)",
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }));

      await reenterSelectionWithScroll(0);
      fakeNow += 100;

      rafSpy.mockClear();
      windowScrollSpy.mockClear();
      scrollerScrollSpy.mockClear();

      host = layer();
      await act(async () => {
        host.dispatchEvent(pointer("pointerdown", { pointerId: 2, clientX: 30, clientY: 30 }));
      });

      expect(rafSpy).not.toHaveBeenCalled();
      expect(windowScrollSpy).not.toHaveBeenCalled();
      expect(scrollerScrollSpy).not.toHaveBeenCalled();

      await act(async () => {
        host.dispatchEvent(pointer("pointerup", { pointerId: 2, clientX: 30, clientY: 30 }));
      });
    });

    test("scrolling -> rAF scheduled", async () => {
      setupEnteringScrollEnv();
      const rafSpy = vi.spyOn(window, "requestAnimationFrame");
      const windowScrollSpy = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
      const scrollerScrollSpy = vi.fn();
      scroller.scrollTo = scrollerScrollSpy;

      await render();
      await reenterSelectionWithScroll(20);
      rafSpy.mockClear();
      windowScrollSpy.mockClear();
      scrollerScrollSpy.mockClear();

      const host = layer();
      await act(async () => {
        host.dispatchEvent(pointer("pointerdown", { pointerId: 1, clientX: 20, clientY: 20 }));
      });

      // 停住进行中的滚动并安排落定 rAF
      expect(rafSpy).toHaveBeenCalled();
      expect(windowScrollSpy).toHaveBeenCalled();

      // 清理指针
      await act(async () => {
        host.dispatchEvent(pointer("pointerup", { pointerId: 1, clientX: 20, clientY: 20 }));
      });
    });

    test("enteringSmoothScrollRef/tracker still active but scroll position static for >50ms -> pointerdown takes idle path: no window.scrollTo / element scrollTo and no settle rAF", async () => {
      setupEnteringScrollEnv();
      const rafSpy = vi.spyOn(window, "requestAnimationFrame");
      const windowScrollSpy = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
      const scrollerScrollSpy = vi.fn();
      scroller.scrollTo = scrollerScrollSpy;

      await render();
      // 触发进入平滑滚动，并将滚动位置初始化 (scrollY = 20)
      await reenterSelectionWithScroll(20);

      // tracker 仍处于激活状态（enteringSmoothScrollRef === true，800ms timer 未触发）
      // 推进 performance.now 超过 100ms 且超过 50ms（此处增加 110ms），但滚动位置保持不变
      fakeNow += 110;

      rafSpy.mockClear();
      windowScrollSpy.mockClear();
      scrollerScrollSpy.mockClear();

      const host = layer();
      await act(async () => {
        host.dispatchEvent(pointer("pointerdown", { pointerId: 1, clientX: 30, clientY: 30 }));
      });

      // 应当走空闲路径：不调用 window.scrollTo / element scrollTo，不调度落定 rAF
      expect(windowScrollSpy).not.toHaveBeenCalled();
      expect(scrollerScrollSpy).not.toHaveBeenCalled();
      expect(rafSpy).not.toHaveBeenCalled();

      await act(async () => {
        host.dispatchEvent(pointer("pointerup", { pointerId: 1, clientX: 30, clientY: 30 }));
      });
    });

    test("onScroll during entering scroll does not read scrollHeight on ancestors", async () => {
      setupEnteringScrollEnv();
      await render();
      await reenterSelectionWithScroll(20);

      // 进入平滑滚动进行中，可滚动祖先已缓存。
      // 在祖先元素上设置 getter 间谍，统计 scrollHeight 读取次数
      let scrollHeightReadCount = 0;
      Object.defineProperty(scroller, "scrollHeight", {
        get() {
          scrollHeightReadCount++;
          return 2000;
        },
        configurable: true,
      });

      try {
        // 在进入平滑滚动期间触发 scroll 事件
        currentScrollY = 25;
        window.dispatchEvent(new Event("scroll"));
        scroller.dispatchEvent(new Event("scroll"));

        // onScroll 期间仅读取 window.scrollY 和已缓存祖先的 scrollTop，不应读取 scrollHeight
        expect(scrollHeightReadCount).toBe(0);
      } finally {
        delete (scroller as unknown as Record<string, unknown>).scrollHeight;
      }
    });

    test("getScrollableAncestors returns scrollable ancestors and skips body/documentElement", () => {
      const ancestors = getScrollableAncestors(stage);
      expect(ancestors).toEqual([scroller]);
    });

    test("isEnteringScrollInFlight live decisions", () => {
      const now = 1000;
      const pos = { windowY: 100, ancestorTops: [50] };

      // 追踪器未激活 -> false
      expect(isEnteringScrollInFlight(false, pos, pos, now, now)).toBe(false);

      // 追踪器激活，位置未变，且上次变化在 50ms 前 -> false（stale-true flag）
      expect(isEnteringScrollInFlight(true, pos, pos, now - 100, now)).toBe(false);

      // 追踪器激活，window.scrollY 变动 -> true
      expect(isEnteringScrollInFlight(true, pos, { windowY: 105, ancestorTops: [50] }, now - 50, now)).toBe(true);

      // 追踪器激活，祖先 scrollTop 变动 -> true
      expect(isEnteringScrollInFlight(true, pos, { windowY: 100, ancestorTops: [55] }, now - 50, now)).toBe(true);

      // 追踪器激活，位置相同但最后一次变化在 20ms 内 -> true
      expect(isEnteringScrollInFlight(true, pos, pos, now - 10, now)).toBe(true);

      // 新分支：trackerActive && startTime > 0 && now - startTime < 100 -> true
      expect(isEnteringScrollInFlight(true, pos, pos, now - 200, now, now - 50)).toBe(true);
      expect(isEnteringScrollInFlight(true, pos, pos, now - 200, now, now - 99)).toBe(true);
      // startTime 过期（>= 100ms），且位置未变、上次变化 > 50ms -> false
      expect(isEnteringScrollInFlight(true, pos, pos, now - 200, now, now - 100)).toBe(false);
      // trackerActive 为 false，即使 startTime 处于 100ms 内也为 false
      expect(isEnteringScrollInFlight(false, pos, pos, now - 200, now, now - 50)).toBe(false);
      // startTime 为 0 或未传，不触发新分支
      expect(isEnteringScrollInFlight(true, pos, pos, now - 200, now, 0)).toBe(false);
      expect(isEnteringScrollInFlight(true, pos, pos, now - 200, now)).toBe(false);
    });

    test("stale scrollend arriving before position change is ignored and tracker keeps listening", async () => {
      setupEnteringScrollEnv();
      const rafSpy = vi.spyOn(window, "requestAnimationFrame");
      const windowScrollSpy = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
      const scrollerScrollSpy = vi.fn();
      scroller.scrollTo = scrollerScrollSpy;

      await render();
      // 触发进入平滑滚动，此时未发生位置变化，enteringScrollTimestampRef === enteringScrollStartTimeRef
      ensureCodeElement();
      await act(async () => {
        usePlayerStore.setState({ askPhase: "idle" });
      });
      await act(async () => {
        usePlayerStore.setState({ askPhase: "selecting" });
      });
      await act(async () => {
        flushPendingRafs();
      });

      // 派发先于位置变化的 stale scrollend
      await act(async () => {
        window.dispatchEvent(new Event("scrollend"));
      });

      // tracker 未被清理：在 100ms 内 pointerdown 仍会判定为滚动中，调用 scrollTo 并安排落定 rAF
      rafSpy.mockClear();
      windowScrollSpy.mockClear();
      const host = layer();
      await act(async () => {
        host.dispatchEvent(pointer("pointerdown", { pointerId: 1, clientX: 20, clientY: 20 }));
      });
      expect(rafSpy).toHaveBeenCalled();
      expect(windowScrollSpy).toHaveBeenCalled();

      await act(async () => {
        host.dispatchEvent(pointer("pointerup", { pointerId: 1, clientX: 20, clientY: 20 }));
      });
    });

    test("scrollend after position change clears tracker and subsequent pointerdown takes idle path", async () => {
      setupEnteringScrollEnv();
      const rafSpy = vi.spyOn(window, "requestAnimationFrame");
      const windowScrollSpy = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
      const scrollerScrollSpy = vi.fn();
      scroller.scrollTo = scrollerScrollSpy;

      await render();
      // 触发进入平滑滚动并改变滚动位置
      await reenterSelectionWithScroll(20);

      // 观察到位置变动后（timestamp 已由 onScroll 更新，> startTime），此时 scrollend 应正常清理 tracker
      await act(async () => {
        window.dispatchEvent(new Event("scrollend"));
      });

      // tracker 被清理后，推进时间超过 100ms，pointerdown 走空闲路径
      fakeNow += 120;
      rafSpy.mockClear();
      windowScrollSpy.mockClear();
      scrollerScrollSpy.mockClear();

      const host = layer();
      await act(async () => {
        host.dispatchEvent(pointer("pointerdown", { pointerId: 1, clientX: 30, clientY: 30 }));
      });
      expect(rafSpy).not.toHaveBeenCalled();
      expect(windowScrollSpy).not.toHaveBeenCalled();
      expect(scrollerScrollSpy).not.toHaveBeenCalled();

      await act(async () => {
        host.dispatchEvent(pointer("pointerup", { pointerId: 1, clientX: 30, clientY: 30 }));
      });
    });

    test("tracker started by entering smooth scroll -> scrollend with static window.scrollY -> advance fake timers 900ms and performance.now >100ms -> pointerdown idle path", async () => {
      vi.useFakeTimers();
      setupEnteringScrollEnv();
      try {
        await startEnteringScroll(0);

        await act(async () => {
          window.dispatchEvent(new Event("scrollend"));
        });

        await act(async () => {
          vi.advanceTimersByTime(900);
        });

        fakeNow += 120;

        const windowScrollSpy = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
        const rafSpy = vi.spyOn(window, "requestAnimationFrame");
        windowScrollSpy.mockClear();
        rafSpy.mockClear();

        const host = layer();
        await act(async () => {
          host.dispatchEvent(pointer("pointerdown", { pointerId: 1, clientX: 20, clientY: 20 }));
        });

        expect(windowScrollSpy).not.toHaveBeenCalled();
        expect(rafSpy).not.toHaveBeenCalled();

        await act(async () => {
          host.dispatchEvent(pointer("pointerup", { pointerId: 1, clientX: 20, clientY: 20 }));
        });
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("Task F2 panel Tab navigation helper", () => {
    let mockDom: HTMLDivElement;

    beforeEach(() => {
      mockDom = document.createElement("div");
      mockDom.innerHTML = `
        <button data-ask-entry="">退出圈选</button>
        <button id="after-entry">下一步骤</button>
        <div data-ask-panel="">
          <div role="group" aria-label="点选捷径">
            <button data-ask-shortcut="subtitle" tabindex="0">字幕</button>
            <button data-ask-shortcut="step" tabindex="-1">步骤</button>
          </div>
          <button data-ask-chip="思路是什么？">思路是什么？</button>
          <textarea data-ask-question=""></textarea>
          <button data-ask-cancel="">取消</button>
          <button data-ask-submit="" aria-disabled="true">提问</button>
        </div>
        <button id="after-panel">底部重播</button>
      `;
      document.body.append(mockDom);
    });

    afterEach(() => {
      mockDom.remove();
    });

    test("isElementTabbable filters disabled and negative tabindex elements", () => {
      const btn = document.createElement("button");
      btn.textContent = "btn";
      expect(isElementTabbable(btn)).toBe(true);
      btn.disabled = true;
      expect(isElementTabbable(btn)).toBe(false);
      btn.disabled = false;
      btn.tabIndex = -1;
      expect(isElementTabbable(btn)).toBe(false);
    });

    test("getTabbableElements finds tabbable elements inside panel in DOM order", () => {
      const panel = mockDom.querySelector<HTMLElement>("[data-ask-panel]")!;
      const tabbables = getTabbableElements(panel);
      expect(tabbables.map((el) => {
        if (el.hasAttribute("data-ask-shortcut")) return el.getAttribute("data-ask-shortcut");
        if (el.hasAttribute("data-ask-chip")) return el.getAttribute("data-ask-chip");
        if (el.hasAttribute("data-ask-cancel")) return "cancel";
        if (el.hasAttribute("data-ask-submit")) return "submit";
        return el.tagName.toLowerCase();
      })).toEqual([
        "subtitle",
        "思路是什么？",
        "textarea",
        "cancel",
        "submit",
      ]);
      expect(tabbables[0].getAttribute("data-ask-shortcut")).toBe("subtitle");
      expect(tabbables[tabbables.length - 1].hasAttribute("data-ask-submit")).toBe(true);
    });

    test("getNextTabbableAfterEntry finds #after-entry and skips panel elements", () => {
      const entry = getDesktopAskEntry()!;
      expect(entry).not.toBeNull();
      const next = getNextTabbableAfterEntry(entry);
      expect(next?.id).toBe("after-entry");
    });

    test("Tab on desktop entry focuses first tabbable element in panel", () => {
      const entry = getDesktopAskEntry()!;
      entry.focus();
      const moved = handlePanelTabNavigation({
        key: "Tab",
        shiftKey: false,
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        target: entry,
      });
      expect(moved).toBe(true);
      const subtitleChip = mockDom.querySelector<HTMLElement>('[data-ask-shortcut="subtitle"]')!;
      expect(document.activeElement).toBe(subtitleChip);
    });

    test("Shift+Tab on first panel tabbable focuses entry", () => {
      const entry = getDesktopAskEntry()!;
      const subtitleChip = mockDom.querySelector<HTMLElement>('[data-ask-shortcut="subtitle"]')!;
      subtitleChip.focus();
      const moved = handlePanelTabNavigation({
        key: "Tab",
        shiftKey: true,
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        target: subtitleChip,
      });
      expect(moved).toBe(true);
      expect(document.activeElement).toBe(entry);
    });

    test("Tab on last panel tabbable focuses next tabbable after entry", () => {
      const submitBtn = mockDom.querySelector<HTMLElement>("[data-ask-submit]")!;
      const afterEntry = mockDom.querySelector<HTMLElement>("#after-entry")!;
      submitBtn.focus();
      const moved = handlePanelTabNavigation({
        key: "Tab",
        shiftKey: false,
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        target: submitBtn,
      });
      expect(moved).toBe(true);
      expect(document.activeElement).toBe(afterEntry);
    });

    test("Shift+Tab on next tabbable after entry focuses last panel tabbable", () => {
      const submitBtn = mockDom.querySelector<HTMLElement>("[data-ask-submit]")!;
      const afterEntry = mockDom.querySelector<HTMLElement>("#after-entry")!;
      afterEntry.focus();
      const moved = handlePanelTabNavigation({
        key: "Tab",
        shiftKey: true,
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        target: afterEntry,
      });
      expect(moved).toBe(true);
      expect(document.activeElement).toBe(submitBtn);
    });

    test("modifiers or other keys do not move focus", () => {
      const entry = getDesktopAskEntry()!;
      entry.focus();
      expect(handlePanelTabNavigation({ key: "Tab", shiftKey: false, altKey: true, ctrlKey: false, metaKey: false, target: entry })).toBe(false);
      expect(handlePanelTabNavigation({ key: "Tab", shiftKey: false, altKey: false, ctrlKey: true, metaKey: false, target: entry })).toBe(false);
      expect(handlePanelTabNavigation({ key: "Tab", shiftKey: false, altKey: false, ctrlKey: false, metaKey: true, target: entry })).toBe(false);
      expect(handlePanelTabNavigation({ key: "Enter", shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, target: entry })).toBe(false);
    });

    test("panel open at desktop width, then matchMedia switches to mobile (resize) while open -> Tab is NOT intercepted; and switching back to desktop -> Tab is intercepted again", async () => {
      let isMobile = false;
      const originalMatchMedia = window.matchMedia;
      window.matchMedia = vi.fn().mockImplementation((query: string) => ({
        matches: query === "(max-width: 639px)" ? isMobile : false,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }));

      try {
        usePlayerStore.setState({ askPhase: "drafting" });
        await render();

        const entry = getDesktopAskEntry()!;
        const firstPanelTabbable = mockDom.querySelector<HTMLElement>('[data-ask-shortcut="subtitle"]')!;

        // 1. Desktop width: Tab from entry is intercepted and moves focus to panel
        entry.focus();
        const desktopEvent1 = new KeyboardEvent("keydown", {
          key: "Tab",
          bubbles: true,
          cancelable: true,
        });
        entry.dispatchEvent(desktopEvent1);
        expect(desktopEvent1.defaultPrevented).toBe(true);
        expect(document.activeElement).toBe(firstPanelTabbable);

        // 2. Resize to mobile width while panel is open: Tab is NOT intercepted
        isMobile = true;
        entry.focus();
        const mobileEvent = new KeyboardEvent("keydown", {
          key: "Tab",
          bubbles: true,
          cancelable: true,
        });
        entry.dispatchEvent(mobileEvent);
        expect(mobileEvent.defaultPrevented).toBe(false);
        expect(document.activeElement).toBe(entry);

        // 3. Switch back to desktop width: Tab is intercepted again
        isMobile = false;
        entry.focus();
        const desktopEvent2 = new KeyboardEvent("keydown", {
          key: "Tab",
          bubbles: true,
          cancelable: true,
        });
        entry.dispatchEvent(desktopEvent2);
        expect(desktopEvent2.defaultPrevented).toBe(true);
        expect(document.activeElement).toBe(firstPanelTabbable);
      } finally {
        window.matchMedia = originalMatchMedia;
      }
    });
  });
});
