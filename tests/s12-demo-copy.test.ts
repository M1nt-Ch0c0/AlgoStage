// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import path from "node:path";
import { act, createElement, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { usePlayerStore } from "../lib/player/store";

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useParams: () => ({ slug: "two-sum" }),
}));

const rootDir = path.resolve(__dirname, "..");
const read = (f: string) => readFileSync(path.join(rootDir, f), "utf8");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function renderText(Comp: ComponentType<any>, props?: Record<string, unknown>) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(Comp, props ?? null)));
    return container.textContent ?? "";
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
}

afterEach(() => {
  usePlayerStore.getState().reset();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
  document.body.innerHTML = "";
});

test("1. SiteFooter 在 IS_DEMO 下显示体验版不记录学习进度，本地版保持原样", async () => {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_ALGOSTAGE_DEMO", "1");
  const { SiteFooter: DemoFooter } = await import("../components/site-footer");
  const demoText = await renderText(DemoFooter);
  expect(demoText).toContain("体验版不记录学习进度 · 开源免费");
  expect(demoText).not.toContain("学习记录只留在你的电脑上 · 开源免费");

  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_ALGOSTAGE_DEMO", "0");
  const { SiteFooter: LocalFooter } = await import("../components/site-footer");
  const localText = await renderText(LocalFooter);
  expect(localText).toContain("学习记录只留在你的电脑上 · 开源免费");
  expect(localText).not.toContain("体验版不记录学习进度 · 开源免费");
});

test("2. ProblemPage 提示阶梯标题在 IS_DEMO 下改为体验版不记录提示用量", () => {
  const src = read("app/problem/[slug]/page.tsx");
  expect(src).toContain(
    'IS_DEMO ? "体验版不记录提示用量" : "用了几级会记在看板上"',
  );
});

test("3. NarrationBar 空态在 IS_DEMO 下按题目区分两数之和与其他题目，非 Demo 保持原样", async () => {
  usePlayerStore.getState().reset();

  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_ALGOSTAGE_DEMO", "1");
  const { default: DemoNarrationBar } = await import(
    "../components/board/narration-bar"
  );
  const twoSumText = await renderText(DemoNarrationBar, {
    problemSlug: "two-sum",
  });
  expect(twoSumText).toContain(
    "点「开始讲课」，老师说的每句话都会在这里一个字一个字出现。",
  );
  expect(twoSumText).not.toContain(
    "体验版只内置了「两数之和」这一课；其他题目可以先读题、练习，装到自己电脑上接上 AI 就能听讲。",
  );

  const otherText = await renderText(DemoNarrationBar, {
    problemSlug: "group-anagrams",
  });
  expect(otherText).toContain(
    "体验版只内置了「两数之和」这一课；其他题目可以先读题、练习，装到自己电脑上接上 AI 就能听讲。",
  );
  expect(otherText).not.toContain(
    "点「开始讲课」，老师说的每句话都会在这里一个字一个字出现。",
  );

  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_ALGOSTAGE_DEMO", "0");
  const { default: LocalNarrationBar } = await import(
    "../components/board/narration-bar"
  );
  const localText = await renderText(LocalNarrationBar, {
    problemSlug: "group-anagrams",
  });
  expect(localText).toContain(
    "点「开始讲课」，老师说的每句话都会在这里一个字一个字出现。",
  );
  expect(localText).not.toContain(
    "体验版只内置了「两数之和」这一课；其他题目可以先读题、练习，装到自己电脑上接上 AI 就能听讲。",
  );
});

test("4a. ReviewPage 空队列在 IS_DEMO 下追加体验版不记录学习进度说明", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({ cards: [] }),
  );
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_ALGOSTAGE_DEMO", "1");
  const { default: ReviewPage } = await import("../app/review/page");
  const text = await renderText(ReviewPage);
  expect(text).toContain(
    "判题后会安排复习，做对的题会逐渐延长间隔。体验版不记录学习进度，复习安排需要装到自己电脑上使用。",
  );
});

test("4b. LandingPage 复习卡 desc 在 IS_DEMO 下末尾追加体验版不安排复习说明", () => {
  const src = read("app/page.tsx");
  expect(src).toContain(
    "做对的题，过几天老师会再考你一次，就挑你快要忘的时候。（即将上线）",
  );
  expect(src).toContain("体验版不记录学习进度，不会安排复习。");
});

test("5. SettingsPage 顶栏 desc 在 IS_DEMO 下说明仅能切换主题，非 Demo 保持原样", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({ settings: {}, keySource: "none" }),
  );
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_ALGOSTAGE_DEMO", "1");
  const { default: DemoSettingsPage } = await import("../app/settings/page");
  const demoText = await renderText(DemoSettingsPage);
  expect(demoText).toContain(
    "在线体验版里，这里只能切换主题，主题只在你这个浏览器里生效。",
  );

  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_ALGOSTAGE_DEMO", "0");
  const { default: LocalSettingsPage } = await import("../app/settings/page");
  const localText = await renderText(LocalSettingsPage);
  expect(localText).toContain("这些设置只保存在你自己的电脑上。");
});
