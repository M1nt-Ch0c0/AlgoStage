// @vitest-environment happy-dom
/**
 * A press that hits 取消 and is dispatched after the ask fetch aborts the
 * request. Nothing from that ask stays: no streamed text, no history row,
 * no browser cache entry. The event timeStamp is not the decision.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import AskPanel from "../components/board/ask-panel";
import StepAnswers from "../components/board/step-answers";
import { answersStorageKey } from "../lib/ask/answers-storage";
import { resetLongTaskEndForTests } from "../lib/ask/ask-timing";
import { disposeAskRequests } from "../lib/ask/ask-client";
import { captureStage } from "../lib/ask/capture";
import type { AnswerSegment, AskSelectionSummary, StepAnswer } from "../lib/ask/types";
import { usePlayerStore } from "../lib/player/store";
import type { TeachingScript } from "../lib/teaching/types";

vi.mock("../lib/ask/capture", async () => {
  const actual = await vi.importActual<typeof import("../lib/ask/capture")>("../lib/ask/capture");
  return {
    ...actual,
    captureStage: vi.fn(async () => ({
      ok: true as const,
      encoder: "worker" as const,
      image: { mime: "image/webp" as const, dataBase64: "qq==" },
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

const QUESTION = "为什么这样写？";

function segment(narration = "这段不该留下来。"): AnswerSegment {
  return { id: "seg-late", narration };
}

function answer(item: AnswerSegment = segment()): StepAnswer {
  return {
    v: 1,
    id: "ans-late",
    stepId: "s1",
    question: QUESTION,
    selection,
    segments: [item],
    createdAt: "2026-10-16T00:00:00.000Z",
  };
}

function ndjson(...lines: string[]) {
  return `${lines.join("\n")}\n`;
}

let root: Root;
let container: HTMLDivElement;

function box() {
  return {
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 40,
    bottom: 20,
    width: 40,
    height: 20,
    toJSON() {
      return {};
    },
  };
}

function pointer(type: string, timeStamp: number, clientX: number, clientY: number) {
  const event = new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    pointerId: 1,
    clientX,
    clientY,
  });
  Object.defineProperty(event, "timeStamp", { value: timeStamp });
  return event;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.localStorage.clear();
  usePlayerStore.getState().reset();
  usePlayerStore.getState().loadScript(script);
  usePlayerStore.getState().setLectureAnswerMeta({
    cacheKey: "ck-retro",
    scriptVersion: "v-retro",
    askDisabledStepIds: [],
    storageMode: "browser",
  });
  usePlayerStore.getState().setAnswers(Object.create(null));
  usePlayerStore.setState({ answersReady: true });
  usePlayerStore.getState().enterAsk();
  usePlayerStore.getState().setAskSelection(selection);
  usePlayerStore.getState().setAskQuestion(QUESTION);

  window.matchMedia = ((query: string) => ({
    matches: query.includes("reduce") ? true : false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;

  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  disposeAskRequests();
  usePlayerStore.getState().reset();
  resetLongTaskEndForTests();
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

async function render() {
  await act(async () => {
    root.render(
      createElement(
        "div",
        null,
        createElement(AskPanel),
        createElement(StepAnswers, { stepId: "s1" }),
      ),
    );
  });
}

async function drainUntilFetch(fetchStarted: Promise<void>) {
  const pending = Promise.race([
    fetchStarted,
    new Promise<void>((resolve) => {
      setTimeout(resolve, 1500);
    }),
  ]);
  for (let frame = 0; frame < 2; frame += 1) {
    await act(async () => {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });
    });
  }
  await act(async () => {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  });
  await pending;
}

describe("retro-cancelled ask", () => {
  test("a press that hits 取消 after the fetch leaves no history, cache, or streamed text", async () => {
    let releaseBody: (() => void) | undefined;
    const bodyGate = new Promise<void>((resolve) => {
      releaseBody = resolve;
    });
    let sentAt = 0;
    let fetchStarted: () => void = () => {};
    const fetchSeen = new Promise<void>((resolve) => {
      fetchStarted = resolve;
    });
    const encoder = new TextEncoder();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (!url.includes("/api/lecture/ask")) {
          return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
        }
        sentAt = performance.now();
        fetchStarted();
        const signal = init?.signal;
        const body = new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(
              encoder.encode(
                `${ndjson(
                  JSON.stringify({ type: "start", answerId: "ans-late", stepId: "s1", imageUsed: false }),
                  JSON.stringify({ type: "segment", segment: segment() }),
                )}`,
              ),
            );
            await bodyGate;
            if (signal?.aborted) {
              controller.close();
              return;
            }
            controller.enqueue(encoder.encode(JSON.stringify({ type: "result", answer: answer() }) + "\n"));
            controller.close();
          },
        });
        return new Response(body, { status: 200, headers: { "Content-Type": "application/x-ndjson" } });
      }),
    );

    await render();
    const submit = container.querySelector<HTMLButtonElement>("[data-ask-submit]");
    if (!submit) throw new Error("submit missing");
    await act(async () => {
      submit.click();
    });
    await drainUntilFetch(fetchSeen);
    expect(sentAt).toBeGreaterThan(0);
    await act(async () => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 20);
      });
    });

    const state = usePlayerStore.getState();
    expect(state.askPhase === "sending" || state.askPhase === "streaming").toBe(true);

    const cancel = container.querySelector<HTMLButtonElement>("[data-ask-cancel]");
    if (!cancel) throw new Error("cancel missing");
    vi.spyOn(cancel, "setPointerCapture").mockImplementation(() => {});
    vi.spyOn(cancel, "getBoundingClientRect").mockReturnValue(box());

    await vi.waitFor(() => {
      expect(usePlayerStore.getState().previewSegments.length).toBeGreaterThan(0);
    });
    expect(container.textContent ?? "").toContain("这段不该留下来");

    // The timeStamp is after sentAt on purpose. CDP stamps a stall press
    // when it is dequeued, which is after the fetch. The hit is what cancels.
    await act(async () => {
      cancel.dispatchEvent(pointer("pointerdown", sentAt + 30, 10, 8));
      cancel.dispatchEvent(pointer("pointerup", sentAt + 40, 12, 9));
    });
    releaseBody?.();
    await act(async () => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 30);
      });
    });

    const after = usePlayerStore.getState();
    expect(after.askPhase).toBe("selecting");
    expect(after.answers.s1 ?? []).toEqual([]);
    expect(after.previewSegments).toEqual([]);
    expect(after.askErrorCode).toBeNull();
    expect(after.expandedAnswerIds.size).toBe(0);
    expect(window.localStorage.getItem(answersStorageKey("ck-retro", "v-retro"))).toBeNull();
    expect(container.textContent ?? "").not.toContain("这段不该留下来");
    expect(container.textContent ?? "").not.toContain("播放回答");
    expect(container.querySelector("[data-ask-error]")).toBeNull();
    expect(container.querySelector("[data-testid='ask-preview']")).toBeNull();
    expect(container.querySelector("[data-answer-mark]")).toBeNull();
    expect(captureStage).toHaveBeenCalledTimes(1);
  });
});
