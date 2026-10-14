// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import AskEntry from "../components/board/ask-entry";
import {
  ASK_ENTRY_LABEL,
  ASK_EXIT_LABEL,
  ASK_PENDING_PREPARING_SR,
  ASK_PENDING_TIMEOUT,
  ASK_REASON_TEXT,
} from "../lib/ask/ask-ui-text";
import { usePlayerStore, type AskPhase, type LectureAnswerMeta } from "../lib/player/store";
import type { TeachingScript } from "../lib/teaching/types";

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

const serverMeta: LectureAnswerMeta = {
  cacheKey: "ck-1",
  scriptVersion: "v1",
  askDisabledStepIds: [],
  storageMode: "server",
};

const GREY = "opacity-50";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  usePlayerStore.getState().reset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  usePlayerStore.getState().reset();
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function loadReady(meta: LectureAnswerMeta = serverMeta) {
  usePlayerStore.getState().loadScript(script);
  usePlayerStore.getState().setLectureAnswerMeta(meta);
  usePlayerStore.setState({ answersReady: true });
}

async function render() {
  await act(async () => {
    root.render(createElement(AskEntry));
  });
}

function entry(): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>("[data-ask-entry]");
  if (!button) throw new Error("ask entry missing");
  return button;
}

function reasonText(): string | null {
  return container.querySelector("#ask-entry-reason")?.textContent ?? null;
}

function describedText(button: HTMLButtonElement): string | null {
  const id = button.getAttribute("aria-describedby");
  if (!id) return null;
  return container.querySelector(`#${id}`)?.textContent ?? null;
}

test("无脚本或无当前步时不渲染入口", async () => {
  await render();
  expect(container.querySelector("[data-ask-entry]")).toBeNull();
  usePlayerStore.getState().beginStream({
    problemSlug: "3sum",
    mode: "lecture",
    language: "zh",
    solutionLanguage: "typescript",
  });
  await render();
  expect(container.querySelector("[data-ask-entry]")).toBeNull();
});

test("可用态无 aria-disabled，也没有 aria-describedby", async () => {
  loadReady();
  await render();
  const button = entry();
  expect(button.hasAttribute("aria-disabled")).toBe(false);
  expect(button.hasAttribute("aria-describedby")).toBe(false);
  expect(button.getAttribute("disabled")).toBeNull();
  expect(button.textContent).toContain(ASK_ENTRY_LABEL);
  expect(reasonText()).toBeNull();
  expect(button.className).not.toContain(GREY);
});

test("builtin 置灰、可聚焦，文案逐字匹配", async () => {
  loadReady();
  usePlayerStore.getState().setAskBuiltin(true);
  await render();
  const button = entry();
  expect(button.getAttribute("aria-disabled")).toBe("true");
  expect(button.disabled).toBe(false);
  expect(button.getAttribute("data-ask-disabled-reason")).toBe("builtin");
  expect(button.className).toContain(GREY);
  button.focus();
  expect(document.activeElement).toBe(button);
  expect(describedText(button)).toBe(ASK_REASON_TEXT.builtin);
  expect(describedText(button)).toBe("生成讲课后就可以提问");
});

test("unfinished 文案在任意步都相同", async () => {
  loadReady();
  usePlayerStore.getState().setAskUnfinished(true);
  await render();
  expect(describedText(entry())).toBe("这节课没讲完，重新生成后就可以提问");
  await act(async () => usePlayerStore.getState().goto(1));
  expect(entry().getAttribute("aria-disabled")).toBe("true");
  expect(describedText(entry())).toBe("这节课没讲完，重新生成后就可以提问");
  expect(entry().getAttribute("data-ask-disabled-reason")).toBe("unfinished");
});

test("receiving 文案逐字匹配", async () => {
  loadReady();
  usePlayerStore.setState({ receiving: true });
  await render();
  expect(describedText(entry())).toBe("备课完成后可以提问");
  expect(entry().getAttribute("data-ask-disabled-reason")).toBe("receiving");
});

