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

test.each([
  {},
  { provider: "openai-compatible", model: "saved-model", baseURL: "https://saved-proxy.invalid/v1" },
  { provider: "google", model: "saved-native", baseURL: "https://native-proxy.invalid/v1beta", baseURLProvider: "google" },
])("只填新 Key 也会保存完整连接组，保存与测试采用相同字段：%j", async initial => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const writes: Record<string, string>[] = [];
  const hints: { byok?: Record<string, string> }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (String(input).endsWith("/api/hint")) { hints.push(JSON.parse(String(init?.body))); return Response.json({ hint: "mock" }); }
    if (init?.method === "PUT") { writes.push(JSON.parse(String(init.body)).settings); return Response.json({ ok: true }); }
    return Response.json({ settings: { ...initial, ...(writes.length ? { apiKeyMasked: "••••-key" } : {}) }, keySource: writes.length ? "settings" : "env" });
  });
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  const click = async (text: string) => act(async () => Array.from(container.querySelectorAll("button")).find(b => b.textContent?.includes(text))!.click());
  try {
    await act(async () => root.render(createElement(SettingsPage)));
    await act(async () => {
      const input = container.querySelector<HTMLInputElement>("#apiKey")!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "  fake-new-key  ");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click("测试连接");
    await click("保存设置");
    expect(writes[0]).toEqual({ ...hints[0].byok, baseURL: hints[0].byok?.baseURL ?? "" });
    expect(writes[0].provider).toBe(initial.provider ?? "openai-compatible");
    expect(writes[0].apiKey).toBe("fake-new-key");
    expect(container.querySelector<HTMLInputElement>("#apiKey")!.value).toBe("");
    expect(container.querySelector('label[for="apiKey"]')!.textContent).toBe("API Key已配置 ••••-key");
    await click("测试连接");
    expect(hints[1].byok).toBeUndefined();
  } finally { await act(async () => root.unmount()); }
});

async function renderWith(response: Record<string, unknown>) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json(response));
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  await act(async () => { root.render(createElement(SettingsPage)); });
  const type = async (id: string, value: string) => { await act(async () => {
    const input = container.querySelector<HTMLInputElement>(`#${id}`)!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }); };
  return { container, root, type, hint: () => container.querySelector("#baseURL-hint")?.textContent ?? null };
}

test("openai-compatible 接口地址留空：新 Key 提示使用官方默认地址，填写后提示消失", async () => {
  const { root, type, hint, container } = await renderWith({ settings: {}, keySource: "none" });
  try {
    expect(hint()).toContain("https://api.openai.com/v1");
    expect(container.querySelector("#baseURL")!.getAttribute("aria-describedby")).toBe("baseURL-hint");
    await type("baseURL", "https://api.deepseek.com/v1");
    expect(hint()).toBeNull();
    await type("baseURL", "   ");
    expect(hint()).toContain("https://api.openai.com/v1");
  } finally { await act(async () => root.unmount()); }
});

test("openai-compatible 接口地址留空：环境变量 Key 提示沿用环境地址，输入新 Key 后改为默认地址提示", async () => {
  const { root, type, hint } = await renderWith({ settings: {}, keySource: "env" });
  try {
    expect(hint()).toContain("沿用环境变量");
    await type("apiKey", "sk-new");
    expect(hint()).toContain("https://api.openai.com/v1");
  } finally { await act(async () => root.unmount()); }
});

test("非 openai-compatible 服务商不显示留空提示", async () => {
  const { root, hint } = await renderWith({ settings: { provider: "anthropic" }, keySource: "none" });
  try { expect(hint()).toBeNull(); } finally { await act(async () => root.unmount()); }
});

test("接口地址使用正常字距且禁用连字，读取和编辑均保留 https:// 双斜线", async () => {
  const { root, container, type } = await renderWith({
    settings: { baseURL: "https://api.openai.com/v1" }, keySource: "settings",
  });
  try {
    const input = container.querySelector<HTMLInputElement>("#baseURL")!;
    expect(input.value).toBe("https://api.openai.com/v1");
    expect(input.classList.contains("font-sans")).toBe(true);
    expect(input.classList.contains("font-mono")).toBe(false);
    expect(input.classList.contains("tracking-normal")).toBe(true);
    expect(input.classList.contains("[font-variant-ligatures:none]")).toBe(true);
    await type("baseURL", "https://proxy.example/v1");
    expect(input.value).toBe("https://proxy.example/v1");
  } finally { await act(async () => root.unmount()); }
});
