// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import NarrationBar from "../components/board/narration-bar";
import { roadmapOrder } from "../lib/content/roadmap-order";
import { usePlayerStore } from "../lib/player/store";
import type { TeachingScript } from "../lib/teaching/types";

const sentences = ["第一句从头解释算法，之后再介绍代码。", "第二句说明为什么需要使用哈希表。"]; 
const script: TeachingScript = {
  problemSlug: "two-sum", mode: "lecture", language: "zh", solutionLanguage: "typescript",
  steps: sentences.map((narration, i) => ({ id: `s${i + 1}`, narration, targets: [{ kind: "code-line", start: i + 1 }], effects: [], dwellMs: 5000 })),
};
let root: Root, container: HTMLDivElement;
const visible = () => container.querySelectorAll("p")[1].textContent;
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  usePlayerStore.getState().reset(); usePlayerStore.getState().loadScript(script);
  container = document.createElement("div"); document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  usePlayerStore.getState().setAutoAdvance(false);
  localStorage.clear();
  usePlayerStore.getState().reset(); container.remove();
  vi.useRealTimers(); vi.unstubAllGlobals();
});

test.each(["paused", "interrupted", "idle"] as const)("%s 状态切步骤立即显示整句", async status => {
  usePlayerStore.setState({ status });
  await act(async () => root.render(createElement(NarrationBar)));
  expect(visible()).toBe(sentences[0]);
  await act(async () => usePlayerStore.getState().goto(1));
  expect(visible()).toBe(sentences[1]);
  await act(async () => vi.advanceTimersByTimeAsync(500));
  expect(visible()).toBe(sentences[1]);
});

test("手动暂停补全正在打字的句子，恢复播放不重新打字", async () => {
  usePlayerStore.getState().play();
  await act(async () => root.render(createElement(NarrationBar)));
  expect(visible()).toBe("");
  await act(async () => vi.advanceTimersByTimeAsync(250));
  expect(visible()!.length).toBeGreaterThan(0);
  expect(visible()!.length).toBeLessThan(sentences[0].length);
  await act(async () => usePlayerStore.getState().pause());
  expect(visible()).toBe(sentences[0]);
  await act(async () => usePlayerStore.getState().play());
  expect(visible()).toBe(sentences[0]);
});

test("仅 playing 切到新步骤时清零，随后继续逐字显示", async () => {
  usePlayerStore.getState().play();
  await act(async () => root.render(createElement(NarrationBar)));
  await act(async () => vi.advanceTimersByTimeAsync(250));
  await act(async () => usePlayerStore.getState().goto(1));
  expect(visible()).toBe("");
  await act(async () => vi.advanceTimersByTimeAsync(250));
  expect(visible()!.length).toBeGreaterThan(0);
  expect(visible()!.length).toBeLessThan(sentences[1].length);
});

/** 24 字/秒、每拍 +1.2 字；打完第一句（含收尾一拍）后再多等 extraMs。 */
async function finishTyping(extraMs = 0) {
  const ticks = (Math.ceil(sentences[0].length / 1.2) + 1) * 50;
  await act(async () => vi.advanceTimersByTimeAsync(ticks + extraMs));
}

test("默认 autoAdvance 为 false：打完停留在第 0 步并提示按空格继续", async () => {
  expect(usePlayerStore.getState().autoAdvance).toBe(false);
  usePlayerStore.getState().play();
  await act(async () => root.render(createElement(NarrationBar)));
  await finishTyping(10000);
  expect(usePlayerStore.getState().currentIndex).toBe(0);
  expect(usePlayerStore.getState().awaitingContinue).toBe(true);
  expect(container.textContent).toContain("按空格继续");
  expect(visible()).toBe(sentences[0]);
});

test("流式停在最后一步且等待继续时提示下一步准备中", async () => {
  usePlayerStore.setState({ receiving: true, currentIndex: sentences.length - 1, awaitingContinue: true });
  await act(async () => root.render(createElement(NarrationBar)));
  const hint = container.querySelector("[data-testid='continue-hint']");
  expect(hint?.textContent).toBe("下一步准备中…");
  expect(container.textContent).not.toContain("按空格继续");
  expect(container.querySelector("button")).toBeNull();
});

