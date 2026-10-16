// @vitest-environment happy-dom
/**
 * The document-level 取消 listener records a cancel hit when the press
 * target is inside [data-ask-cancel]. The button's own pointerdown / capture
 * / data-pressed / pointerup / slide-off path still drives the hold. A press
 * dispatched during the capture long task is processed before fetch. A press
 * that lands after the fetch aborts on release and leaves no answer.
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
    captureStage: vi.fn(async (_container, _selection, opts?: { beforeEncode?: () => Promise<void> }) => {
      // The real capture yields here, after domToCanvas and before encode.
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

/** The pre-capture paint is one animation frame, then one macrotask. */
async function drainPaint() {
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

/**
 * Run the submit until the post-capture macrotask is pending, which is the
 * gap after domToCanvas and before encode or fetch. The pre-capture paint
 * also uses setTimeout(0); this holds only yieldMacrotask's callback.
 */
async function reachBeforeEncode(submit: HTMLButtonElement): Promise<() => void> {
  const held: Array<(...heldArgs: unknown[]) => void> = [];
  const heldArgs: unknown[][] = [];
  const realSetTimeout = setTimeout;
  const wrapped = ((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
    const source = typeof callback === "function" ? callback.toString() : "";
    if (source.includes("askInputMacrotask")) {
      held.push(callback as (...cbArgs: unknown[]) => void);
      heldArgs.push(args);
      return held.length;
    }
    return realSetTimeout(callback as never, delay, ...args);
  }) as typeof setTimeout;
  vi.stubGlobal("setTimeout", wrapped);
  await act(async () => {
    submit.click();
    await drainPaint();
  });
  if (held.length === 0) throw new Error("post-capture yield was not scheduled");
  return () => {
    vi.stubGlobal("setTimeout", realSetTimeout);
    // The yield schedules its macrotask and its settle before it waits.
    // Release every one that was held.
    const queued = held.splice(0);
    const queuedArgs = heldArgs.splice(0);
    queued.forEach((callback, index) => callback(...(queuedArgs[index] ?? [])));
  };
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
      await drainPaint();
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

  test("a press dispatched during the long task is processed before fetch and sends nothing", async () => {
    const { cancel, submit } = await renderPanel();
    const other = document.createElement("button");
    other.textContent = "not cancel";
    container.append(other);

    const release = await reachBeforeEncode(submit);
    expect(sendAsk).not.toHaveBeenCalled();
    expect(container.querySelector("[data-ask-capture-preparing]")).not.toBeNull();

    // A press on something that is not 取消 is ignored.
    await act(async () => {
      other.dispatchEvent(pointer("pointerdown", performance.now(), 1, 1, 3));
    });
    expect(sendAsk).not.toHaveBeenCalled();

    // The press is injected while the before-encode macrotask is still
    // queued, the same window as a press dispatched during domToCanvas.
    await act(async () => {
      cancel.dispatchEvent(pointer("pointerdown", performance.now() + 5_000, 12, 10));
      cancel.dispatchEvent(pointer("pointerup", performance.now() + 5_010, 14, 12));
    });
    expect(cancel.hasAttribute("data-pressed")).toBe(false);

    await act(async () => {
      release();
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
    });

    expect(sendAsk).not.toHaveBeenCalled();
    expect(usePlayerStore.getState().askPhase).toBe("selecting");
    expect(container.querySelector("[data-ask-panel]")).toBeNull();
    expect(container.textContent ?? "").not.toContain("播放回答");
    expect(container.textContent ?? "").not.toContain("老师在想");
    expect(container.querySelector("[data-ask-error]")).toBeNull();
  });

  test("a press that lands after the fetch aborts and leaves no answer", async () => {
    const { cancel, submit } = await renderPanel();

    let releaseSend: (() => void) | undefined;
    vi.mocked(sendAsk).mockImplementation(async (capture, options) => {
      expect(capture == null || capture.ok !== false || capture.reason !== "ABORTED").toBe(true);
      options?.onFetch?.(performance.now());
      // The fetch is in flight. A press now is after the send.
      const button = document.querySelector<HTMLButtonElement>("[data-ask-cancel]");
      button?.dispatchEvent(pointer("pointerdown", performance.now() + 5_000, 12, 10));
      button?.dispatchEvent(pointer("pointerup", performance.now() + 5_020, 14, 12));
      await new Promise<void>((resolve) => {
        releaseSend = resolve;
      });
    });

    const release = await reachBeforeEncode(submit);
    await act(async () => {
      release();
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
    });
    await vi.waitFor(() => {
      expect(sendAsk).toHaveBeenCalledTimes(1);
    });

    // retroCancelAsk is mocked, so the phase stays where the fetch left it.
    // The abort is the call. Nothing in this test writes an answer, a
    // waiting row, an error, or a history mark.
    expect(cancel.hasAttribute("data-pressed")).toBe(false);
    expect(retroCancelAsk).toHaveBeenCalledTimes(1);
    expect(usePlayerStore.getState().answers).toEqual({});
    expect(container.textContent ?? "").not.toContain("播放回答");
    expect(container.textContent ?? "").not.toContain("老师在想");
    expect(container.querySelector("[data-ask-waiting]")).toBeNull();
    expect(container.querySelector("[data-ask-error]")).toBeNull();
    expect(container.querySelector("[data-answer-mark]")).toBeNull();
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
      await drainPaint();
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
    await act(async () => {
      finish?.();
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
    });
    await vi.waitFor(() => {
      expect(sendAsk).toHaveBeenCalledTimes(1);
    });

    expect(retroCancelAsk).not.toHaveBeenCalled();
    expect(sendAsk).toHaveBeenCalledTimes(1);
  });

  test("a hold longer than 2s then a release on the button aborts", async () => {
    const { cancel, submit } = await renderPanel();

    const realSetTimeout = setTimeout;
    const realClearTimeout = clearTimeout;
    let holdTimer: (() => void) | undefined;
    vi.stubGlobal("setTimeout", ((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
      // The hold's 2s timer is the only long timer on this path. Hold it
      // so the test can fire the timeout while the press is still down.
      if (delay === 2000 && typeof callback === "function") {
        holdTimer = () => {
          callback(...args);
        };
        return 2000;
      }
      return realSetTimeout(callback as never, delay, ...args);
    }) as typeof setTimeout);
    vi.stubGlobal("clearTimeout", ((handle: unknown) => {
      if (handle === 2000) {
        holdTimer = undefined;
        return;
      }
      realClearTimeout(handle as ReturnType<typeof setTimeout>);
    }) as typeof clearTimeout);

    let releaseSend: (() => void) | undefined;
    vi.mocked(sendAsk).mockImplementation(async (_capture, options) => {
      options?.onFetch?.(performance.now());
      await new Promise<void>((resolve) => {
        releaseSend = resolve;
      });
    });

    const release = await reachBeforeEncode(submit);
    expect(container.querySelector("[data-ask-capture-preparing]")).not.toBeNull();

    await act(async () => {
      cancel.dispatchEvent(pointer("pointerdown", 10, 12, 10));
    });
    expect(cancel.hasAttribute("data-pressed")).toBe(true);
    expect(sendAsk).not.toHaveBeenCalled();

    // domToCanvas has returned and the one yield is pending. Releasing the
    // yield starts the hold. The press is still down, so the 2s timeout
    // sends, and the release on the button aborts that ask.
    await act(async () => {
      release();
      await new Promise<void>((resolve) => {
        realSetTimeout(resolve, 0);
      });
    });
    expect(holdTimer).toBeTypeOf("function");
    expect(sendAsk).not.toHaveBeenCalled();

    await act(async () => {
      holdTimer?.();
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
      await Promise.resolve();
    });
    vi.stubGlobal("setTimeout", realSetTimeout);
    vi.stubGlobal("clearTimeout", realClearTimeout);
  });
});
