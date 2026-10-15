// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { scrollHeight, clientHeight, scrollWidth, clientWidth } from "happy-dom/lib/PropertySymbol.js";
import AskEntry from "../components/board/ask-entry";
import AskSelectionLayer from "../components/board/ask-selection-layer";
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

  test("Esc 在 selecting 调用 exitAsk", async () => {
    const exitSpy = vi.spyOn(usePlayerStore.getState(), "exitAsk");
    await render();
    const host = layer();
    const esc = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    await act(async () => {
      host.dispatchEvent(esc);
    });
    expect(esc.defaultPrevented).toBe(true);
    expect(esc.cancelBubble).toBe(true);
    expect(exitSpy).toHaveBeenCalledTimes(1);
  });

  test("Esc 在 drafting 不从层调用 exitAsk", async () => {
    const exitSpy = vi.spyOn(usePlayerStore.getState(), "exitAsk");
    usePlayerStore.setState({ askPhase: "drafting" });
    await render();
    const host = layer();
    const esc = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    await act(async () => {
      host.dispatchEvent(esc);
    });
    expect(esc.defaultPrevented).toBe(false);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(usePlayerStore.getState().askPhase).toBe("drafting");
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
});
