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

  test("a tap that finished during the stall closes on the macrotask, before the 120ms settle", async () => {
    const { cancel, submit } = await renderPanel();
    // The real captureStage returns ABORTED once the release aborts its
    // signal. The default mock ignores the signal and would otherwise keep
    // going until the hold's 120ms settle resolved.
    vi.mocked(captureStage).mockImplementation(async (_container, _selection, opts) => {
      await opts?.beforeEncode?.();
      if (opts?.signal?.aborted) {
        return { ok: false, reason: "ABORTED", fallbackText: "" };
      }
      return {
        ok: true,
        encoder: "main",
        image: { mime: "image/jpeg", dataBase64: "qq==" },
        bytes: 1,
      };
    });
    const realSetTimeout = setTimeout;
    const held: Array<{ delay: number; run: () => void }> = [];
    vi.stubGlobal(
      "setTimeout",
      ((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
        const source = typeof callback === "function" ? callback.toString() : "";
        if (source.includes("askInputMacrotask") && typeof callback === "function") {
          held.push({ delay: delay ?? 0, run: () => callback(...args) });
          return held.length;
        }
        return realSetTimeout(callback as never, delay, ...args);
      }) as typeof setTimeout,
    );

    await act(async () => {
      submit.click();
      await drainPaint();
    });
    const delays = held.map((entry) => entry.delay).sort((a, b) => a - b);
    expect(delays[0]).toBe(0);
    expect(delays[1]).toBeGreaterThan(100);

    // The tap completed while capture was still inside the post-stall yield.
    // That is the 390 preparing cancel: pointerdown and pointerup both land
    // before the thread continues to encode.
    await act(async () => {
      cancel.dispatchEvent(pointer("pointerdown", 10, 12, 10));
      cancel.dispatchEvent(pointer("pointerup", 20, 14, 12));
    });

    const macrotask = held.find((entry) => entry.delay === 0);
    await act(async () => {
      macrotask?.run();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(held.map((entry) => entry.delay), "timers armed after the macrotask").toEqual(delays);
    expect(captureStage).toHaveBeenCalled();
    const signal = vi.mocked(captureStage).mock.calls.at(-1)?.[2]?.signal;
    expect(signal?.aborted, "release aborted the capture signal").toBe(true);
    expect(usePlayerStore.getState().askPhase).toBe("selecting");
    expect(container.querySelector("[data-ask-panel]")).toBeNull();
    expect(sendAsk).not.toHaveBeenCalled();
    // The 120ms settle was armed and never ran. The close did not wait for it.
    expect(held.filter((entry) => entry.delay > 100)).toHaveLength(1);

    vi.stubGlobal("setTimeout", realSetTimeout);
  });

  test("the normal path waits the full 120ms post-capture settle before encode and submit", async () => {
    const { submit } = await renderPanel();
    let encoded = false;
    vi.mocked(captureStage).mockImplementation(async (_container, _selection, opts) => {
      await opts?.beforeEncode?.();
      encoded = true;
      return {
        ok: true,
        encoder: "main",
        image: { mime: "image/jpeg", dataBase64: "qq==" },
        bytes: 1,
      };
    });

    // Fake timers own the animation frame and the settle. The pre-capture
    // paint is one frame plus a delay-0 macrotask, then the post-capture
    // macrotask. Those land inside the first 119ms. The timer still pending
    // there is the 120ms settle, so encode has not run. performance stays
    // real: a faked performance.now() would mark that settle already elapsed.
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "requestAnimationFrame", "cancelAnimationFrame"],
    });
    await act(async () => {
      submit.click();
    });
    await act(async () => {
      vi.advanceTimersToNextFrame();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(encoded).toBe(false);
    expect(sendAsk).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(119);
    });
    expect(captureStage).toHaveBeenCalled();
    expect(encoded).toBe(false);
    expect(sendAsk).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
    expect(usePlayerStore.getState().askPhase).toBe("drafting");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(encoded).toBe(true);
    expect(sendAsk).toHaveBeenCalledTimes(1);
    const sent = vi.mocked(sendAsk).mock.calls[0]?.[0];
    expect(sent).toMatchObject({ ok: true, image: { dataBase64: "qq==" } });
  });

  test("a cancel during the 120ms settle closes on the next frame and never submits the screenshot", async () => {
    const { cancel, submit } = await renderPanel();
    vi.spyOn(cancel, "getBoundingClientRect").mockReturnValue(BUTTON_BOX);
    let releaseEncode: ((result: {
      ok: true;
      encoder: "main";
      image: { mime: "image/jpeg"; dataBase64: string };
      bytes: number;
    }) => void) | undefined;
    vi.mocked(captureStage).mockImplementation(async (_container, _selection, opts) => {
      await opts?.beforeEncode?.();
      // Encode finishes after the cancel decision. The screenshot it
      // returns must be discarded.
      return new Promise((resolve) => {
        releaseEncode = resolve;
      });
    });

    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "requestAnimationFrame", "cancelAnimationFrame"],
    });
    await act(async () => {
      submit.click();
    });
    await act(async () => {
      vi.advanceTimersToNextFrame();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(releaseEncode).toBeUndefined();
    expect(sendAsk).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);

    // Mid-settle. The press lands and releases on 取消 before 120ms.
    // The close is committed here and paints on the next frame.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(40);
      cancel.dispatchEvent(pointer("pointerdown", 40, 12, 10));
      cancel.dispatchEvent(pointer("pointerup", 41, 14, 12));
    });
    expect(sendAsk).not.toHaveBeenCalled();
    expect(usePlayerStore.getState().askPhase).toBe("drafting");
    expect(container.querySelector("[data-ask-panel]")).not.toBeNull();

    await act(async () => {
      vi.advanceTimersToNextFrame();
      await Promise.resolve();
    });
    expect(usePlayerStore.getState().askPhase).toBe("selecting");
    expect(container.querySelector("[data-ask-panel]")).toBeNull();
    expect(sendAsk).not.toHaveBeenCalled();
    // The 120ms settle was cleared when the cancel ended it.
    expect(vi.getTimerCount()).toBe(0);

    await act(async () => {
      releaseEncode?.({
        ok: true,
        encoder: "main",
        image: { mime: "image/jpeg", dataBase64: "late==" },
        bytes: 4,
      });
      await Promise.resolve();
    });
    expect(sendAsk).not.toHaveBeenCalled();
    expect(usePlayerStore.getState().askPhase).toBe("selecting");
  });

  test("a capture timeout whose abort is queued behind the timer never submits", async () => {
    const { cancel, submit } = await renderPanel();
    vi.spyOn(cancel, "getBoundingClientRect").mockReturnValue(BUTTON_BOX);
    // The real timeout is the 3s capture budget. It yields one macrotask,
    // then resolves. The mock holds that callback so the test can fire it
    // and then register 取消 behind it with setTimeout(0). Real timers own
    // the pre-capture paint; only the 3s timeout is held.
    let fireTimeout: (() => void) | undefined;
    vi.mocked(captureStage).mockImplementation((_stageEl, _selection, opts) => {
      const signal = opts?.signal;
      return new Promise((resolve) => {
        fireTimeout = () => {
          void (async () => {
            // Same shape as captureStage's timeout: one macrotask, then a
            // second when the signal is still live. A cancel queued behind
            // the timer is that second macrotask.
            await new Promise<void>((yielded) => {
              setTimeout(yielded, 0);
            });
            if (!signal?.aborted) {
              await new Promise<void>((yielded) => {
                setTimeout(yielded, 0);
              });
            }
            if (signal?.aborted) {
              resolve({ ok: false, reason: "ABORTED", fallbackText: "" });
              return;
            }
            resolve({ ok: false, reason: "TIMEOUT", fallbackText: "步骤内容" });
          })();
        };
      });
    });

    await act(async () => {
      submit.click();
      await drainPaint();
    });
    await vi.waitFor(() => {
      expect(fireTimeout).toBeTypeOf("function");
    });
    expect(sendAsk).not.toHaveBeenCalled();

    // The timeout timer is due. Its callback yields one macrotask before it
    // resolves. Register 取消 after that callback has started, so the abort
    // is the timer behind the yield and runs before TIMEOUT is committed.
    fireTimeout?.();
    await act(async () => {
      await Promise.resolve();
    });
    setTimeout(() => {
      cancel.dispatchEvent(pointer("pointerdown", 3000, 12, 10));
      cancel.dispatchEvent(pointer("pointerup", 3001, 14, 12));
    }, 0);
    await act(async () => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
    });
    expect(sendAsk).not.toHaveBeenCalled();
    expect(usePlayerStore.getState().askPhase).toBe("selecting");
    expect(container.querySelector("[data-ask-panel]")).toBeNull();
  });

  test("a capture TIMEOUT after the release on 取消 does not send", async () => {
    const { cancel, submit } = await renderPanel();
    // The 3s timer can still beat the queued press and return TIMEOUT.
    // The release latch is the decision: that result must not send.
    vi.mocked(captureStage).mockImplementation(async (_container, _selection, opts) => {
      await opts?.beforeEncode?.();
      return { ok: false, reason: "TIMEOUT", fallbackText: "步骤内容" };
    });
    const realSetTimeout = setTimeout;
    const held: Array<{ delay: number; run: () => void }> = [];
    vi.stubGlobal(
      "setTimeout",
      ((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
        const source = typeof callback === "function" ? callback.toString() : "";
        if (source.includes("askInputMacrotask") && typeof callback === "function") {
          held.push({ delay: delay ?? 0, run: () => callback(...args) });
          return held.length;
        }
        return realSetTimeout(callback as never, delay, ...args);
      }) as typeof setTimeout,
    );

    await act(async () => {
      submit.click();
      await drainPaint();
    });
    await act(async () => {
      cancel.dispatchEvent(pointer("pointerdown", 10, 12, 10));
      cancel.dispatchEvent(pointer("pointerup", 20, 14, 12));
    });
    const macrotask = held.find((entry) => entry.delay === 0);
    await act(async () => {
      macrotask?.run();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(usePlayerStore.getState().askPhase).toBe("selecting");
    expect(container.querySelector("[data-ask-panel]")).toBeNull();
    expect(sendAsk).not.toHaveBeenCalled();
    expect(container.querySelector("[data-ask-capture-fallback]")).toBeNull();
    vi.stubGlobal("setTimeout", realSetTimeout);
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
