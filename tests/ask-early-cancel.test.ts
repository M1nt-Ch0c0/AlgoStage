// @vitest-environment happy-dom
/**
 * The document-level 取消 listener only records pointerdown.timeStamp. The
 * button's own pointerdown / capture / data-pressed / pointerup / slide-off
 * path still drives the hold. A press whose timeStamp is inside the settle
 * window, delivered after the hold wait resolved, aborts on release.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import AskPanel from "../components/board/ask-panel";
import { retroCancelAsk, sendAsk } from "../lib/ask/ask-client";
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
    captureStage: vi.fn(async () => ({
      ok: true as const,
      encoder: "main" as const,
      image: { mime: "image/jpeg" as const, dataBase64: "qq==" },
      bytes: 1,
    })),
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
/** Resolves a captureStage that a test left hanging, so unmount can finish the submit. */
let releaseHungCapture: (() => void) | undefined;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  usePlayerStore.getState().reset();
  usePlayerStore.getState().loadScript(script);
  vi.mocked(sendAsk).mockReset();
  vi.mocked(retroCancelAsk).mockReset();
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
  releaseHungCapture?.();
  releaseHungCapture = undefined;
  vi.useRealTimers();
  await act(async () => root.unmount());
  usePlayerStore.getState().reset();
  resetLongTaskEndForTests();
  container.remove();
  stage.remove();
  vi.unstubAllGlobals();
});

async function finishCaptureTurn() {
  await Promise.resolve();
  for (let frame = 0; frame < 2; frame += 1) {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
  }
  await Promise.resolve();
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 60);
  });
}

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

function pointer(
  type: string,
  timeStamp: number,
  clientX: number,
  clientY: number,
  pointerId = 7,
): PointerEvent {
  const event = new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    pointerId,
    clientX,
    clientY,
    isPrimary: true,
  });
  Object.defineProperty(event, "timeStamp", { value: timeStamp });
  return event;
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

