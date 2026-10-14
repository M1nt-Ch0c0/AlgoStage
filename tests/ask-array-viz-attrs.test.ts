// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import ArrayVisualizer from "../components/viz/array-visualizer";
import { usePlayerStore } from "../lib/player/store";
import type { TeachingScript, VizFrame } from "../lib/teaching/types";

const frame: VizFrame = {
  type: "array",
  state: { values: [2, 7, 11], highlight: [1], map: {}, scan: -1 },
};

const script: TeachingScript = {
  problemSlug: "3sum",
  mode: "lecture",
  language: "zh",
  solutionLanguage: "typescript",
  steps: [
    { id: "step-a", narration: "第一步。", targets: [], effects: [], viz: frame },
    { id: "step-b", narration: "第二步。", targets: [], effects: [], viz: frame },
  ],
};

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // Motion 的 WAAPI cancel 会让 happy-dom 的 finished Promise reject。
  vi.spyOn(Element.prototype, "animate").mockImplementation(
    () =>
      ({
        finished: new Promise(() => {}),
        ready: Promise.resolve(),
        playState: "finished",
        cancel() {},
        finish() {},
        play() {},
        pause() {},
        persist() {},
        addEventListener() {},
        removeEventListener() {},
      }) as unknown as Animation,
  );
  usePlayerStore.getState().reset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  usePlayerStore.getState().reset();
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function render(props: { frame?: VizFrame; stepId?: string } = { frame }) {
  await act(async () => {
    root.render(createElement(ArrayVisualizer, props));
  });
}

test("cells expose data-ask-viz-index and the wrapper is the whole-array shortcut", async () => {
  usePlayerStore.getState().loadScript(script);
  await render();

  const cells = [...container.querySelectorAll<SVGGElement>("[data-ask-viz-index]")];
  expect(cells.map((el) => el.getAttribute("data-ask-viz-index"))).toEqual(["0", "1", "2"]);
  for (const [i, el] of cells.entries()) {
    expect(el.getAttribute("data-ask-target")).toBe("viz");
    expect(el.getAttribute("data-ask-id")).toBe(`viz:step-a:${i}`);
    expect(el.getAttribute("data-ask-step-id")).toBe("step-a");
    expect(el.getAttribute("data-viz-node")).toBe(`a${i}`);
  }

  const whole = container.querySelector<HTMLElement>('[data-ask-id="viz:step-a"]');
  expect(whole?.getAttribute("data-ask-target")).toBe("viz");
  expect(whole?.getAttribute("data-ask-step-id")).toBe("step-a");
  expect(whole?.hasAttribute("data-ask-viz-index")).toBe(false);
});

test("stepId prop overrides the store step, and goto updates ids from the store", async () => {
  usePlayerStore.getState().loadScript(script);
  await render({ frame, stepId: "override" });
  expect(container.querySelector('[data-ask-id="viz:override"]')).not.toBeNull();
  expect(container.querySelector('[data-ask-viz-index="1"]')?.getAttribute("data-ask-id")).toBe("viz:override:1");

  usePlayerStore.getState().goto(1);
  await render({ frame });
  expect(container.querySelector('[data-ask-id="viz:step-b"]')).not.toBeNull();
  expect(container.querySelector('[data-ask-viz-index="0"]')?.getAttribute("data-ask-step-id")).toBe("step-b");
});

test("an invalid frame still renders nothing", async () => {
  await render({ frame: { type: "array", state: { values: "bad" } } as unknown as VizFrame });
  expect(container.querySelector("[data-ask-target]")).toBeNull();
  expect(container.innerHTML).toBe("");
});