test("stepDisabled 文案逐字匹配，换到非禁用步恢复可用", async () => {
  loadReady({ ...serverMeta, askDisabledStepIds: ["s1"] });
  await render();
  expect(describedText(entry())).toBe("这一步暂时不能提问，重新生成这节课后就可以了");
  expect(entry().getAttribute("data-ask-disabled-reason")).toBe("stepDisabled");
  await act(async () => usePlayerStore.getState().goto(1));
  expect(entry().hasAttribute("aria-disabled")).toBe(false);
  expect(entry().hasAttribute("aria-describedby")).toBe(false);
  expect(reasonText()).toBeNull();
});

test.each(["sending", "streaming", "playing"] as const)("busy %s 文案逐字匹配", async (phase) => {
  loadReady();
  usePlayerStore.setState({ askPhase: phase });
  await render();
  expect(describedText(entry())).toBe("上一个问题还在回答，答完再问");
  expect(entry().getAttribute("data-ask-disabled-reason")).toBe("busy");
  expect(entry().getAttribute("aria-pressed")).toBeNull();
});

test("done 与 error 离开 busy：done 恢复可用，error 是按下的退出圈选", async () => {
  loadReady();
  usePlayerStore.setState({ askPhase: "sending" });
  await render();
  expect(entry().getAttribute("data-ask-disabled-reason")).toBe("busy");

  await act(async () => usePlayerStore.setState({ askPhase: "done" }));
  expect(entry().hasAttribute("aria-disabled")).toBe(false);
  expect(entry().textContent).toContain(ASK_ENTRY_LABEL);
  expect(reasonText()).toBeNull();

  await act(async () => usePlayerStore.setState({ askPhase: "error" }));
  expect(entry().getAttribute("aria-pressed")).toBe("true");
  expect(entry().hasAttribute("aria-disabled")).toBe(false);
  expect(entry().textContent).toContain(ASK_EXIT_LABEL);
});

test("优先级 builtin > receiving > unfinished > stepDisabled > busy", async () => {
  loadReady({ ...serverMeta, askDisabledStepIds: ["s1"] });
  usePlayerStore.setState({
    receiving: true,
    askPhase: "sending" satisfies AskPhase,
  });
  usePlayerStore.getState().setAskBuiltin(true);
  usePlayerStore.getState().setAskUnfinished(true);
  await render();
  expect(entry().getAttribute("data-ask-disabled-reason")).toBe("builtin");
  expect(describedText(entry())).toBe(ASK_REASON_TEXT.builtin);

  await act(async () => usePlayerStore.getState().setAskBuiltin(false));
  expect(entry().getAttribute("data-ask-disabled-reason")).toBe("receiving");

  await act(async () => usePlayerStore.setState({ receiving: false }));
  expect(entry().getAttribute("data-ask-disabled-reason")).toBe("unfinished");

  await act(async () => usePlayerStore.getState().setAskUnfinished(false));
  expect(entry().getAttribute("data-ask-disabled-reason")).toBe("stepDisabled");

  await act(async () => {
    usePlayerStore.getState().setLectureAnswerMeta({ ...serverMeta, askDisabledStepIds: [] });
  });
  expect(entry().getAttribute("data-ask-disabled-reason")).toBe("busy");
  expect(describedText(entry())).toBe(ASK_REASON_TEXT.busy);
});

