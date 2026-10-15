// @vitest-environment happy-dom
/**
 * A 取消 press whose timeStamp is inside the settle window, dispatched after
 * the hold wait has already resolved to send. The early document listener is
 * still attached, so the release on the button retro-cancels the ask.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import AskPanel from "../components/board/ask-panel";
import { retroCancelAsk, sendAsk } from "../lib/ask/ask-client";
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
  await act(async () => root.unmount());
  usePlayerStore.getState().reset();
  container.remove();
  stage.remove();
  vi.unstubAllGlobals();
});

async function finishCaptureTurn() {
  await Promise.resolve();
  for (let frame = 0; frame < 4; frame += 1) {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
  }
  for (let turn = 0; turn < 2; turn += 1) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 50);
  });
}

describe("early 取消 press", () => {
  test("a press with timeStamp inside the settle window, dispatched after the hold wait resolved, aborts and leaves no answer", async () => {
    await act(async () => {
      root.render(createElement(AskPanel, { stage }));
    });
    const cancel = container.querySelector<HTMLButtonElement>("[data-ask-cancel]");
    const submit = container.querySelector<HTMLButtonElement>("[data-ask-submit]");
    if (!cancel || !submit) throw new Error("panel controls missing");
    vi.spyOn(cancel, "getBoundingClientRect").mockReturnValue({
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
    });

    let sentAt = 0;
    let releaseSend: (() => void) | undefined;
    vi.mocked(sendAsk).mockImplementation(async (_capture, options) => {
      sentAt = performance.now();
      options?.onFetch?.(sentAt);
      await new Promise<void>((resolve) => {
        releaseSend = resolve;
      });
    });

    const pendingSubmit = act(async () => {
      submit.click();
      await finishCaptureTurn();
    });
    await vi.waitFor(() => {
      expect(sendAsk).toHaveBeenCalledTimes(1);
    });

    const down = new PointerEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
      button: 0,
      pointerId: 7,
      clientX: 12,
      clientY: 10,
    });
    Object.defineProperty(down, "timeStamp", { value: sentAt - 30 });
    const up = new PointerEvent("pointerup", {
      bubbles: true,
      cancelable: true,
      button: 0,
      pointerId: 7,
      clientX: 14,
      clientY: 12,
    });
    Object.defineProperty(up, "timeStamp", { value: sentAt + 20 });
    await act(async () => {
      cancel.dispatchEvent(down);
      cancel.dispatchEvent(up);
    });

    expect(retroCancelAsk).toHaveBeenCalledTimes(1);
    expect(usePlayerStore.getState().askPhase).not.toBe("playing");
    expect(usePlayerStore.getState().answers).toEqual({});
    expect(container.textContent ?? "").not.toContain("播放回答");
    releaseSend?.();
    await act(async () => {
      await pendingSubmit;
    });
    expect(retroCancelAsk).toHaveBeenCalledTimes(1);
  });
});
