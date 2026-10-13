// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import SettingsPage from "../app/settings/page";
import { NO_BYOK_SETTINGS_MESSAGE } from "../lib/byok/client";

// 表单测试不启用保存勾选动画，避免 DOM 模拟器在卸载时产生动画取消拒绝。
vi.mock("motion/react", () => ({ motion: {
  svg: "svg", path: () => null,
  span: ({ children, className }: { children?: ReactNode; className?: string }) => createElement("span", { className }, children),
} }));

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.innerHTML = ""; });

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
    if (String(input).endsWith("/api/settings/test-connection")) { hints.push(JSON.parse(String(init?.body))); return Response.json({ ok: true }); }
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
    if (String(input).endsWith("/api/settings/test-connection")) { hints.push(JSON.parse(String(init?.body))); return Response.json({ ok: true }); }
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

test.each([
  ["保存设置", "file:///tmp/model", false],
  ["保存设置", "http://127.0.0.1:3396/v1", true],
  ["保存设置", "https://private-dns.example/v1", false],
  ["测试连接", "ftp://x", false],
  ["测试连接", "http://169.254.169.254", true],
  ["测试连接", "https://private-dns.example/v1", false],
] as const)("%s 拒绝 %s：持久行内提示，有新 Key：%s", async (action, baseURL, newKey) => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const { root, container, type } = await renderWith({ settings: {}, keySource: "settings" });
  const isInvalidFormat = !/^https?:\/\//i.test(baseURL);
  const expectedMessage = isInvalidFormat
    ? "接口地址格式不对，要以 http:// 或 https:// 开头"
    : "接口地址只支持公网 http(s) 地址";
  try {
    const input = container.querySelector<HTMLInputElement>("#baseURL")!;
    await type("baseURL", baseURL);
    if (isInvalidFormat) {
      await act(async () => { input.focus(); input.blur(); });
      expect(container.querySelector("#baseURL-error")?.textContent).toBe(expectedMessage);
      expect(document.activeElement).toBe(input);
      await type("baseURL", `${baseURL} `);
      await type("baseURL", baseURL);
      expect(container.querySelector("#baseURL-error")).toBeNull();
    }
    if (newKey) await type("apiKey", "test-only-credential");
    const blockedOnClient = action === "保存设置" && isInvalidFormat;
    if (!blockedOnClient) {
      vi.mocked(globalThis.fetch).mockResolvedValueOnce(Response.json({ error: "BASE_URL_NOT_ALLOWED", message: "接口地址只支持公网 http(s) 地址" }, { status: 400 }));
    }
    await act(async () => Array.from(container.querySelectorAll("button")).find(b => b.textContent?.includes(action))!.click());
    const finalMessage = blockedOnClient ? "接口地址格式不对，要以 http:// 或 https:// 开头" : "接口地址只支持公网 http(s) 地址";
    if (blockedOnClient) {
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    } else {
      const [path, init] = vi.mocked(globalThis.fetch).mock.lastCall!;
      expect(String(path)).toContain(action === "保存设置" ? "/api/settings" : "/api/settings/test-connection");
      expect(JSON.parse(String(init?.body))[action === "保存设置" ? "settings" : "byok"].baseURL).toBe(baseURL);
      expect(globalThis.fetch).toHaveBeenCalledTimes(2); // No refresh after a rejected PUT.
    }
    const error = container.querySelector("#baseURL-error")!;
    expect(error.textContent).toBe(finalMessage);
    expect(error.parentElement).toBe(input.parentElement);
    expect(error.getAttribute("role")).toBe("alert");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toContain("baseURL-error");
    expect(document.activeElement).toBe(input);
    expect(container.querySelector("#baseURL-policy")!.textContent).toContain("需要公网 http(s) 地址");
    expect(container.querySelector("#baseURL-policy")!.textContent).toContain("自托管");
    expect(container.textContent).not.toContain("已保存");
    await act(async () => vi.advanceTimersByTime(30_000));
    await type("model", "another-model");
    expect(container.querySelector("#baseURL-error")?.textContent).toBe(finalMessage);
    expect(container.textContent).not.toContain("已保存");
    await type("baseURL", "https://public.example/v1");
    expect(container.querySelector("#baseURL-error")).toBeNull();
  } finally { await act(async () => root.unmount()); }
});

test("openai-compatible 接口地址留空：新 Key 提示使用官方默认地址，填写后提示消失", async () => {
  const { root, type, hint, container } = await renderWith({ settings: {}, keySource: "none" });
  try {
    expect(hint()).toContain("https://api.openai.com/v1");
    expect(container.querySelector("#baseURL")!.getAttribute("aria-describedby")).toBe("baseURL-policy baseURL-hint");
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
    expect(input.classList.contains("font-sans")).toBe(false);
    expect(input.classList.contains("font-mono")).toBe(false);
    expect(input.classList.contains("tracking-normal")).toBe(true);
    expect(input.classList.contains("[font-variant-ligatures:none]")).toBe(true);
    await type("baseURL", "https://proxy.example/v1");
    expect(input.value).toBe("https://proxy.example/v1");
  } finally { await act(async () => root.unmount()); }
});