test("所有灰态共用同一 disabled class，始终在 DOM，点击不进入圈选", async () => {
  loadReady();
  const cases: Array<() => void> = [
    () => usePlayerStore.getState().setAskBuiltin(true),
    () => {
      usePlayerStore.getState().setAskBuiltin(false);
      usePlayerStore.setState({ receiving: true });
    },
    () => {
      usePlayerStore.setState({ receiving: false });
      usePlayerStore.getState().setAskUnfinished(true);
    },
    () => {
      usePlayerStore.getState().setAskUnfinished(false);
      usePlayerStore.getState().setLectureAnswerMeta({ ...serverMeta, askDisabledStepIds: ["s1"] });
    },
    () => {
      usePlayerStore.getState().setLectureAnswerMeta(serverMeta);
      usePlayerStore.setState({ askPhase: "playing" });
    },
  ];
  const classes: string[] = [];
  await render();
  for (const apply of cases) {
    await act(async () => apply());
    const button = entry();
    expect(container.contains(button)).toBe(true);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.className).toContain(GREY);
    expect(button.className).toContain("text-chalk-500");
    classes.push(button.className);
    const reason = button.getAttribute("data-ask-disabled-reason") as keyof typeof ASK_REASON_TEXT;
    expect(describedText(button)).toBe(ASK_REASON_TEXT[reason]);
    await act(async () => button.click());
    expect(usePlayerStore.getState().askPhase).not.toBe("selecting");
    expect(describedText(entry())).toBe(ASK_REASON_TEXT[reason]);
  }
  expect(new Set(classes).size).toBe(1);
  expect(usePlayerStore.getState().askPhase).toBe("playing");
});

test("可用时点击进入圈选", async () => {
  loadReady();
  usePlayerStore.setState({ status: "playing" });
  await render();
  await act(async () => entry().click());
  expect(usePlayerStore.getState().askPhase).toBe("selecting");
});

test.each(["selecting", "drafting", "error"] as const)("%s 为按下态，文案退出圈选，点击 exitAsk", async (phase) => {
  loadReady();
  usePlayerStore.setState({ askPhase: phase, status: "interrupted" });
  await render();
  const button = entry();
  expect(button.getAttribute("aria-pressed")).toBe("true");
  expect(button.hasAttribute("aria-disabled")).toBe(false);
  expect(button.textContent).toContain(ASK_EXIT_LABEL);
  expect(button.textContent).not.toContain(ASK_ENTRY_LABEL);
  await act(async () => button.click());
  expect(usePlayerStore.getState().askPhase).toBe("idle");
});

test("pending 不置灰无提示；点击后转圈，落定可问进入 selecting", async () => {
  loadReady({ ...serverMeta, storageMode: "pending", cacheKey: "", scriptVersion: "" });
  await render();
  const button = entry();
  expect(button.hasAttribute("aria-disabled")).toBe(false);
  expect(button.hasAttribute("aria-describedby")).toBe(false);
  expect(reasonText()).toBeNull();
  expect(container.textContent).not.toContain("正在准备，请稍候");
  expect(container.textContent).not.toContain(ASK_PENDING_PREPARING_SR);

  await act(async () => button.click());
  expect(usePlayerStore.getState().pendingEnterIntent).toEqual({
    stepId: "s1",
    generation: usePlayerStore.getState().generation,
  });
  expect(usePlayerStore.getState().askPhase).toBe("idle");
  expect(entry().getAttribute("aria-busy")).toBe("true");
  expect(entry().querySelector("[data-ask-pending-spinner]")).toBeTruthy();
  expect(entry().className).toContain("pointer-coarse:min-h-11");
  expect(entry().className).toContain("pointer-coarse:min-w-11");
  expect(container.textContent).toContain(ASK_PENDING_PREPARING_SR);
  expect(container.textContent).not.toContain("正在准备，请稍候");
  expect(entry().querySelector(".sr-only")?.textContent).toBe(ASK_PENDING_PREPARING_SR);

  await act(async () => usePlayerStore.getState().setLectureAnswerMeta(serverMeta));
  expect(usePlayerStore.getState().askPhase).toBe("selecting");
  expect(usePlayerStore.getState().pendingEnterIntent).toBeNull();
  expect(entry().getAttribute("aria-busy")).toBeNull();
  expect(entry().querySelector("[data-ask-pending-spinner]")).toBeNull();
  expect(entry().getAttribute("aria-pressed")).toBe("true");
  expect(container.textContent).not.toContain(ASK_PENDING_PREPARING_SR);
});

