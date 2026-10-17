// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import AskPanel from "../components/board/ask-panel";
import AskSelectionLayer from "../components/board/ask-selection-layer";
import { retroCancelAsk } from "../lib/ask/ask-client";
import { invalidateAskMeasureCache, sharedAskMeasureCache } from "../lib/ask/ask-occlusion";
import {
  resolveAskCancelFocusTarget,
  setAskOpenSource,
} from "../lib/ask/ask-open-source";
import type { AskSelectionSummary } from "../lib/ask/types";
import { usePlayerStore } from "../lib/player/store";
import type { TeachingScript } from "../lib/teaching/types";

vi.mock("../lib/ask/ask-client", () => ({
  sendAsk: vi.fn(async () => {}),
  cancelAsk: vi.fn(),
  retroCancelAsk: vi.fn(() => {
    usePlayerStore.getState().retroCancelAsk();
  }),
}));

function selection(id: string): AskSelectionSummary {
  return {
    mode: "single",
    bbox: { x: 0, y: 0, width: 10, height: 10 },
    targets: [{ kind: "step", id, stepId: "s1", text: "step" }],
  };
}

function mount(opts: { chipKeys: string[]; currentKey?: string; askId?: string; layer?: boolean }) {
  document.body.innerHTML = "";
  const bar = document.createElement("div");
  bar.setAttribute("data-ask-bottom-bar", "");
  const chips = new Map<string, HTMLButtonElement>();
  for (const key of opts.chipKeys) {
    const chip = document.createElement("button");
    chip.setAttribute("data-ask-shortcut", key);
    chip.tabIndex = key === opts.currentKey ? 0 : -1;
    bar.append(chip);
    chips.set(key, chip);
  }
  document.body.append(bar);

  let target: HTMLElement | null = null;
  if (opts.askId) {
    target = document.createElement("div");
    target.setAttribute("data-ask-id", opts.askId);
    document.body.append(target);
  }

  let layer: HTMLElement | null = null;
  if (opts.layer) {
    layer = document.createElement("div");
    layer.setAttribute("data-ask-layer", "");
    document.body.append(layer);
  }

  return { chips, target, layer };
}

afterEach(() => {
  setAskOpenSource(null);
  document.body.innerHTML = "";
});

describe("resolveAskCancelFocusTarget", () => {
  test("chip-opened mobile returns that chip by key", () => {
    const { chips } = mount({ chipKeys: ["subtitle", "step", "viz"], currentKey: "step" });
    setAskOpenSource({ kind: "chip", key: "viz" });

    const el = resolveAskCancelFocusTarget({ isMobile: true, selection: selection("step:s1") });

    expect(el).toBe(chips.get("viz"));
  });

  test("chip-opened desktop returns that chip by key", () => {
    const { chips, target } = mount({
      chipKeys: ["subtitle", "step"],
      currentKey: "subtitle",
      askId: "step:s1",
    });
    setAskOpenSource({ kind: "chip", key: "step" });

    const el = resolveAskCancelFocusTarget({ isMobile: false, selection: selection("step:s1") });

    expect(el).toBe(chips.get("step"));
    expect(el).not.toBe(target);
  });

  test("box-opened desktop returns the data-ask-id element", () => {
    const { target } = mount({
      chipKeys: ["subtitle", "step"],
      currentKey: "subtitle",
      askId: "step:s1",
    });
    setAskOpenSource({ kind: "box" });

    const el = resolveAskCancelFocusTarget({ isMobile: false, selection: selection("step:s1") });

    expect(el).toBe(target);
    expect(target?.tabIndex).toBe(-1);
  });

  test("chip key missing falls back to data-ask-id", () => {
    const { target } = mount({
      chipKeys: ["subtitle"],
      currentKey: "subtitle",
      askId: "step:s1",
    });
    setAskOpenSource({ kind: "chip", key: "viz" });

    const el = resolveAskCancelFocusTarget({ isMobile: false, selection: selection("step:s1") });

    expect(el).toBe(target);
  });

  test("recorded chip key beats a different tabIndex===0 chip", () => {
    const { chips } = mount({
      chipKeys: ["subtitle", "step", "viz"],
      currentKey: "subtitle",
      askId: "step:s1",
      layer: true,
    });
    setAskOpenSource({ kind: "chip", key: "step" });

    const el = resolveAskCancelFocusTarget({ isMobile: true, selection: selection("step:s1") });

    expect(el).toBe(chips.get("step"));
    expect(chips.get("subtitle")?.tabIndex).toBe(0);
  });
});

