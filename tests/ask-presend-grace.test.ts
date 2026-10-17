// @vitest-environment happy-dom
/**
 * Uma A/C: capture can finish before a CDP cancel is dequeued, so hold.wait()
 * with no pending press resolves "send". One pre-send settle must drain that
 * pointerdown before fetch. A cancel that lands in the settle leaves asks=0.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import AskPanel from "../components/board/ask-panel";
import { sendAsk } from "../lib/ask/ask-client";
import { resetLongTaskEndForTests } from "../lib/ask/ask-timing";
import { captureStage } from "../lib/ask/capture";
import type { AskSelectionSummary } from "../lib/ask/types";
import { usePlayerStore } from "../lib/player/store";
import type { TeachingScript } from "../lib/teaching/types";

vi.mock("../lib/ask/ask-client", () => ({
  sendAsk: vi.fn(async () => {}),
  cancelAsk: vi.fn(),
  retroCancelAsk: vi.fn(),
}));

vi.mock("../lib/ask/capture", async () => {
  const actual = await vi.importActual<typeof import("../lib/ask/capture")>("../lib/ask/capture");
  return {
    ...actual,
    captureStage: vi.fn(async (_container, _selection, opts?: { beforeEncode?: () => Promise<void> }) => {
      await opts?.beforeEncode?.();
      return {
        ok: true as const,
        encoder: "main" as const,
        image: { mime: "image/jpeg" as const, dataBase64: "qq==" },
        bytes: 1,
      };
    }),
  };
});

const script: TeachingScript = {
  problemSlug: "3sum",
  mode: "lecture",
  language: "zh",
  solutionLanguage: "typescript",
  steps: [{ id: "s1", narration: "第一步讲解。", targets: [], effects: [] }],
};

const selection: AskSelectionSummary = {
  mode: "single",
  bbox: { x: 10, y: 20, width: 80, height: 40 },
  targets: [{ kind: "step", id: "step:s1", stepId: "s1", text: "步骤内容" }],
};

let root: Root;
let container: HTMLDivElement;
let stage: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  usePlayerStore.getState().reset();
  usePlayerStore.getState().loadScript(script);
  vi.mocked(sendAsk).mockReset();
  vi.mocked(captureStage).mockReset();
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;

  stage = document.createElement("div");
  stage.setAttribute("data-ask-stage", "");
  document.body.append(stage);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);

  usePlayerStore.setState({
    askPhase: "drafting",
    selection,
    draftQuestion: "为什么这样写？",
    draftStepId: "s1",
    status: "interrupted",
  });
});

afterEach(async () => {
  vi.useRealTimers();
  await act(async () => root.unmount());
  usePlayerStore.getState().reset();
  resetLongTaskEndForTests();
  container.remove();
  stage.remove();
  vi.unstubAllGlobals();
});

const BUTTON_BOX = {
  x: 0,
  y: 0,
  left: 0,
  top: 0,
  right: 80,
  bottom: 40,
  width: 80,
  height: 40,
  toJSON() {
    return {};
  },
};

function pointer(type: string, clientX: number, clientY: number, pointerId = 7): PointerEvent {
  return new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    pointerId,
    clientX,
    clientY,
    isPrimary: true,
  });
}

async function renderPanel(): Promise<{
  cancel: HTMLButtonElement;
  submit: HTMLButtonElement;
}> {
  await act(async () => {
    root.render(createElement(AskPanel, { stage }));
  });
  const cancel = container.querySelector<HTMLButtonElement>("[data-ask-cancel]");
  const submit = container.querySelector<HTMLButtonElement>("[data-ask-submit]");
  if (!cancel || !submit) throw new Error("panel controls missing");
  vi.spyOn(cancel, "getBoundingClientRect").mockReturnValue(BUTTON_BOX);
  return { cancel, submit };
}

describe("pre-send grace", () => {
  test("a cancel that lands during the pre-send settle does not fetch", async () => {
    const { cancel, submit } = await renderPanel();
    const realSetTimeout = setTimeout;
    const realClearTimeout = clearTimeout;
    type Held = { delay: number; run: () => void };
    const held: Held[] = [];
    let captureYields = 0;
    vi.stubGlobal(
      "setTimeout",
      ((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
        const source = typeof callback === "function" ? callback.toString() : "";
        if (source.includes("askInputMacrotask") && typeof callback === "function") {
          const entry: Held = { delay: delay ?? 0, run: () => callback(...args) };
          held.push(entry);
          // The before-encode yield is the first askInputMacrotask pair
          // (macrotask, then the 120ms settle). Run those so capture can
          // finish with no press: hold.wait() then resolves "send" at once.
          // Later askInputMacrotask timers are the pre-send grace. Hold them
          // so the cancel can land before that settle returns.
          if (captureYields < 2) {
            captureYields += 1;
            queueMicrotask(() => {
              const index = held.indexOf(entry);
              if (index >= 0) held.splice(index, 1);
              entry.run();
            });
          }
          return held.length + 1;
        }
        return realSetTimeout(callback as never, delay, ...args);
      }) as typeof setTimeout,
    );
    vi.stubGlobal(
      "clearTimeout",
      ((handle: unknown) => {
        if (typeof handle === "number" && handle > 0 && handle <= held.length + 1) return;
        realClearTimeout(handle as ReturnType<typeof setTimeout>);
      }) as typeof clearTimeout,
    );

    await act(async () => {
      submit.click();
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });
      await new Promise<void>((resolve) => {
        realSetTimeout(resolve, 0);
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    // Capture finished. The only timers still held are the pre-send grace.
    expect(captureYields).toBe(2);
    expect(sendAsk).not.toHaveBeenCalled();
    const pending = held.filter((entry) => entry.delay === 0);
    expect(pending.length).toBeGreaterThan(0);

    await act(async () => {
      cancel.dispatchEvent(pointer("pointerdown", 12, 10));
      cancel.dispatchEvent(pointer("pointerup", 14, 12));
    });

    await act(async () => {
      for (const entry of held.splice(0)) entry.run();
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      await new Promise<void>((resolve) => {
        realSetTimeout(resolve, 0);
      });
    });

    expect(sendAsk).not.toHaveBeenCalled();
    expect(usePlayerStore.getState().askPhase).toBe("selecting");
    expect(container.querySelector("[data-ask-panel]")).toBeNull();
    expect(container.querySelector("[data-ask-waiting]")).toBeNull();

    vi.stubGlobal("setTimeout", realSetTimeout);
    vi.stubGlobal("clearTimeout", realClearTimeout);
  });
});