test("pending 落定为 builtin 时显示原因且不进圈选", async () => {
  loadReady({ ...serverMeta, storageMode: "pending" });
  await render();
  await act(async () => entry().click());
  expect(entry().getAttribute("aria-busy")).toBe("true");
  await act(async () => {
    usePlayerStore.getState().setAskBuiltin(true);
    usePlayerStore.getState().setLectureAnswerMeta(serverMeta);
  });
  expect(usePlayerStore.getState().askPhase).toBe("idle");
  expect(usePlayerStore.getState().pendingEnterIntent).toBeNull();
  expect(entry().getAttribute("aria-busy")).toBeNull();
  expect(entry().getAttribute("data-ask-disabled-reason")).toBe("builtin");
  expect(describedText(entry())).toBe(ASK_REASON_TEXT.builtin);
  expect(container.textContent).not.toContain("正在准备，请稍候");
});

test("等待中换步取消意图并停掉转圈", async () => {
  loadReady({ ...serverMeta, storageMode: "pending" });
  await render();
  await act(async () => entry().click());
  expect(usePlayerStore.getState().pendingEnterIntent).not.toBeNull();
  await act(async () => usePlayerStore.getState().goto(1));
  expect(usePlayerStore.getState().pendingEnterIntent).toBeNull();
  expect(usePlayerStore.getState().askPhase).toBe("idle");
  expect(entry().getAttribute("aria-busy")).toBeNull();
  expect(entry().querySelector("[data-ask-pending-spinner]")).toBeNull();
  expect(container.textContent).not.toContain(ASK_PENDING_PREPARING_SR);
});

test("等待中再点入口取消意图", async () => {
  loadReady({ ...serverMeta, storageMode: "pending" });
  await render();
  await act(async () => entry().click());
  expect(entry().getAttribute("aria-busy")).toBe("true");
  await act(async () => entry().click());
  expect(usePlayerStore.getState().pendingEnterIntent).toBeNull();
  expect(usePlayerStore.getState().askPhase).toBe("idle");
  expect(entry().getAttribute("aria-busy")).toBeNull();
  expect(entry().hasAttribute("aria-describedby")).toBe(false);
});

test("reduced motion 用静态省略号代替转圈", async () => {
  const original = window.matchMedia.bind(window);
  vi.stubGlobal("matchMedia", (query: string) => {
    if (query === "(prefers-reduced-motion: reduce)") {
      return {
        matches: true,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      };
    }
    return original(query);
  });
  loadReady({ ...serverMeta, storageMode: "pending" });
  await render();
  await act(async () => entry().click());
  expect(entry().querySelector("[data-ask-pending-spinner]")).toBeNull();
  expect(entry().textContent).toContain("…");
  expect(container.textContent).toContain(ASK_PENDING_PREPARING_SR);
  expect(container.textContent).not.toContain("正在准备，请稍候");
});

test("pending 2999ms 仍在等待，3000ms 显示超时文案且不进圈选", async () => {
  loadReady({ ...serverMeta, storageMode: "pending" });
  await render();
  await act(async () => entry().click());
  expect(entry().getAttribute("aria-busy")).toBe("true");

  await act(async () => vi.advanceTimersByTime(2999));
  expect(entry().getAttribute("aria-busy")).toBe("true");
  expect(entry().querySelector("[data-ask-pending-spinner]")).toBeTruthy();
  expect(usePlayerStore.getState().pendingEnterIntent).not.toBeNull();
  expect(usePlayerStore.getState().askPhase).toBe("idle");
  expect(container.textContent).not.toContain(ASK_PENDING_TIMEOUT);
  expect(entry().hasAttribute("aria-describedby")).toBe(false);

  await act(async () => vi.advanceTimersByTime(1));
  expect(usePlayerStore.getState().pendingEnterIntent).toBeNull();
  expect(usePlayerStore.getState().askPhase).toBe("idle");
  expect(entry().getAttribute("aria-busy")).toBeNull();
  expect(entry().querySelector("[data-ask-pending-spinner]")).toBeNull();
  expect(entry().getAttribute("data-ask-disabled-reason")).toBe("pendingTimeout");
  expect(describedText(entry())).toBe(ASK_PENDING_TIMEOUT);
  expect(container.textContent).not.toContain("正在准备，请稍候");
  expect(container.textContent).not.toContain(ASK_PENDING_PREPARING_SR);
});

