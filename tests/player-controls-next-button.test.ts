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

test("等待继续时下一步是实心主按钮，没有脉冲和描边", async () => {
  usePlayerStore.getState().loadScript(script);
  usePlayerStore.setState({ awaitingContinue: true });

  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(createElement(PlayerControls));
  });

  const button = container.querySelector<HTMLButtonElement>('button[data-awaiting="true"]');
  expect(button).not.toBeNull();
  expect(button!.textContent).toContain("下一步");
  expect(button!.classList.contains("animate-pulse")).toBe(false);
  expect([...button!.classList].some((name) => name.startsWith("ring"))).toBe(false);
  expect(button!.className).toContain("bg-beam-gold");
  expect(button!.className).toContain("text-on-accent");
  expect(button!.className).toContain("hover:brightness-110");
});