test("设置页 API Key 相关文案：顶栏说明、表单说明、占位符、显隐按钮与清除按钮", async () => {
  const { root, container } = await renderWith({
    settings: { provider: "openai-compatible", apiKeyMasked: "••••-key" },
    keySource: "settings",
  });
  try {
    expect(container.textContent).toContain("AlgoStage 自己不带 AI，需要接上一个你自己的 AI 账号，老师才能给其余的题备课。你的 API Key 只存在这台电脑上，不会发给任何人。");
    expect(container.textContent).toContain("只保存你改动的字段。使用环境变量里的 API Key 时，接口地址和服务商也沿用环境变量；可单独修改模型名。保存新 API Key 时，请同时填写对应接口地址和服务商。");
    expect(container.textContent).toContain("API Key 来源：设置页");
    expect(container.querySelector<HTMLInputElement>("#baseURL")!.placeholder).toBe("用环境变量里的 API Key 时沿用环境地址；新 API Key 留空使用默认地址");
    expect(container.querySelector<HTMLInputElement>("#apiKey")!.placeholder).toBe("输入新的 API Key 以更换");
    const toggleBtn = container.querySelector<HTMLButtonElement>('button[aria-label="显示 API Key"]')!;
    expect(toggleBtn).not.toBeNull();
    await act(async () => { toggleBtn.click(); });
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="隐藏 API Key"]')).not.toBeNull();
    expect(Array.from(container.querySelectorAll("button")).some(b => b.textContent === "清除已保存的 API Key，改用环境变量（保存后生效）")).toBe(true);
  } finally { await act(async () => root.unmount()); }
});

test("测试连接无 API Key：聚焦 #apiKey，下一帧在 [role=status] 显示文案且全页仅一份，无红色失败与 ✗，输入 API Key 时清空", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url.endsWith("/api/settings")) {
      return Response.json({ settings: {}, keySource: "none" });
    }
    if (url.endsWith("/api/settings/test-connection")) {
      return Response.json({ code: "NO_BYOK", error: "NO_BYOK" }, { status: 400 });
    }
    return Response.json({ ok: true });
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(createElement(SettingsPage));
    });
    const apiKeyInput = container.querySelector<HTMLInputElement>("#apiKey")!;
    const testBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("测试连接"),
    )!;
    await act(async () => {
      testBtn.click();
    });

    expect(document.activeElement).toBe(apiKeyInput);

    await act(async () => {
      await new Promise<void>((resolve) => {
        if (typeof requestAnimationFrame === "function") {
          requestAnimationFrame(() => resolve());
        } else {
          setTimeout(resolve, 0);
        }
      });
    });

    const occurrences = (
      document.body.textContent?.match(new RegExp(NO_BYOK_SETTINGS_MESSAGE, "g")) || []
    ).length;
    expect(occurrences).toBe(1);

    const statusEl = document.body.querySelector<HTMLElement>("#settings-status");
    expect(statusEl).not.toBeNull();
    expect(statusEl?.getAttribute("role")).toBe("status");
    expect(statusEl?.textContent).toBe(NO_BYOK_SETTINGS_MESSAGE);
    expect(
      Array.from(document.body.querySelectorAll('[role="status"]')).some(
        (el) => el.textContent?.includes(NO_BYOK_SETTINGS_MESSAGE),
      ),
    ).toBe(true);

    const roseElements = Array.from(document.body.querySelectorAll(".text-beam-rose"));
    for (const el of roseElements) {
      expect(el.textContent).not.toContain(NO_BYOK_SETTINGS_MESSAGE);
    }
    expect(document.body.textContent).not.toContain("✗");

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(apiKeyInput, "sk-typing");
      apiKeyInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(statusEl?.textContent).toBe("");
    expect(document.body.textContent).not.toContain(NO_BYOK_SETTINGS_MESSAGE);
  } finally {
    await act(async () => root.unmount());
  }
});

test("serverKeyDisabled 模式下「保存设置」「测试连接」「清除本机 API Key」按钮均包含 pointer-coarse:min-h-11 类名", async () => {
  const { root, container } = await renderWith({
    settings: {},
    keySource: "none",
    serverKeyDisabled: true,
  });
  try {
    const buttons = Array.from(container.querySelectorAll("button"));
    const saveBtn = buttons.find((b) => b.textContent?.includes("保存设置") || b.textContent?.includes("已保存"));
    const testBtn = buttons.find((b) => b.textContent?.includes("测试连接"));
    const clearBtn = buttons.find((b) => b.textContent?.includes("清除本机 API Key"));

    expect(saveBtn).toBeDefined();
    expect(testBtn).toBeDefined();
    expect(clearBtn).toBeDefined();

    expect(saveBtn?.className).toContain("pointer-coarse:min-h-11");
    expect(testBtn?.className).toContain("pointer-coarse:min-h-11");
    expect(clearBtn?.className).toContain("pointer-coarse:min-h-11");
  } finally {
    await act(async () => root.unmount());
  }
});

test("构建时静态检查：app/settings/page.tsx 中「保存设置」「测试连接」「清除本机 API Key」「显示/隐藏 API Key」「讲课语速」「导出学习记录」直接包含 pointer-coarse:min-h-11 类名", () => {
  const source = readFileSync(resolve(__dirname, "../app/settings/page.tsx"), "utf8");
  expect(source).toContain("pointer-coarse:min-h-11");
  const occurrences = (source.match(/pointer-coarse:min-h-11/g) || []).length;
  expect(occurrences).toBe(7);
});



