// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import SettingsPage from "../app/settings/page";

// 表单测试不启用保存勾选动画，避免 DOM 模拟器在卸载时产生动画取消拒绝。
vi.mock("motion/react", () => ({ motion: {
  svg: "svg", path: () => null,
  span: ({ children, className }: { children?: ReactNode; className?: string }) => createElement("span", { className }, children),
} }));

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.innerHTML = ""; });

test.each([{}, { provider: "google", model: "old-model", baseURL: "https://api.openai.com/v1" }])("设置页仅保存用户编辑的模型，不隐式保存默认接口或空 Key：%j", async saved => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const writes: Record<string, string>[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
    if (init?.method === "PUT") { writes.push(JSON.parse(String(init.body)).settings); return Response.json({ ok: true }); }
    return Response.json({ settings: saved, keySource: "env" });
  });
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(SettingsPage)); });
    const clickSave = async () => { await act(async () => {
      const button = Array.from(container.querySelectorAll("button")).find(b => b.textContent?.includes("保存设置") || b.textContent?.includes("已保存"))!;
      button.click();
    }); };
    await clickSave();
    expect(writes[0]).toEqual({});
    const model = container.querySelector<HTMLInputElement>("#model")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(model, "new-model");
      model.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await clickSave();
    expect(writes[1]).toEqual({ model: "new-model" });
    expect(writes.every(w => !("apiKey" in w) && !("baseURL" in w) && !("provider" in w))).toBe(true);
  } finally { await act(async () => root.unmount()); }
});

test("切换 provider 清空旧代理，测试连接不会把新 Key 送到旧地址", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const hints: { byok: Record<string, string> }[] = [];
  const writes: Record<string, string>[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (String(input).endsWith("/api/hint")) { hints.push(JSON.parse(String(init?.body))); return Response.json({ hint: "mock" }); }
    if (init?.method === "PUT") { writes.push(JSON.parse(String(init.body)).settings); return Response.json({ ok: true }); }
    return Response.json({ settings: { provider: "openai-compatible", model: "old-model", baseURL: "https://old-proxy.invalid/v1" }, keySource: "settings" });
  });
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(SettingsPage)));
    expect(container.querySelector<HTMLInputElement>("#baseURL")!.value).toContain("old-proxy");
    await act(async () => container.querySelector<HTMLInputElement>("#provider-google")!.click());
    expect(container.querySelector<HTMLInputElement>("#baseURL")!.value).toBe("");
    await act(async () => {
      const input = container.querySelector<HTMLInputElement>("#apiKey")!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "fake-new-key");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => Array.from(container.querySelectorAll("button")).find(b => b.textContent?.includes("测试连接"))!.click());
    expect(hints[0].byok).toMatchObject({ provider: "google", apiKey: "fake-new-key" });
    expect(hints[0].byok.baseURL).toBeUndefined();
    await act(async () => Array.from(container.querySelectorAll("button")).find(b => b.textContent?.includes("保存设置"))!.click());
    expect(writes[0]).toMatchObject({ provider: "google", baseURL: "" });
  } finally { await act(async () => root.unmount()); }
});
