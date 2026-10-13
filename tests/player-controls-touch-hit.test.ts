// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test } from "vitest";
import PlayerControls from "../components/board/player-controls";
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
  expect(speed.map((button) => button.textContent)).toEqual(["0.5x", "1x", "1.5x", "2x"]);
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
  expect(bar!.className).toContain("pointer-coarse:gap-y-6");
});