const script: TeachingScript = {
  problemSlug: "3sum",
  mode: "lecture",
  language: "zh",
  solutionLanguage: "typescript",
  steps: [{ id: "s1", narration: "第一步讲解。", targets: [], effects: [] }],
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

/** Drain the exit-hold microtask. flushSync inside it may schedule another. */
async function drainExitMicrotask() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("cancel focus by open source", () => {
  let root: Root;
  let container: HTMLDivElement;
  let stage: HTMLDivElement;

  function stageTarget(): HTMLElement {
    const el = stage.querySelector<HTMLElement>('[data-ask-id="step:s1"]');
    if (!el) throw new Error("stage target missing");
    return el;
  }

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    invalidateAskMeasureCache(sharedAskMeasureCache);
    setAskOpenSource(null);
    usePlayerStore.getState().reset();
    usePlayerStore.getState().loadScript(script);
    vi.mocked(retroCancelAsk).mockClear();
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === "(max-width: 639px)",
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 844 });

    stage = document.createElement("div");
    stage.setAttribute("data-ask-stage", "");
    stage.getBoundingClientRect = () => domRect(0, 0, 390, 300);
    stage.innerHTML = `
      <p data-ask-target="subtitle" data-ask-id="subtitle:s1" data-ask-step-id="s1">字幕内容</p>
      <div data-ask-target="step" data-ask-id="step:s1" data-ask-step-id="s1">步骤内容</div>
    `;
    for (const el of stage.querySelectorAll<HTMLElement>("[data-ask-target]")) {
      el.getBoundingClientRect = () => domRect(10, 10, 60, 30);
    }
    document.body.append(stage);

    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    invalidateAskMeasureCache(sharedAskMeasureCache);
    setAskOpenSource(null);
    usePlayerStore.getState().reset();
    container.remove();
    stage.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function renderSiblings(panelFirst: boolean) {
    const panel = createElement(AskPanel, { stage });
    const layer = createElement(AskSelectionLayer, { stage });
    await act(async () => {
      root.render(
        createElement("div", null, ...(panelFirst ? [panel, layer] : [layer, panel])),
      );
    });
  }

  function chip(key: string): HTMLButtonElement {
    const el = document.querySelector<HTMLButtonElement>(`[data-ask-shortcut="${key}"]`);
    if (!el) throw new Error(`chip ${key} missing`);
    return el;
  }

  async function openViaChip(key: string) {
    await act(async () => {
      chip(key).click();
    });
    expect(usePlayerStore.getState().askPhase).toBe("drafting");
    const cancel = document.querySelector<HTMLButtonElement>("[data-ask-panel] [data-ask-cancel]");
    if (!cancel) throw new Error("cancel missing");
    cancel.focus();
    return cancel;
  }

  async function cancelDraft(cancel: HTMLButtonElement) {
    await act(async () => {
      cancel.click();
      expect(document.querySelector("[data-ask-panel]")?.getAttribute("aria-hidden")).toBe("true");
      await drainExitMicrotask();
    });
  }

  test.each([
    ["panel then layer", true],
    ["layer then panel", false],
  ] as const)("%s: chip open, cancel from drafting, focus returns to that chip", async (_label, panelFirst) => {
    usePlayerStore.setState({ askPhase: "selecting", status: "interrupted" });
    await renderSiblings(panelFirst);
    const cancel = await openViaChip("step");
    expect(document.activeElement).toBe(cancel);

    await cancelDraft(cancel);

    expect(usePlayerStore.getState().askPhase).toBe("selecting");
    expect(document.querySelector("[data-ask-panel]")).toBeNull();
    expect(document.activeElement).toBe(chip("step"));
  });

  test.each([
    ["panel then layer", true],
    ["layer then panel", false],
  ] as const)("%s: chip open, cancel from sending, focus returns to that chip", async (_label, panelFirst) => {
    usePlayerStore.setState({ askPhase: "selecting", status: "interrupted" });
    await renderSiblings(panelFirst);
    await openViaChip("subtitle");
    await act(async () => {
      usePlayerStore.setState({ askPhase: "sending" });
    });
    const cancel = document.querySelector<HTMLButtonElement>("[data-ask-panel] [data-ask-cancel]");
    if (!cancel) throw new Error("waiting cancel missing");
    cancel.focus();
    const box = { x: 0, y: 0, width: 40, height: 20, top: 0, left: 0, right: 40, bottom: 20, toJSON() { return {}; } } as DOMRect;
    vi.spyOn(cancel, "getBoundingClientRect").mockReturnValue(box);

    await act(async () => {
      cancel.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, pointerId: 1, clientX: 10, clientY: 8 }));
      cancel.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, button: 0, pointerId: 1, clientX: 12, clientY: 9 }));
      expect(document.querySelector("[data-ask-panel]")?.getAttribute("aria-hidden")).toBe("true");
      await drainExitMicrotask();
    });

    expect(usePlayerStore.getState().askPhase).toBe("selecting");
    expect(document.querySelector("[data-ask-panel]")).toBeNull();
    expect(document.activeElement).toBe(chip("subtitle"));
  });

  test("chip removed before cancel falls back to [data-ask-id]", async () => {
    // Desktop skips the mobile tabIndex chip. The recorded key is not in the
    // bar (the layer does not render a viz chip), so cancel focus lands on
    // the selection's [data-ask-id].
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;
    usePlayerStore.setState({ askPhase: "selecting", status: "interrupted" });
    await renderSiblings(true);
    const cancel = await openViaChip("step");
    setAskOpenSource({ kind: "chip", key: "viz" });
    document.querySelector('[data-ask-shortcut="viz"]')?.remove();

    await cancelDraft(cancel);

    expect(document.activeElement).toBe(stageTarget());
    expect(stageTarget().tabIndex).toBe(-1);
  });
});
