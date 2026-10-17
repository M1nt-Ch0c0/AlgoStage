// @vitest-environment happy-dom
import { afterEach, describe, expect, test } from "vitest";
import {
  resolveAskCancelFocusTarget,
  setAskOpenSource,
} from "../lib/ask/ask-open-source";
import type { AskSelectionSummary } from "../lib/ask/types";

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
