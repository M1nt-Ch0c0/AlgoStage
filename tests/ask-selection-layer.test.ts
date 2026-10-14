// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { scrollHeight, clientHeight, scrollWidth, clientWidth } from "happy-dom/lib/PropertySymbol.js";
import AskSelectionLayer, { resolveAskEscape } from "../components/board/ask-selection-layer";
import { ASK_EMPTY_HIT, ASK_ENTERED_STATUS, ASK_RESIZE_HINT } from "../lib/ask/ask-ui-text";
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

  test("进入圈选把 ASK_ENTERED_STATUS 写入已有 role=status", async () => {
    const status = document.createElement("p");
    status.setAttribute("role", "status");
    status.textContent = "旧播报";
    document.body.append(status);
    await render();
    expect(status.textContent).toBe(ASK_ENTERED_STATUS);
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

  function pressEscape(target: EventTarget) {
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
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
    expect(document.activeElement).toBe(layer());

    const exit = await act(async () => pressEscape(layer()));
    expect(exit.defaultPrevented).toBe(true);
    expect(usePlayerStore.getState().askPhase).toBe("idle");
  });

  test("窗口级 Esc：面板外的 Monaco 忽略，面板内 textarea 关面板", async () => {
    await render();
    const monaco = document.createElement("textarea");
    monaco.className = "inputarea";
    const editor = document.createElement("div");
    editor.className = "monaco-editor";
    editor.append(monaco);
    document.body.append(editor);
    monaco.focus();

    const ignored = await act(async () => pressEscape(monaco));
    expect(ignored.defaultPrevented).toBe(false);
    expect(usePlayerStore.getState().askPhase).toBe("selecting");

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
    expect(document.activeElement).toBe(layer());

    editor.remove();
    panel.remove();
  });

  test("sending 时窗口级 Esc 只关面板，层重新出现且 phase 停在 selecting", async () => {
    usePlayerStore.setState({
      askPhase: "sending",
      askContext: {
        stepId: "s1",
        stepIndex: 0,
        prevStatus: "paused",
        prevAwaitingContinue: false,
        answerId: null,
        segmentIndex: -1,
        token: 4,
      },
    });
    await render();
    expect(container.querySelector("[data-ask-layer]")).toBeNull();
    const esc = await act(async () => pressEscape(document.body));
    expect(esc.defaultPrevented).toBe(true);
    expect(usePlayerStore.getState().askPhase).toBe("selecting");
    expect(usePlayerStore.getState().askContext?.token).toBeNull();
    expect(container.querySelector("[data-ask-layer]")).not.toBeNull();
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
    expect(resolveAskEscape("sending", question, plain)).toBe("close-panel");
    expect(resolveAskEscape("streaming", body, plain)).toBe("close-panel");
    expect(resolveAskEscape("playing", body, plain)).toBe("ignore");
    expect(resolveAskEscape("idle", body, plain)).toBe("ignore");
    expect(resolveAskEscape("selecting", cell, plain)).toBe("ignore");
    expect(resolveAskEscape("drafting", cell, plain)).toBe("ignore");
    expect(resolveAskEscape("drafting", question, plain)).toBe("close-panel");
    expect(resolveAskEscape("sending", question, plain)).toBe("close-panel");
  });

  test("组合键、输入法、已处理的事件忽略", () => {
    const body = document.createElement("div");
    expect(resolveAskEscape("selecting", body, { ...plain, ctrlKey: true })).toBe("ignore");
    expect(resolveAskEscape("drafting", body, { ...plain, metaKey: true })).toBe("ignore");
    expect(resolveAskEscape("selecting", body, { ...plain, altKey: true })).toBe("ignore");
    expect(resolveAskEscape("selecting", body, { ...plain, composing: true })).toBe("ignore");
    expect(resolveAskEscape("drafting", body, { ...plain, defaultPrevented: true })).toBe("ignore");
  });
});