test("askDisabledStepIds 当前步为 stepDisabled，点击不进圈选", async () => {
  loadReady({ ...serverMeta, askDisabledStepIds: ["s1", "s1"] });
  await render();
  expect(entry().getAttribute("data-ask-disabled-reason")).toBe("stepDisabled");
  expect(describedText(entry())).toBe(ASK_REASON_TEXT.stepDisabled);
  await act(async () => entry().click());
  expect(usePlayerStore.getState().askPhase).toBe("idle");
  expect(usePlayerStore.getState().pendingEnterIntent).toBeNull();
});

test("exit state has aria-keyshortcuts=Escape, kbd text Esc, min-h-11 and min-w-11 classes; entry state has aria-keyshortcuts=Q and kbd Q", async () => {
  loadReady();
  await render();
  const entryBtn = entry();
  expect(entryBtn.getAttribute("aria-keyshortcuts")).toBe("Q");
  expect(entryBtn.querySelector<HTMLElement>("[data-ask-kbd]")?.textContent).toBe("Q");
  expect(entryBtn.classList.contains("min-h-11")).toBe(false);
  expect(entryBtn.classList.contains("min-w-11")).toBe(false);
  expect(entryBtn.classList.contains("pointer-fine:-my-3")).toBe(false);
  expect(entryBtn.classList.contains("whitespace-nowrap")).toBe(true);

  await act(async () => {
    usePlayerStore.setState({ askPhase: "selecting" });
  });
  const exitBtn = entry();
  expect(exitBtn.getAttribute("aria-keyshortcuts")).toBe("Escape");
  const kbd = exitBtn.querySelector<HTMLElement>("[data-ask-kbd]");
  expect(kbd).not.toBeNull();
  expect(kbd?.textContent).toBe("Esc");
  expect(exitBtn.classList.contains("min-h-11")).toBe(true);
  expect(exitBtn.classList.contains("min-w-11")).toBe(true);
  expect(exitBtn.classList.contains("pointer-fine:-my-3")).toBe(true);
  expect(exitBtn.classList.contains("whitespace-nowrap")).toBe(true);
});

test.each(["drafting", "error"] as const)(
  "exit state (%s) has aria-keyshortcuts=Escape, kbd text Esc, min-h-11 and min-w-11 classes",
  async (phase) => {
    loadReady();
    usePlayerStore.setState({ askPhase: phase });
    await render();
    const button = entry();
    expect(button.getAttribute("aria-keyshortcuts")).toBe("Escape");
    const kbd = button.querySelector<HTMLElement>("[data-ask-kbd]");
    expect(kbd).not.toBeNull();
    expect(kbd?.textContent).toBe("Esc");
    expect(button.classList.contains("min-h-11")).toBe(true);
    expect(button.classList.contains("min-w-11")).toBe(true);
    expect(button.classList.contains("pointer-fine:-my-3")).toBe(true);
  }
);

test("entry aria-keyshortcuts=Q and kbd Q; exit Escape", async () => {
  loadReady();
  await render();
  const entryBtn = entry();
  expect(entryBtn.getAttribute("aria-keyshortcuts")).toBe("Q");
  const entryKbd = entryBtn.querySelector<HTMLElement>("[data-ask-kbd]");
  expect(entryKbd).not.toBeNull();
  expect(entryKbd?.textContent).toBe("Q");

  await act(async () => {
    usePlayerStore.setState({ askPhase: "selecting" });
  });
  const exitBtn = entry();
  expect(exitBtn.getAttribute("aria-keyshortcuts")).toBe("Escape");
  const exitKbd = exitBtn.querySelector<HTMLElement>("[data-ask-kbd]");
  expect(exitKbd).not.toBeNull();
  expect(exitKbd?.textContent).toBe("Esc");
});

test("pressing q on window enters (askPhase selecting)", async () => {
  loadReady();
  await render();
  expect(usePlayerStore.getState().askPhase).toBe("idle");
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "q", bubbles: true }));
  });
  expect(usePlayerStore.getState().askPhase).toBe("selecting");
});

