// @vitest-environment happy-dom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import StepAnswers from "../components/board/step-answers";
import { ASK_IMAGE_NOT_USED_NOTE } from "../lib/ask/ask-ui-text";
import { usePlayerStore } from "../lib/player/store";
import type { StepAnswer } from "../lib/ask/types";
import type { TeachingScript } from "../lib/teaching/types";

const script: TeachingScript = {
  problemSlug: "two-sum",
  mode: "lecture",
  language: "zh",
  solutionLanguage: "typescript",
  steps: [
    { id: "s1", narration: "第一步讲解。", targets: [], effects: [] },
    { id: "s2", narration: "第二步讲解。", targets: [], effects: [] },
  ],
};

function answer(
  id: string,
  stepId: string,
  question: string,
  narration: string,
  createdAt: string,
  imageAttached?: boolean,
): StepAnswer {
  return {
    v: 1,
    id,
    stepId,
    question,
    selection: { mode: "single", bbox: { x: 0, y: 0, width: 1, height: 1 }, targets: [] },
    segments: [{ id: `${id}-seg`, narration }],
    createdAt,
    ...(imageAttached !== undefined ? { imageAttached } : {}),
  };
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  usePlayerStore.getState().reset();
  usePlayerStore.getState().loadScript(script);
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

async function render() {
  await act(async () => {
    root.render(createElement(StepAnswers, { stepId: "s1" }));
  });
}

test("渲染「你问的」与问题摘要，默认折叠", async () => {
  const stored = answer("a1", "s1", "为什么用哈希表", "因为查找是常数时间。", "2026-10-13T00:00:00.000Z");
  usePlayerStore.getState().setAnswers({ s1: [stored] });
  usePlayerStore.setState({ answersReady: true, askPhase: "idle", status: "paused" });
  await render();
  expect(container.textContent).toContain("你问的");
  expect(container.textContent).toContain("为什么用哈希表");
  expect(container.textContent).not.toContain("因为查找是常数时间。");
  expect(container.textContent).not.toContain("回到这一步");
  const toggle = container.querySelector("button[aria-expanded]");
  expect(toggle?.getAttribute("aria-expanded")).toBe("false");
});

test("answersReady 为 false 时不显示提问展开区与「你问的」", async () => {
  const stored = answer("a1", "s1", "为什么用哈希表", "因为查找是常数时间。", "2026-10-13T00:00:00.000Z");
  usePlayerStore.getState().setAnswers({ s1: [stored] });
  usePlayerStore.setState({ answersReady: false, askPhase: "idle", status: "paused" });
  await render();
  expect(container.querySelector("[data-testid='step-answers']")).toBeNull();
  expect(container.textContent).not.toContain("你问的");
});

test("展开显示全文，再点「回到这一步」收起", async () => {
  const stored = answer("a1", "s1", "为什么用哈希表", "因为查找是常数时间。", "2026-10-13T00:00:00.000Z");
  usePlayerStore.getState().setAnswers({ s1: [stored] });
  usePlayerStore.setState({
    answersReady: true,
    askPhase: "done",
    status: "paused",
    awaitingContinue: true,
    expandedAnswerIds: new Set(["a1"]),
    askContext: {
      stepId: "s1",
      stepIndex: 0,
      prevStatus: "paused",
      prevAwaitingContinue: true,
      answerId: "a1",
      segmentIndex: -1,
      token: null,
    },
  });
  await render();
  expect(container.textContent).toContain("因为查找是常数时间。");
  const back = [...container.querySelectorAll("button")].find((button) => button.textContent === "回到这一步");
  expect(back).toBeTruthy();
  await act(async () => {
    back!.click();
  });
  expect(usePlayerStore.getState().expandedAnswerIds.has("a1")).toBe(false);
  expect(usePlayerStore.getState().askPhase).toBe("done");
  expect(container.textContent).not.toContain("因为查找是常数时间。");
  expect(container.textContent).not.toContain("回到这一步");
});

test("点击展开区不冒泡到外层", async () => {
  const stored = answer("a1", "s1", "问题", "回答全文。", "2026-10-13T00:00:00.000Z");
  usePlayerStore.getState().setAnswers({ s1: [stored] });
  usePlayerStore.setState({ answersReady: true, askPhase: "idle" });
  function Harness() {
    const [hits, setHits] = useState(0);
    return createElement(
      "div",
      { onClick: () => setHits((n) => n + 1) },
      createElement("span", { "data-testid": "hits" }, String(hits)),
      createElement(StepAnswers, { stepId: "s1" }),
    );
  }
  await act(async () => {
    root.render(createElement(Harness));
  });
  const panel = container.querySelector<HTMLElement>("[data-testid='step-answers']")!;
  await act(async () => {
    panel.click();
  });
  expect(container.querySelector("[data-testid='hits']")?.textContent).toBe("0");
});

test("展开且 imageAttached 为 false 时显示提示文案与图标", async () => {
  const stored = answer("a1", "s1", "为什么用哈希表", "因为查找是常数时间。", "2026-10-13T00:00:00.000Z", false);
  usePlayerStore.getState().setAnswers({ s1: [stored] });
  usePlayerStore.setState({
    answersReady: true,
    askPhase: "idle",
    status: "paused",
    expandedAnswerIds: new Set(["a1"]),
  });
  await render();
  const notice = container.querySelector("[data-testid='answer-image-missing']");
  expect(notice).not.toBeNull();
  expect(notice?.hasAttribute("data-answer-image-notice")).toBe(true);
  expect(notice?.textContent).toContain(ASK_IMAGE_NOT_USED_NOTE);
  expect(container.querySelector("[data-answer-image-notice]")).toBe(notice);
  expect(notice?.getAttribute("role")).toBeNull();
  expect(notice?.getAttribute("aria-live")).toBeNull();
});

test("展开且 imageAttached 为 true 时不显示提示", async () => {
  const stored = answer("a1", "s1", "为什么用哈希表", "因为查找是常数时间。", "2026-10-13T00:00:00.000Z", true);
  usePlayerStore.getState().setAnswers({ s1: [stored] });
  usePlayerStore.setState({
    answersReady: true,
    askPhase: "idle",
    status: "paused",
    expandedAnswerIds: new Set(["a1"]),
  });
  await render();
  expect(container.querySelector("[data-testid='answer-image-missing']")).toBeNull();
  expect(container.querySelector("[data-answer-image-notice]")).toBeNull();
});

test("展开且 imageAttached 为 undefined 时不显示提示", async () => {
  const stored = answer("a1", "s1", "为什么用哈希表", "因为查找是常数时间。", "2026-10-13T00:00:00.000Z", undefined);
  usePlayerStore.getState().setAnswers({ s1: [stored] });
  usePlayerStore.setState({
    answersReady: true,
    askPhase: "idle",
    status: "paused",
    expandedAnswerIds: new Set(["a1"]),
  });
  await render();
  expect(container.querySelector("[data-testid='answer-image-missing']")).toBeNull();
  expect(container.querySelector("[data-answer-image-notice]")).toBeNull();
});

test("折叠且 imageAttached 为 false 时不显示提示", async () => {
  const stored = answer("a1", "s1", "为什么用哈希表", "因为查找是常数时间。", "2026-10-13T00:00:00.000Z", false);
  usePlayerStore.getState().setAnswers({ s1: [stored] });
  usePlayerStore.setState({
    answersReady: true,
    askPhase: "idle",
    status: "paused",
    expandedAnswerIds: new Set(),
  });
  await render();
  expect(container.querySelector("[data-testid='answer-image-missing']")).toBeNull();
  expect(container.querySelector("[data-answer-image-notice]")).toBeNull();
});