function stubPointer(coarse: boolean) {
  const original = window.matchMedia.bind(window);
  vi.stubGlobal("matchMedia", (query: string) => {
    if (query !== "(pointer: coarse)") return original(query);
    return {
      matches: coarse,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    };
  });
}

test("粗指针等待继续时字幕条不渲染点「下一步」继续，也没有下一步按钮", async () => {
  stubPointer(true);
  usePlayerStore.setState({ status: "playing", awaitingContinue: true });
  await act(async () => root.render(createElement(NarrationBar)));
  expect(container.querySelector("[data-testid='continue-hint']")).toBeNull();
  expect(container.textContent).not.toContain("点「下一步」继续");
  expect(container.querySelector("button")).toBeNull();
});

test("细指针等待继续时提示按空格继续，字幕条没有下一步按钮", async () => {
  stubPointer(false);
  usePlayerStore.setState({ status: "playing", awaitingContinue: true });
  await act(async () => root.render(createElement(NarrationBar)));
  const hint = container.querySelector("[data-testid='continue-hint']");
  expect(hint?.textContent).toBe("按空格继续");
  expect(container.querySelector("button")).toBeNull();
});

test("流式准备中优先于粗指针提示，字幕条没有下一步按钮", async () => {
  stubPointer(true);
  usePlayerStore.setState({ receiving: true, currentIndex: sentences.length - 1, awaitingContinue: true });
  await act(async () => root.render(createElement(NarrationBar)));
  const hint = container.querySelector("[data-testid='continue-hint']");
  expect(hint?.textContent).toBe("下一步准备中…");
  expect(container.textContent).not.toContain("点「下一步」继续");
  expect(container.textContent).not.toContain("按空格继续");
  expect(container.querySelector("button")).toBeNull();
});

test("setAutoAdvance(true) 打完并停留 dwellMs 后进入下一步", async () => {
  usePlayerStore.getState().setAutoAdvance(true);
  usePlayerStore.getState().play();
  await act(async () => root.render(createElement(NarrationBar)));
  await finishTyping(0);
  expect(visible()).toBe(sentences[0]);
  expect(usePlayerStore.getState().currentIndex).toBe(0);
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(usePlayerStore.getState().currentIndex).toBe(1);
});

test("finished 显示讲完了，two-sum 下一题指向 group-anagrams，并有重播和回路线图", async () => {
  usePlayerStore.setState({ status: "finished", currentIndex: 1 });
  await act(async () => root.render(createElement(NarrationBar)));
  expect(container.textContent).toContain("讲完了");
  const nextLink = [...container.querySelectorAll("a")].find((el) => el.textContent === "下一题");
  expect(nextLink?.getAttribute("href")).toMatch(/\/problem\/group-anagrams$/);
  const roadmap = [...container.querySelectorAll("a")].find((el) => el.textContent === "回路线图");
  expect(roadmap?.getAttribute("href")).toBe("/roadmap");
  const button = [...container.querySelectorAll("button")].find((el) => el.textContent === "重播");
  expect(button).toBeTruthy();
  await act(async () => button!.click());
  expect(usePlayerStore.getState().status).toBe("playing");
  expect(usePlayerStore.getState().currentIndex).toBe(0);
});

test("末题 finished 主按钮是回路线图，没有下一题", async () => {
  const lastSlug = roadmapOrder().at(-1)!.slug;
  usePlayerStore.setState({
    status: "finished",
    currentIndex: 1,
    script: { ...usePlayerStore.getState().script!, problemSlug: lastSlug },
  });
  await act(async () => root.render(createElement(NarrationBar)));
  expect(container.textContent).toContain("讲完了");
  const links = [...container.querySelectorAll("a")];
  expect(links.map((el) => el.textContent)).toEqual(["回路线图"]);
  expect(links[0]?.getAttribute("href")).toBe("/roadmap");
  expect(container.textContent).not.toContain("下一题");
  expect([...container.querySelectorAll("button")].some((el) => el.textContent === "重播")).toBe(true);
});
