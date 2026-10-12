// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { localSeedSource } from "../lib/content/local-source";
import { usePlayerStore } from "../lib/player/store";
import { draftLanguage, readDraft, saveDraft } from "../lib/player/drafts";

const params = vi.hoisted(() => ({ slug: "3sum" }));
vi.mock("next/navigation", () => ({ useParams: () => params }));
vi.mock("../components/board/code-editor", () => ({ default: ({ value, readOnly, onChange }: { value: string; readOnly: boolean; onChange: (value: string) => void }) => createElement("textarea", { "data-editor": true, value, readOnly, onChange: (e: { currentTarget: HTMLTextAreaElement }) => onChange(e.currentTarget.value) }) }));
vi.mock("../components/effects/effect-stage", () => ({ default: () => null }));
vi.mock("../components/judge/judge-controls", () => ({ default: ({ onLanguage }: { onLanguage: (language: string) => void }) => createElement("div", {}, ...["typescript", "python"].map(language => createElement("button", { key: language, onClick: () => onLanguage(language) }, `语言 ${language}`))) }));
import ProblemPage from "../app/problem/[slug]/page";

let root: Root, container: HTMLDivElement;
const editor = () => container.querySelector<HTMLTextAreaElement>("[data-editor]")!;
const click = async (text: string) => act(async () => Array.from(container.querySelectorAll("button")).find(b => b.textContent === text)!.click());
const enter = async (value: string) => act(async () => {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(editor(), value);
  editor().dispatchEvent(new Event("input", { bubbles: true }));
});
beforeEach(() => {
  params.slug = "3sum";
  window.sessionStorage.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  usePlayerStore.getState().reset();
  container = document.createElement("div"); document.body.append(container);
  root = createRoot(container);
  vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
    const path = String(input);
    if (path.endsWith("/api/settings")) return Response.json({ keySource: "env" });
    const slug = path.match(/\/api\/problems\/([^/]+)$/)?.[1];
    if (slug) return Response.json({ problem: await localSeedSource.detail(slug) });
    return Response.json({ ok: true });
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove(); usePlayerStore.getState().reset(); window.sessionStorage.clear();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

test.each(["// 学生尚未写完的解法\nconst draft = 42;", ""])("切换浏览器标签和重新挂载后恢复草稿，空草稿也保留：%j", async draft => {
  await act(async () => root.render(createElement(ProblemPage)));
  await click("练习"); await enter(draft);
  await act(async () => { window.dispatchEvent(new Event("blur")); document.dispatchEvent(new Event("visibilitychange")); window.dispatchEvent(new Event("focus")); document.dispatchEvent(new Event("visibilitychange")); });
  expect(editor().value).toBe(draft);
  await act(async () => root.unmount()); root = createRoot(container);
  await act(async () => root.render(createElement(ProblemPage)));
  expect(editor().value).toBe(draft);
  expect(editor().readOnly).toBe(false);
});

test("听课/练习与语言切换都保留独立草稿，参考代码不覆盖学生代码", async () => {
  await act(async () => root.render(createElement(ProblemPage)));
  await click("练习"); await enter("// TypeScript 草稿");
  await click("语言 python"); await enter("# Python 草稿");
  await click("语言 typescript"); expect(editor().value).toBe("// TypeScript 草稿");
  await click("听课");
  expect(editor().value).toContain("nums.sort");
  await click("练习"); expect(editor().value).toBe("// TypeScript 草稿");
  await click("语言 python"); expect(editor().value).toBe("# Python 草稿");
  await act(async () => root.unmount()); root = createRoot(container);
  await act(async () => root.render(createElement(ProblemPage)));
  expect(editor().value).toBe("# Python 草稿");
  expect(draftLanguage("3sum")).toBe("python");
});

test("切题后晚到的旧题响应不能覆盖新题草稿", async () => {
  let resolveOld!: (response: Response) => void;
  const old = new Promise<Response>(resolve => { resolveOld = resolve; });
  const normalFetch = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation((input, init) => String(input).endsWith("/api/problems/3sum") ? old : normalFetch(input, init));
  await act(async () => root.render(createElement(ProblemPage)));
  params.slug = "two-sum";
  await act(async () => root.render(createElement(ProblemPage)));
  await click("练习"); await enter("// 新题草稿");
  await act(async () => resolveOld(Response.json({ problem: await localSeedSource.detail("3sum") })));
  expect(editor().value).toBe("// 新题草稿");
  expect(container.querySelector("h1")?.textContent).toContain("两数之和");
});

test("题面尚未返回时写下的草稿，也不会被随后返回的参考代码覆盖", async () => {
  let complete!: (response: Response) => void;
  const delayed = new Promise<Response>(resolve => { complete = resolve; });
  const normalFetch = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation((input, init) => String(input).endsWith("/api/problems/3sum") ? delayed : normalFetch(input, init));
  await act(async () => root.render(createElement(ProblemPage)));
  await click("练习"); await enter("// 提前开始的草稿");
  await act(async () => complete(Response.json({ problem: await localSeedSource.detail("3sum") })));
  expect(editor().value).toBe("// 提前开始的草稿");
  expect(editor().readOnly).toBe(false);
});

test("存储不可写时草稿仍保留在当前页面会话，不抛错", () => {
  const blocked = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("storage unavailable"); });
  saveDraft("storage-blocked", "python", "# 未完成");
  expect(readDraft("storage-blocked", "python")).toBe("# 未完成");
  expect(draftLanguage("storage-blocked")).toBe("python");
  blocked.mockRestore();
  saveDraft("storage-blocked", "python", "# 可以写入了");
  expect(readDraft("storage-blocked", "python")).toBe("# 可以写入了");
});
