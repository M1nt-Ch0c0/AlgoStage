// @vitest-environment happy-dom
/**
 * The waiting-phase cancel handler, called directly. No pointer event and no
 * elementFromPoint: the assertion is that the in-flight ask's AbortController
 * aborts and the panel closes.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import AskPanel, { cancelWaitingAsk } from "../components/board/ask-panel";
import { disposeAskRequests } from "../lib/ask/ask-client";
import type { AskSelectionSummary } from "../lib/ask/types";
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

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  usePlayerStore.getState().reset();
  usePlayerStore.getState().loadScript(script);
  usePlayerStore.getState().setLectureAnswerMeta({
    cacheKey: "ck-wait",
    scriptVersion: "v-wait",
    askDisabledStepIds: [],
    storageMode: "browser",
  });
  usePlayerStore.getState().setAnswers(Object.create(null));
  usePlayerStore.setState({ answersReady: true, status: "finished" });
  usePlayerStore.getState().enterAsk();
  usePlayerStore.getState().setAskSelection(selection);
  usePlayerStore.getState().setAskQuestion("为什么这样写？");

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
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function render() {
  await act(async () => {
    root.render(createElement(AskPanel));
  });
}

async function drainUntilFetch(fetchStarted: Promise<void>) {
  const pending = Promise.race([
    fetchStarted,
    new Promise<void>((resolve) => {
      setTimeout(resolve, 1500);
    }),
  ]);
  await act(async () => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
  });
  await act(async () => {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  });
  await pending;
}

describe("waiting-phase cancel handler", () => {
  test("calling the handler aborts the in-flight ask and closes the panel", async () => {
    let askSignal: AbortSignal | undefined;
    const abort = vi.spyOn(AbortController.prototype, "abort");
    let fetchStarted: () => void = () => {};
    const fetchSeen = new Promise<void>((resolve) => {
      fetchStarted = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (!url.includes("/api/lecture/ask")) {
          return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
        }
        askSignal = init?.signal ?? undefined;
        fetchStarted();
        return new Promise<Response>((_resolve, reject) => {
          const fail = () => {
            const error = new Error("The operation was aborted.");
            error.name = "AbortError";
            reject(error);
          };
          if (init?.signal?.aborted) {
            fail();
            return;
          }
          init?.signal?.addEventListener("abort", fail, { once: true });
        });
      }),
    );

    await render();
    const submit = container.querySelector<HTMLButtonElement>("[data-ask-submit]");
    if (!submit) throw new Error("submit missing");
    await act(async () => {
      submit.click();
    });
    await drainUntilFetch(fetchSeen);
    await act(async () => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 20);
      });
    });

    expect(usePlayerStore.getState().askPhase).toBe("sending");
    expect(container.querySelector("[data-ask-panel]")).not.toBeNull();
    expect(askSignal?.aborted).toBe(false);

    await act(async () => {
      cancelWaitingAsk({ holdWaiting: false, heldAfterSend: false });
    });

    expect(abort).toHaveBeenCalledTimes(1);
    expect(askSignal?.aborted).toBe(true);
    expect(usePlayerStore.getState().askPhase).toBe("selecting");
    expect(container.querySelector("[data-ask-panel]")).toBeNull();
  });
});
