// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import AskPanel from "../components/board/ask-panel";
import { ASK_CAPTURE_FALLBACK, ASK_CAPTURE_PREPARING, ASK_CHIPS, ASK_WAITING_STATUS } from "../lib/ask/ask-ui-text";
import { ASK_ERROR_SPECS } from "../lib/ask/ask-errors";
import { ASK_LIMITS, type AskSelectionSummary } from "../lib/ask/types";
import { CAPTURE_FALLBACK_NOTICE, type CaptureResult } from "../lib/ask/capture";
import { cancelAsk, sendAsk } from "../lib/ask/ask-client";
import { captureStage } from "../lib/ask/capture";
import { usePlayerStore } from "../lib/player/store";
import type { TeachingScript } from "../lib/teaching/types";

vi.mock("next/link", () => ({
  default: (props: { href: string; children?: unknown; className?: string; [key: string]: unknown }) => {
    const { href, children, ...rest } = props;
    return createElement("a", { ...rest, href }, children as never);
  },
}));

vi.mock("../lib/ask/ask-client", () => ({
  sendAsk: vi.fn(async () => {}),
  cancelAsk: vi.fn(),
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
  steps: [
    { id: "s1", narration: "第一步讲解。", targets: [], effects: [] },
    { id: "s2", narration: "第二步讲解。", targets: [], effects: [] },
  ],
};

const OK_CAPTURE: CaptureResult = {
  ok: true,
  encoder: "main",
  image: { mime: "image/jpeg", dataBase64: "qq==" },
  bytes: 1,
};

function selection(): AskSelectionSummary {
  return {
    mode: "single",
    bbox: { x: 10, y: 20, width: 80, height: 40 },
    targets: [{ kind: "step", id: "step:s1", stepId: "s1", text: "步骤内容" }],
  };
}

let root: Root;
let container: HTMLDivElement;
let stage: HTMLDivElement;
let status: HTMLParagraphElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  usePlayerStore.getState().reset();
  usePlayerStore.getState().loadScript(script);
  vi.mocked(sendAsk).mockReset();
  vi.mocked(sendAsk).mockResolvedValue(undefined);
  vi.mocked(cancelAsk).mockReset();
  vi.mocked(captureStage).mockReset();
  vi.mocked(captureStage).mockResolvedValue(OK_CAPTURE);

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
  Object.defineProperty(stage, "clientWidth", { configurable: true, value: 800 });
  stage.innerHTML = `
    <p data-ask-target="subtitle" data-ask-id="subtitle:s1" data-ask-step-id="s1">字幕内容</p>
    <div data-ask-target="step" data-ask-id="step:s1" data-ask-step-id="s1">步骤内容</div>
    <div data-ask-target="viz" data-ask-id="viz:s1" data-ask-step-id="s1">可视化整块</div>
  `;
  const layer = document.createElement("div");
  layer.setAttribute("data-ask-layer", "");
  layer.tabIndex = -1;
  stage.append(layer);
  document.body.append(stage);

  status = document.createElement("p");
  status.setAttribute("role", "status");
  document.body.append(status);

  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  usePlayerStore.getState().reset();
  container.remove();
  stage.remove();
  status.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function render() {
  await act(async () => {
    root.render(createElement(AskPanel, { stage }));
  });
}

function panel(): HTMLDivElement {
  const el = container.querySelector<HTMLDivElement>("[data-ask-panel]");
  if (!el) throw new Error("panel missing");
  return el;
}

function question(): HTMLTextAreaElement {
  const el = container.querySelector<HTMLTextAreaElement>("[data-ask-question]");
  if (!el) throw new Error("question missing");
  return el;
}

function submitButton(): HTMLButtonElement {
  const el = container.querySelector<HTMLButtonElement>("[data-ask-submit]");
  if (!el) throw new Error("submit missing");
  return el;
}

function draft(phase: "drafting" | "sending" | "streaming" | "error" = "drafting", extra: Record<string, unknown> = {}) {
  usePlayerStore.setState({
    askPhase: phase,
    selection: selection(),
    draftQuestion: "",
    draftStepId: "s1",
    status: "interrupted",
    askErrorCode: null,
    askStartedAt: null,
    ...extra,
  });
}

function typeInto(value: string) {
  const el = question();
  const desc = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
  desc?.set?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function keydown(el: EventTarget, init: KeyboardEventInit) {
  el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
}

describe("ask panel", () => {
  test("askPhase 为 idle 时面板渲染 null", async () => {
    expect(usePlayerStore.getState().askPhase).toBe("idle");
    await render();
    expect(container.querySelector("[data-ask-panel]")).toBeNull();
  });

  test("22. 面板不再吞 Esc，也不把焦点送回舞台目标", async () => {
    draft("drafting", { draftQuestion: "还在的草稿" });
    await render();
    const target = stage.querySelector<HTMLElement>('[data-ask-id="step:s1"]');
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    await act(async () => {
      question().dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(false);
    expect(usePlayerStore.getState().askPhase).toBe("drafting");
    expect(document.activeElement).not.toBe(target);
    expect(container.querySelector("[data-ask-panel]")).not.toBeNull();
  });

  test("23. 空提问 aria-disabled；chip 只填不发；计数与 279/280 变色；超 300 截断", async () => {
    draft("drafting");
    await render();
    const submit = submitButton();
    expect(submit.getAttribute("aria-disabled")).toBe("true");
    expect(submit.className).toContain("opacity-50");
    expect(submit.className).toContain("cursor-not-allowed");
    expect(submit.className).toContain("bg-beam-gold");
    expect(submit.textContent).toBe("提问");
    expect(container.querySelector("[data-ask-count]")?.textContent).toBe("0/300");
    expect(container.querySelector("[data-ask-count]")?.className).not.toContain("text-warning");
    await act(async () => {
      submit.click();
    });
    expect(sendAsk).not.toHaveBeenCalled();
    expect(captureStage).not.toHaveBeenCalled();

    await act(async () => {
      container.querySelector<HTMLButtonElement>(`[data-ask-chip="${ASK_CHIPS[0]}"]`)?.click();
    });
    expect(usePlayerStore.getState().draftQuestion).toBe(ASK_CHIPS[0]);
    expect(question().value).toBe(ASK_CHIPS[0]);
    expect(sendAsk).not.toHaveBeenCalled();
    expect(captureStage).not.toHaveBeenCalled();
    const filled = submitButton();
    expect(filled.hasAttribute("aria-disabled")).toBe(false);
    expect(filled.className).not.toContain("opacity-50");
    expect(filled.className).not.toContain("cursor-not-allowed");
    expect(container.querySelector("[data-ask-count]")?.textContent).toBe(`${ASK_CHIPS[0].length}/300`);

    await act(async () => {
      usePlayerStore.setState({ draftQuestion: "字".repeat(279) });
    });
    const normal = container.querySelector("[data-ask-count]");
    expect(normal?.textContent).toBe("279/300");
    expect(normal?.className).not.toContain("text-warning");

    await act(async () => {
      usePlayerStore.setState({ draftQuestion: "字".repeat(280) });
    });
    const warned = container.querySelector("[data-ask-count]");
    expect(warned?.textContent).toBe("280/300");
    expect(warned?.className).toContain("text-warning");

    await act(async () => {
      typeInto("问".repeat(ASK_LIMITS.questionMax + 25));
    });
    expect(usePlayerStore.getState().draftQuestion).toHaveLength(ASK_LIMITS.questionMax);
    expect(question().value).toHaveLength(ASK_LIMITS.questionMax);
    expect(container.querySelector("[data-ask-count]")?.textContent).toBe("300/300");
    expect(container.querySelector("[data-ask-count]")?.className).toContain("text-warning");
  });

  test("24. Ctrl/Meta+Enter 发送，Enter 单独不发送", async () => {
    draft("drafting", { draftQuestion: "为什么这样写？" });
    await render();

    const newline = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    await act(async () => {
      question().dispatchEvent(newline);
    });
    expect(newline.defaultPrevented).toBe(false);
    expect(sendAsk).not.toHaveBeenCalled();
    expect(captureStage).not.toHaveBeenCalled();

    await act(async () => {
      keydown(question(), { key: "Enter", ctrlKey: true });
    });
    expect(captureStage).toHaveBeenCalledTimes(1);
    expect(sendAsk).toHaveBeenCalledTimes(1);
    expect(sendAsk).toHaveBeenCalledWith(OK_CAPTURE);

    vi.mocked(sendAsk).mockClear();
    vi.mocked(captureStage).mockClear();
    await act(async () => {
      keydown(question(), { key: "Enter", metaKey: true });
    });
    expect(sendAsk).toHaveBeenCalledWith(OK_CAPTURE);
  });

  test("25. 截图返回前 selection 或 stepId 变化则不发送；失败仍提示并 sendAsk(null)", async () => {
    draft("drafting", { draftQuestion: "换个例子讲讲" });
    await render();

    let resolveCapture: ((value: CaptureResult) => void) | undefined;
    vi.mocked(captureStage).mockImplementation(
      () =>
        new Promise<CaptureResult>((resolve) => {
          resolveCapture = resolve;
        }),
    );

    await act(async () => {
      submitButton().click();
    });
    expect(captureStage).toHaveBeenCalledTimes(1);
    expect(sendAsk).not.toHaveBeenCalled();

    await act(async () => {
      usePlayerStore.setState({ selection: selection() });
    });
    await act(async () => {
      resolveCapture?.(OK_CAPTURE);
    });
    expect(sendAsk).not.toHaveBeenCalled();
    expect(container.querySelector("[data-ask-capture-fallback]")).toBeNull();

    resolveCapture = undefined;
    vi.mocked(captureStage).mockImplementation(
      () =>
        new Promise<CaptureResult>((resolve) => {
          resolveCapture = resolve;
        }),
    );
    await act(async () => {
      submitButton().click();
    });
    await act(async () => {
      usePlayerStore.setState({
        steps: [
          { id: "s1-replaced", narration: "第一步讲解。", targets: [], effects: [] },
          script.steps[1]!,
        ],
      });
    });
    await act(async () => {
      resolveCapture?.(OK_CAPTURE);
    });
    expect(sendAsk).not.toHaveBeenCalled();

    await act(async () => {
      usePlayerStore.setState({
        steps: script.steps,
        currentIndex: 0,
        selection: selection(),
        draftQuestion: "换个例子讲讲",
        draftStepId: "s1",
        askPhase: "drafting",
      });
    });
    vi.mocked(captureStage).mockResolvedValue({
      ok: false,
      reason: "RENDER_FAILED",
      fallbackText: "步骤内容",
    });
    await act(async () => {
      submitButton().click();
    });
    expect(container.querySelector("[data-ask-capture-fallback]")?.textContent).toBe(CAPTURE_FALLBACK_NOTICE);
    expect(container.querySelector("[data-ask-capture-fallback]")?.textContent).toBe(ASK_CAPTURE_FALLBACK);
    expect(sendAsk).toHaveBeenCalledTimes(1);
    expect(sendAsk).toHaveBeenCalledWith(null);
    expect(usePlayerStore.getState().askCaptureFallback).toBe(true);
  });

  test("25b. 回答落到 playing 后草稿面板卸掉，截图失败提示还在", async () => {
    draft("drafting", { draftQuestion: "换个例子讲讲" });
    await render();
    vi.mocked(captureStage).mockResolvedValue({
      ok: false,
      reason: "RENDER_FAILED",
      fallbackText: "步骤内容",
    });
    vi.mocked(sendAsk).mockImplementation(async () => {
      usePlayerStore.setState({ askPhase: "playing", selection: null, draftQuestion: "" });
    });
    await act(async () => {
      submitButton().click();
    });
    expect(usePlayerStore.getState().askPhase).toBe("playing");
    expect(usePlayerStore.getState().askCaptureFallback).toBe(true);
    expect(container.querySelector("[data-ask-panel]")).toBeNull();
    expect(container.textContent).not.toContain("已选：无");
    expect(container.querySelector("[data-ask-capture-fallback]")?.textContent).toBe(ASK_CAPTURE_FALLBACK);
  });

  test("25c. 截图成功落到 playing 不留草稿面板，也不显示截图失败提示", async () => {
    draft("drafting", { draftQuestion: "换个例子讲讲" });
    await render();
    vi.mocked(sendAsk).mockImplementation(async () => {
      usePlayerStore.setState({ askPhase: "playing", selection: null, draftQuestion: "" });
    });
    await act(async () => {
      submitButton().click();
    });
    expect(usePlayerStore.getState().askCaptureFallback).toBe(false);
    expect(container.querySelector("[data-ask-panel]")).toBeNull();
    expect(container.querySelector("[data-ask-capture-fallback]")).toBeNull();
  });

  test("25d. 截图失败提示从 streaming 留到 playing 和 done，下一次提问才卸", async () => {
    draft("drafting", { draftQuestion: "换个例子讲讲" });
    await render();
    vi.mocked(captureStage).mockResolvedValue({
      ok: false,
      reason: "RENDER_FAILED",
      fallbackText: "步骤内容",
    });
    vi.mocked(sendAsk).mockImplementation(async () => {
      usePlayerStore.setState({ askPhase: "streaming", selection: null, draftQuestion: "" });
    });
    await act(async () => {
      submitButton().click();
    });
    expect(usePlayerStore.getState().askPhase).toBe("streaming");
    // start 之后选区还在，草稿面板留着，失败提示同时在。
    expect(container.querySelector("[data-ask-panel]")).not.toBeNull();
    expect(container.querySelector("[data-ask-capture-fallback]")?.textContent).toBe(ASK_CAPTURE_FALLBACK);

    await act(async () => {
      usePlayerStore.setState({ askPhase: "playing" });
    });
    expect(container.querySelector("[data-ask-panel]")).toBeNull();
    expect(container.querySelector("[data-ask-capture-fallback]")?.textContent).toBe(ASK_CAPTURE_FALLBACK);

    await act(async () => {
      usePlayerStore.setState({ askPhase: "done" });
    });
    expect(container.querySelector("[data-ask-capture-fallback]")?.textContent).toBe(ASK_CAPTURE_FALLBACK);
    expect(usePlayerStore.getState().askCaptureFallback).toBe(true);

    await act(async () => {
      usePlayerStore.getState().setLectureAnswerMeta({
        cacheKey: "c".repeat(40),
        scriptVersion: "d".repeat(40),
        askDisabledStepIds: [],
        storageMode: "server",
      });
      usePlayerStore.getState().setAnswers(Object.create(null));
      usePlayerStore.setState({
        askPhase: "done",
        askCaptureFallback: true,
        selection: null,
        draftQuestion: "",
        status: "paused",
        answersReady: true,
      });
    });
    expect(container.querySelector("[data-ask-capture-fallback]")?.textContent).toBe(ASK_CAPTURE_FALLBACK);
    await act(async () => {
      usePlayerStore.getState().enterAsk();
    });
    expect(usePlayerStore.getState().askCaptureFallback).toBe(false);
    expect(container.querySelector("[data-ask-capture-fallback]")).toBeNull();
  });

  test("25b. 点提问后立刻显示准备截图，截图结束后消失", async () => {
    draft("drafting", { draftQuestion: "为什么这样写？" });
    await render();

    let resolveCapture: ((value: CaptureResult) => void) | undefined;
    vi.mocked(captureStage).mockImplementation(
      () =>
        new Promise<CaptureResult>((resolve) => {
          resolveCapture = resolve;
        }),
    );

    await act(async () => {
      submitButton().click();
    });
    const preparing = container.querySelector("[data-ask-capture-preparing]");
    expect(preparing?.textContent).toBe(ASK_CAPTURE_PREPARING);
    expect(preparing?.textContent).toBe("正在准备截图…");
    expect(preparing?.getAttribute("role")).toBeNull();
    expect(sendAsk).not.toHaveBeenCalled();
    const locked = submitButton();
    expect(locked.getAttribute("aria-disabled")).toBe("true");
    expect(locked.className).toContain("opacity-50");
    expect(locked.className).toContain("cursor-not-allowed");

    await act(async () => {
      resolveCapture?.(OK_CAPTURE);
    });
    expect(container.querySelector("[data-ask-capture-preparing]")).toBeNull();
    expect(sendAsk).toHaveBeenCalledWith(OK_CAPTURE);
  });

  test("25d. 截图进行中 Esc 或取消关掉面板后，截图返回也不发送", async () => {
    draft("drafting", { draftQuestion: "为什么这样写？" });
    await render();

    let resolveCapture: ((value: CaptureResult) => void) | undefined;
    vi.mocked(captureStage).mockImplementation(
      () =>
        new Promise<CaptureResult>((resolve) => {
          resolveCapture = resolve;
        }),
    );

    await act(async () => {
      submitButton().click();
    });
    expect(container.querySelector("[data-ask-capture-preparing]")?.textContent).toBe(ASK_CAPTURE_PREPARING);
    expect(captureStage).toHaveBeenCalledTimes(1);

    await act(async () => {
      usePlayerStore.getState().closeAskPanel();
    });
    expect(container.querySelector("[data-ask-panel]")).toBeNull();
    expect(usePlayerStore.getState().askPhase).toBe("selecting");

    await act(async () => {
      resolveCapture?.(OK_CAPTURE);
    });
    expect(sendAsk).not.toHaveBeenCalled();
    expect(usePlayerStore.getState().askPhase).toBe("selecting");

    resolveCapture = undefined;
    draft("drafting", { draftQuestion: "为什么这样写？", askPhase: "drafting" });
    await render();
    vi.mocked(captureStage).mockImplementation(
      () =>
        new Promise<CaptureResult>((resolve) => {
          resolveCapture = resolve;
        }),
    );
    await act(async () => {
      submitButton().click();
    });
    expect(container.querySelector("[data-ask-capture-preparing]")).not.toBeNull();

    await act(async () => {
      container.querySelector<HTMLButtonElement>("[data-ask-cancel]")?.click();
    });
    expect(container.querySelector("[data-ask-panel]")).toBeNull();
    expect(usePlayerStore.getState().askPhase).toBe("selecting");
    expect(cancelAsk).not.toHaveBeenCalled();

    await act(async () => {
      resolveCapture?.(OK_CAPTURE);
    });
    expect(sendAsk).not.toHaveBeenCalled();
    expect(usePlayerStore.getState().askPhase).toBe("selecting");
  });

  test("25c. 截图 TIMEOUT 仍显示 #39 回退并 sendAsk(null)", async () => {
    draft("drafting", { draftQuestion: "换个例子讲讲" });
    await render();
    vi.mocked(captureStage).mockResolvedValue({
      ok: false,
      reason: "TIMEOUT",
      fallbackText: "步骤内容",
    });
    await act(async () => {
      submitButton().click();
    });
    expect(container.querySelector("[data-ask-capture-preparing]")).toBeNull();
    expect(container.querySelector("[data-ask-capture-fallback]")?.textContent).toBe(ASK_CAPTURE_FALLBACK);
    expect(sendAsk).toHaveBeenCalledTimes(1);
    expect(sendAsk).toHaveBeenCalledWith(null);
  });

  test("26. sending 显示等待秒数，每 10 秒更新 status；取消调用 cancelAsk，回到 drafting 后草稿与选区还在", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-14T00:00:03.000Z"));
    const started = Date.now() - 3000;
    const kept = selection();
    draft("sending", { draftQuestion: "老师在想的问题", selection: kept, askStartedAt: started });
    await render();

    expect(container.querySelector("[data-ask-waiting]")?.textContent).toBe(ASK_WAITING_STATUS(3));
    expect(status.textContent).toBe(ASK_WAITING_STATUS(3));
    const waitingSubmit = submitButton();
    expect(waitingSubmit.getAttribute("aria-disabled")).toBe("true");
    expect(waitingSubmit.className).toContain("opacity-50");
    expect(waitingSubmit.className).toContain("cursor-not-allowed");

    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(container.querySelector("[data-ask-waiting]")?.textContent).toBe(ASK_WAITING_STATUS(4));
    expect(status.textContent).toBe(ASK_WAITING_STATUS(3));

    await act(async () => {
      vi.advanceTimersByTime(9000);
    });
    expect(status.textContent).toBe(ASK_WAITING_STATUS(13));
    expect(document.querySelectorAll("[role=status]")).toHaveLength(1);

    await act(async () => {
      container.querySelector<HTMLButtonElement>("[data-ask-cancel]")?.click();
    });
    expect(cancelAsk).toHaveBeenCalledTimes(1);
    expect(usePlayerStore.getState().draftQuestion).toBe("老师在想的问题");
    expect(usePlayerStore.getState().selection).toBe(kept);

    await act(async () => {
      usePlayerStore.setState({ askPhase: "drafting", askStartedAt: null });
    });
    expect(usePlayerStore.getState().askPhase).toBe("drafting");
    expect(question().value).toBe("老师在想的问题");
    expect(container.querySelector("[data-ask-panel-label]")?.textContent).toBe("已选：当前步骤");
    expect(usePlayerStore.getState().selection).toBe(kept);
  });

  test("27. STEP_NOT_FOUND 只给刷新，NO_BYOK 只给去设置，TIMEOUT 重新问", async () => {
    const reload = vi.fn();
    const original = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...original, reload },
    });

    draft("error", { draftQuestion: "过期的问题", askErrorCode: "STEP_NOT_FOUND" });
    await render();
    const stepAlert = container.querySelector("[role=alert]");
    expect(stepAlert?.textContent).toBe(ASK_ERROR_SPECS.STEP_NOT_FOUND.message);
    expect(stepAlert?.textContent).toBe("这一步的教案已更新，请刷新后再提问。");
    expect(container.querySelector("[data-ask-error-action]")?.getAttribute("data-ask-error-action")).toBe("refresh");
    expect(container.querySelector("[data-ask-error-action]")?.textContent).toBe("刷新");
    expect(container.querySelector("[data-ask-submit]")).toBeNull();
    expect(container.textContent).not.toContain("去设置");
    expect(container.textContent).not.toContain("重新问");
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-ask-error-action="refresh"]')?.click();
    });
    expect(reload).toHaveBeenCalledTimes(1);

    await act(async () => {
      usePlayerStore.setState({ askPhase: "error", askErrorCode: "NO_BYOK", draftQuestion: "没接上" });
    });
    expect(container.querySelector("[role=alert]")?.textContent).toBe(ASK_ERROR_SPECS.NO_BYOK.message);
    const settings = container.querySelector<HTMLAnchorElement>('[data-ask-error-action="settings"]');
    expect(settings?.textContent).toBe("去设置");
    expect(settings?.getAttribute("href")).toBe("/settings");
    expect(container.querySelector("[data-ask-submit]")).toBeNull();
    expect(container.querySelector('[data-ask-error-action="refresh"]')).toBeNull();
    expect(container.textContent).not.toContain("重新问");

    await act(async () => {
      usePlayerStore.setState({ askPhase: "error", askErrorCode: "TIMEOUT", draftQuestion: "再问一次" });
    });
    expect(container.querySelector("[role=alert]")?.textContent).toBe("老师回答超时，请重新问一次。");
    expect(submitButton().textContent).toBe("重新问");
    expect(container.querySelector('[data-ask-error-action="refresh"]')).toBeNull();
    expect(container.querySelector('[data-ask-error-action="settings"]')).toBeNull();
    await act(async () => {
      submitButton().click();
    });
    expect(sendAsk).toHaveBeenCalledWith(OK_CAPTURE);

    Object.defineProperty(window, "location", { configurable: true, value: original });
  });

  test("28. 取消关面板后 store 仍留着草稿和选区，回到 selecting", async () => {
    const kept = selection();
    draft("drafting", { draftQuestion: "下次还在", selection: kept });
    await render();
    await act(async () => {
      container.querySelector<HTMLButtonElement>("[data-ask-cancel]")?.click();
    });
    const state = usePlayerStore.getState();
    expect(state.askPhase).toBe("selecting");
    expect(state.draftQuestion).toBe("下次还在");
    expect(state.selection).toBe(kept);
    expect(container.querySelector("[data-ask-panel]")).toBeNull();
  });

  test("29. 全页只有一个 role=status，role=alert 只在 error", async () => {
    draft("drafting", { draftQuestion: "普通草稿" });
    await render();
    expect(document.querySelectorAll("[role=status]")).toHaveLength(1);
    expect(document.querySelector("[role=alert]")).toBeNull();
    expect(panel().getAttribute("role")).toBe("dialog");
    expect(panel().getAttribute("aria-modal")).toBe("false");
    expect(panel().getAttribute("aria-labelledby")).toBe(container.querySelector("[data-ask-panel-label]")?.id);

    await act(async () => {
      usePlayerStore.setState({ askPhase: "error", askErrorCode: "UPSTREAM_ERROR" });
    });
    expect(document.querySelectorAll("[role=status]")).toHaveLength(1);
    expect(document.querySelectorAll("[role=alert]")).toHaveLength(1);
    expect(container.querySelector("[role=alert]")?.textContent).toBe(ASK_ERROR_SPECS.UPSTREAM_ERROR.message);
  });
});
