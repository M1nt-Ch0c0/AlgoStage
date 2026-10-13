// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import AiSetupPrompt from "../components/settings/ai-setup-prompt";
import { localSeedSource } from "../lib/content/local-source";
import { usePlayerStore } from "../lib/player/store";

const params = vi.hoisted(() => {
  vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "/classroom");
  vi.stubEnv("__NEXT_ROUTER_BASEPATH", "/classroom");
  return { slug: "3sum" };
});
vi.mock("next/navigation", () => ({ useParams: () => params }));
vi.mock("../components/landing/demo-board", () => ({ DemoBoard: () => null }));
vi.mock("../components/landing/gesture-cards", () => ({ GestureCards: () => null }));
vi.mock("../components/board/code-editor", () => ({ default: () => null }));
vi.mock("../components/effects/effect-stage", () => ({ default: () => null }));
vi.mock("../components/judge/judge-controls", () => ({ default: () => null }));
import LandingPage from "../app/page";
import ProblemPage from "../app/problem/[slug]/page";

const LANDING_HINT = "两数之和可以直接看 AI 讲解。其他题需要先在设置页填入你自己的 API Key。";
const PROBLEM_HINT = "这道题的 AI 讲解需要你自己的 API Key。";
let keySource: unknown;
let root: Root, container: HTMLDivElement;
const link = (label: string) => Array.from(container.querySelectorAll("a")).find(a => a.textContent === label);
const render = async (Page: typeof LandingPage) => act(async () => root.render(createElement(Page)));

beforeEach(() => {
  keySource = "none";
  params.slug = "3sum";
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  usePlayerStore.getState().reset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
    const path = String(input);
    if (path === "/classroom/api/settings") return Response.json({ keySource });
    const slug = path.match(/^\/classroom\/api\/problems\/([^/]+)$/)?.[1];
    if (slug) return Response.json({ problem: await localSeedSource.detail(slug) });
    return Response.json({ ok: true });
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  usePlayerStore.getState().reset();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe.each([
  { name: "首页", Page: LandingPage, slug: undefined, hint: LANDING_HINT },
  { name: "三数之和", Page: ProblemPage, slug: "3sum", hint: PROBLEM_HINT },
  { name: "字母异位词分组", Page: ProblemPage, slug: "group-anagrams", hint: PROBLEM_HINT },
])("$name 的 API Key 引导", ({ Page, slug, hint }) => {
  test.each(["none", "settings", "env"])("按 keySource=%s 显示提示，链接保留 basePath", async source => {
    keySource = source;
    if (slug) params.slug = slug;
    await render(Page);
    expect(fetch).toHaveBeenCalledWith("/classroom/api/settings", expect.objectContaining({ cache: "no-store" }));
    if (source === "none") {
      expect(container.textContent).toContain(hint);
      expect(link("去设置")?.getAttribute("href")).toBe("/classroom/settings");
      if (slug) expect(link("先看两数之和")?.getAttribute("href")).toBe("/classroom/problem/two-sum");
      else expect(link("先看两数之和")).toBeUndefined();
    } else {
      expect(container.textContent).not.toContain(hint);
      expect(link("去设置")).toBeUndefined();
      expect(link("先看两数之和")).toBeUndefined();
    }
  });

  test("配置 Key 后重新进入页面，提示消失", async () => {
    if (slug) params.slug = slug;
    await render(Page);
    expect(container.textContent).toContain(hint);
    await act(async () => root.render(null));
    keySource = "settings";
    await render(Page);
    expect(container.textContent).not.toContain(hint);
    expect(link("去设置")).toBeUndefined();
  });
});

test.each(["none", "settings", "env"])("两数之和不显示提示：keySource=%s", async source => {
  keySource = source;
  params.slug = "two-sum";
  await render(ProblemPage);
  expect(container.querySelector("h1")?.textContent).toContain("两数之和");
  expect(container.textContent).not.toContain(PROBLEM_HINT);
  expect(container.textContent).not.toContain(LANDING_HINT);
  expect(link("去设置")).toBeUndefined();
  expect(link("先看两数之和")).toBeUndefined();
});

test("设置来源未知时不推断为未配置", async () => {
  for (const keySource of ["settings", "env", null, undefined, "", {}, "unknown"]) {
    vi.mocked(fetch).mockResolvedValue(Response.json({ keySource }));
    await act(async () => root.render(createElement(AiSetupPrompt)));
    expect(container.textContent).toBe("");
    await act(async () => root.render(null));
  }
});

test.each(["http", "network"])("设置请求失败时不显示提示：%s", async failure => {
  if (failure === "http") vi.mocked(fetch).mockResolvedValue(Response.json({ keySource: "none" }, { status: 500 }));
  else vi.mocked(fetch).mockRejectedValue(new Error("offline"));
  await act(async () => root.render(createElement(AiSetupPrompt)));
  expect(container.textContent).toBe("");
});

test("加载中不显示提示，切题后忽略旧设置响应并排除两数之和", async () => {
  let resolveOld!: (response: Response) => void;
  vi.mocked(fetch).mockImplementationOnce(() => new Promise<Response>(resolve => { resolveOld = resolve; }));
  await act(async () => root.render(createElement(AiSetupPrompt, { problemSlug: "3sum" })));
  expect(container.textContent).toBe("");

  keySource = "env";
  await act(async () => root.render(createElement(AiSetupPrompt, { problemSlug: "group-anagrams" })));
  await act(async () => resolveOld(Response.json({ keySource: "none" })));
  expect(container.textContent).toBe("");

  keySource = "none";
  await act(async () => root.render(createElement(AiSetupPrompt, { problemSlug: "3sum" })));
  expect(container.textContent).toContain(PROBLEM_HINT);
  await act(async () => root.render(createElement(AiSetupPrompt, { problemSlug: "two-sum" })));
  expect(container.textContent).toBe("");
});