describe("early 取消 press", () => {
  test("the early listener does not change defaultPrevented or stop the event, and the button handler still sets data-pressed", async () => {
    const { cancel, submit } = await renderPanel();

    vi.mocked(captureStage).mockImplementation(
      () =>
        new Promise((resolve) => {
          // Stay inside capture so the early listener is still attached
          // when the press arrives, the same window as a stall.
          releaseHungCapture = () => {
            resolve({
              ok: true,
              encoder: "main",
              image: { mime: "image/jpeg", dataBase64: "qq==" },
              bytes: 1,
            });
          };
        }),
    );

    let sawButton = false;
    const onButton = (event: Event) => {
      sawButton = true;
      expect(event.defaultPrevented).toBe(false);
      expect((event as PointerEvent).cancelBubble).toBe(false);
    };
    cancel.addEventListener("pointerdown", onButton);

    await act(async () => {
      submit.click();
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
    });
    await vi.waitFor(() => {
      expect(container.querySelector("[data-ask-capture-preparing]")).not.toBeNull();
    });

    const down = pointer("pointerdown", performance.now(), 12, 10);
    const stopPropagation = vi.spyOn(down, "stopPropagation");
    const preventDefault = vi.spyOn(down, "preventDefault");
    await act(async () => {
      cancel.dispatchEvent(down);
    });

    expect(sawButton).toBe(true);
    expect(down.defaultPrevented).toBe(false);
    expect(stopPropagation).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
    expect(cancel.hasAttribute("data-pressed")).toBe(true);
    expect(cancel.className).toContain("bg-board-700");

    cancel.removeEventListener("pointerdown", onButton);
    await act(async () => {
      cancel.dispatchEvent(pointer("pointerup", performance.now(), 14, 12));
    });
    const finish = releaseHungCapture;
    releaseHungCapture = undefined;
    await act(async () => {
      finish?.();
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 60);
      });
    });
  });

  test("a press with timeStamp inside the settle window, dispatched after the hold wait resolved, aborts and leaves no answer", async () => {
    const { cancel, submit } = await renderPanel();

    let sentAt = 0;
    let releaseSend: (() => void) | undefined;
    vi.mocked(sendAsk).mockImplementation(async (_capture, options) => {
      sentAt = performance.now();
      options?.onFetch?.(sentAt);
      await new Promise<void>((resolve) => {
        releaseSend = resolve;
      });
    });

    await act(async () => {
      submit.click();
      await finishCaptureTurn();
    });
    await vi.waitFor(() => {
      expect(sendAsk).toHaveBeenCalledTimes(1);
    });

    const down = pointer("pointerdown", sentAt - 30, 12, 10);
    const up = pointer("pointerup", sentAt + 20, 14, 12);
    await act(async () => {
      cancel.dispatchEvent(down);
      cancel.dispatchEvent(up);
    });

    expect(cancel.hasAttribute("data-pressed")).toBe(false);
    expect(retroCancelAsk).toHaveBeenCalledTimes(1);
    expect(usePlayerStore.getState().askPhase).not.toBe("playing");
    expect(usePlayerStore.getState().answers).toEqual({});
    expect(container.textContent ?? "").not.toContain("播放回答");
    releaseSend?.();
    await act(async () => {
      await Promise.resolve();
    });
    expect(retroCancelAsk).toHaveBeenCalledTimes(1);
    expect(sendAsk).toHaveBeenCalledTimes(1);
  });

  test("a slide off the button still sends", async () => {
    const { cancel, submit } = await renderPanel();

    vi.mocked(captureStage).mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseHungCapture = () => {
            resolve({
              ok: true,
              encoder: "main",
              image: { mime: "image/jpeg", dataBase64: "qq==" },
              bytes: 1,
            });
          };
        }),
    );

    await act(async () => {
      submit.click();
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
    });
    await vi.waitFor(() => {
      expect(container.querySelector("[data-ask-capture-preparing]")).not.toBeNull();
    });

    await act(async () => {
      cancel.dispatchEvent(pointer("pointerdown", performance.now(), 12, 10));
    });
    expect(cancel.hasAttribute("data-pressed")).toBe(true);

    await act(async () => {
      cancel.dispatchEvent(pointer("pointermove", performance.now(), 12, 400));
      cancel.dispatchEvent(pointer("pointerup", performance.now(), 12, 400));
    });
    expect(cancel.hasAttribute("data-pressed")).toBe(false);

    const finish = releaseHungCapture;
    releaseHungCapture = undefined;
    finish?.();
    await vi.waitFor(() => {
      expect(sendAsk).toHaveBeenCalledTimes(1);
    });

    expect(retroCancelAsk).not.toHaveBeenCalled();
    expect(sendAsk).toHaveBeenCalledTimes(1);
  });

  test("a hold longer than 2s then a release on the button aborts", async () => {
    vi.useFakeTimers();
    const { cancel, submit } = await renderPanel();

    let releaseSend: (() => void) | undefined;
    vi.mocked(sendAsk).mockImplementation(async (_capture, options) => {
      options?.onFetch?.(performance.now());
      await new Promise<void>((resolve) => {
        releaseSend = resolve;
      });
    });

    await act(async () => {
      submit.click();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(container.querySelector("[data-ask-capture-preparing]")).not.toBeNull();

    await act(async () => {
      cancel.dispatchEvent(pointer("pointerdown", 10, 12, 10));
    });
    expect(cancel.hasAttribute("data-pressed")).toBe(true);
    expect(sendAsk).not.toHaveBeenCalled();

    // The hold timer starts after the post-capture settle. Advance both.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60);
      await vi.advanceTimersByTimeAsync(2100);
    });
    expect(sendAsk).toHaveBeenCalledTimes(1);
    expect(cancel.hasAttribute("data-pressed")).toBe(true);
    expect(retroCancelAsk).not.toHaveBeenCalled();

    await act(async () => {
      cancel.dispatchEvent(pointer("pointerup", 2200, 14, 12));
    });
    expect(retroCancelAsk).toHaveBeenCalledTimes(1);
    expect(cancel.hasAttribute("data-pressed")).toBe(false);
    expect(container.textContent ?? "").not.toContain("播放回答");

    releaseSend?.();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    vi.useRealTimers();
  });
});