test("Ctrl+q, Meta+q, Alt+q ignored", async () => {
  loadReady();
  await render();
  for (const modifier of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "q", ...modifier, bubbles: true }));
    });
    expect(usePlayerStore.getState().askPhase).toBe("idle");
  }
});

test("q dispatched from an <input>, a <textarea>, and an element inside .monaco-editor ignored", async () => {
  loadReady();
  await render();

  const input = document.createElement("input");
  const textarea = document.createElement("textarea");
  const monacoContainer = document.createElement("div");
  monacoContainer.className = "monaco-editor";
  const monacoChild = document.createElement("span");
  monacoContainer.appendChild(monacoChild);
  document.body.append(input, textarea, monacoContainer);

  try {
    for (const el of [input, textarea, monacoChild]) {
      await act(async () => {
        el.dispatchEvent(new KeyboardEvent("keydown", { key: "q", bubbles: true }));
      });
      expect(usePlayerStore.getState().askPhase).toBe("idle");
    }
  } finally {
    input.remove();
    textarea.remove();
    monacoContainer.remove();
  }
});

test("q while inside role=dialog ignored", async () => {
  loadReady();
  await render();

  const dialog = document.createElement("div");
  dialog.setAttribute("role", "dialog");
  const dialogChild = document.createElement("button");
  dialog.appendChild(dialogChild);
  document.body.appendChild(dialog);

  try {
    await act(async () => {
      dialogChild.dispatchEvent(new KeyboardEvent("keydown", { key: "q", bubbles: true }));
    });
    expect(usePlayerStore.getState().askPhase).toBe("idle");
  } finally {
    dialog.remove();
  }
});

test("q when aria-modal=true exists ignored", async () => {
  loadReady();
  await render();

  const modal = document.createElement("div");
  modal.setAttribute("aria-modal", "true");
  document.body.appendChild(modal);

  try {
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "q", bubbles: true }));
    });
    expect(usePlayerStore.getState().askPhase).toBe("idle");
  } finally {
    modal.remove();
  }
});

test("q while already in ask mode is a no-op (stays in ask mode)", async () => {
  loadReady();
  usePlayerStore.setState({ askPhase: "selecting" });
  await render();
  expect(usePlayerStore.getState().askPhase).toBe("selecting");

  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "q", bubbles: true }));
  });
  expect(usePlayerStore.getState().askPhase).toBe("selecting");
});

test("disabled (e.g. builtin) q shows the reason note and does not enter", async () => {
  loadReady();
  usePlayerStore.getState().setAskBuiltin(true);
  await render();
  expect(reasonText()).toBe(ASK_REASON_TEXT.builtin);

  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "q", bubbles: true }));
  });
  expect(usePlayerStore.getState().askPhase).toBe("idle");
  expect(reasonText()).toBe(ASK_REASON_TEXT.builtin);
});

test("storageMode pending q calls requestEnterAsk (pendingEnterIntent set, aria-busy)", async () => {
  loadReady({ ...serverMeta, storageMode: "pending", cacheKey: "", scriptVersion: "" });
  await render();
  expect(entry().getAttribute("aria-busy")).toBeNull();
  expect(usePlayerStore.getState().pendingEnterIntent).toBeNull();

  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "q", bubbles: true }));
  });
  expect(usePlayerStore.getState().pendingEnterIntent).toEqual({
    stepId: "s1",
    generation: usePlayerStore.getState().generation,
  });
  expect(entry().getAttribute("aria-busy")).toBe("true");
  expect(usePlayerStore.getState().askPhase).toBe("idle");
});

test("keydown Q with repeat:true and isComposing:true do not enter ask mode, while plain Q does", async () => {
  loadReady();
  await render();
  expect(usePlayerStore.getState().askPhase).toBe("idle");

  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Q", repeat: true, bubbles: true }));
  });
  expect(usePlayerStore.getState().askPhase).toBe("idle");

  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Q", isComposing: true, bubbles: true }));
  });
  expect(usePlayerStore.getState().askPhase).toBe("idle");

  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Q", bubbles: true }));
  });
  expect(usePlayerStore.getState().askPhase).toBe("selecting");
});
