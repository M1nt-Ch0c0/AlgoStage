// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test } from "vitest";
import PlayerControls from "../components/board/player-controls";
import type { StepAnswer } from "../lib/ask/types";
import { usePlayerStore } from "../lib/player/store";
import type { TeachingScript } from "../lib/teaching/types";

const script: TeachingScript = {
  problemSlug: "3sum",
  mode: "lecture",
  language: "zh",
  solutionLanguage: "typescript",
  steps: [
    { id: "s1", narration: "第一步", targets: [], effects: [] },
    { id: "s2", narration: "第二步", targets: [], effects: [] },
  ],
};

let root: Root;
let container: HTMLDivElement;

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  container?.remove();
  usePlayerStore.getState().reset();
});

test("粗指针下自动播放、语速和特效强度热区至少 44px，视觉仍是 py-0.5", async () => {
  usePlayerStore.getState().loadScript(script);

  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(createElement(PlayerControls));
  });

  const autoplay = [...container.querySelectorAll("button")].find((el) => el.textContent === "自动播放");
  const speed = [
    ...container.querySelectorAll<HTMLButtonElement>('[role="group"][aria-label="语速"] button'),
  ];
  const levels = [
    ...container.querySelectorAll<HTMLButtonElement>('[role="group"][aria-label="特效强度"] button'),
  ];

  expect(autoplay).toBeTruthy();
  expect(speed.map((button) => button.textContent)).toEqual(["0.5×", "1×", "1.5×", "2×"]);
  expect(levels.map((button) => button.textContent)).toEqual(["华丽", "克制", "极简"]);

  for (const button of [autoplay!, ...speed, ...levels]) {
    expect(button.className).toContain("pointer-coarse:after:h-11");
    expect(button.className).toContain("pointer-coarse:min-w-11");
    expect(button.className).toContain("pointer-coarse:px-1.5");
    expect(button.className).toContain("px-2.5");
    expect(button.className).toContain("relative");
    expect(button.className).toContain("py-0.5");
  }

  const bar = container.querySelector('[data-testid="player-controls"]');
  expect(bar).toBeTruthy();
  expect(bar!.className).toContain("gap-x-4");
  expect(bar!.className).toContain("pointer-coarse:gap-x-2");
  expect(bar!.className).toContain("gap-y-2");
  expect(bar!.className).toContain("pointer-coarse:gap-y-5");
});

test("时间线上的提问标记不另占热区，圆点仍是原来的点按目标", async () => {
  const asked: StepAnswer = {
    v: 1,
    id: "a1",
    stepId: "s1",
    question: "这一步在做什么",
    selection: { mode: "single", bbox: { x: 0, y: 0, width: 8, height: 8 }, targets: [] },
    segments: [{ id: "seg-1", narration: "先看循环" }],
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  usePlayerStore.getState().loadScript(script);
  usePlayerStore.setState({ answers: { s1: [asked, { ...asked, id: "a2" }] }, answersReady: true });

  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(createElement(PlayerControls));
  });

  const marked = container.querySelector<HTMLButtonElement>(
    'button[aria-label="跳到第 1 步，有 2 个提问"]',
  );
  const plain = container.querySelector<HTMLButtonElement>('button[aria-label="跳到第 2 步"]');
  expect(marked).toBeTruthy();
  expect(plain).toBeTruthy();

  for (const dot of [marked!, plain!]) {
    expect(dot.className).toContain("h-5");
    expect(dot.className).toContain("min-w-0");
    expect(dot.className).toContain("flex-1");
    expect(dot.className).toContain("pointer-coarse:h-11");
    expect(dot.className).not.toMatch(/min-w-11|pointer-coarse:min-w|pointer-coarse:w-11/);
    const visual = dot.querySelector("[data-dot-visual]")!;
    expect(visual.className).toContain("h-1.5");
    expect(visual.className).toContain("w-full");
  }

  const mark = marked!.querySelector("[data-answer-mark]");
  expect(mark).toBeTruthy();
  expect(mark!.tagName).not.toBe("BUTTON");
  expect(mark!.getAttribute("aria-hidden")).toBe("true");
  expect(mark!.className).toContain("pointer-events-none");
  expect(marked!.querySelector("[data-dot-visual]")!.contains(mark)).toBe(true);
  expect(plain!.querySelector("[data-answer-mark]")).toBeNull();

  const statuses = [...container.querySelectorAll('[role="status"]')];
  expect(statuses).toHaveLength(0);
});

test("answers 存在但 answersReady:false 时时间线 aria-label 为无提问标记版本", async () => {
  const asked: StepAnswer = {
    v: 1,
    id: "a1",
    stepId: "s1",
    question: "这一步在做什么",
    selection: { mode: "single", bbox: { x: 0, y: 0, width: 8, height: 8 }, targets: [] },
    segments: [{ id: "seg-1", narration: "先看循环" }],
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  usePlayerStore.getState().loadScript(script);
  usePlayerStore.setState({ answers: { s1: [asked, { ...asked, id: "a2" }] }, answersReady: false });

  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(createElement(PlayerControls));
  });

  const dot1 = container.querySelector<HTMLButtonElement>('button[aria-label="跳到第 1 步"]');
  expect(dot1).toBeTruthy();
  expect(container.querySelector('button[aria-label*="提问"]')).toBeNull();
  expect(dot1!.querySelector("[data-answer-mark]")).toBeNull();
});


test("播放器显示 1.5×", async () => {
  usePlayerStore.getState().loadScript(script);

  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(createElement(PlayerControls));
  });

  const speed15 = [...container.querySelectorAll<HTMLButtonElement>('[role="group"][aria-label="语速"] button')].find(
    (button) => button.textContent === "1.5×",
  );
  expect(speed15).toBeDefined();
  expect(speed15?.textContent).toBe("1.5×");
});
