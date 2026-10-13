// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import SettingsPage from "../app/settings/page";
import { DEFAULT_MODEL } from "../lib/agent/defaults";
import { byokFromEnv, resolveSavedByok } from "../lib/agent/provider";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  document.body.innerHTML = "";
});

test("设置页默认模型、推荐文案与当前 README 保持一致", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ settings: {}, keySource: "none" }));
  const readme = readFileSync(resolve(__dirname, "../README.md"), "utf8");
  const documented = readme.match(/\*\*模型名\*\*：推荐 `([^`]+)`（设置页默认值）/);
  expect(documented?.[1]).toBe(DEFAULT_MODEL);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(SettingsPage)));
    expect(container.querySelector<HTMLInputElement>("#model")!.value).toBe(DEFAULT_MODEL);
    expect(container.querySelector<HTMLInputElement>("#model")!.placeholder).toBe(`例如 ${DEFAULT_MODEL}`);
    const recommendation = Array.from(container.querySelectorAll("p")).find(p => p.textContent?.startsWith("讲解推荐 "));
    expect(recommendation?.textContent?.match(/^讲解推荐 (.+?)。/)?.[1]).toBe(documented?.[1]);
  } finally { await act(async () => root.unmount()); }
});

test("服务端环境 Key 和已保存 Key 未指定模型时使用相同默认值", () => {
  vi.stubEnv("AI_MODEL", "");
  vi.stubEnv("AI_PROVIDER", "openai-compatible");
  vi.stubEnv("AI_API_KEY", "fixture-env-key");
  vi.stubEnv("AI_BASE_URL", "https://env.example.invalid/v1");
  expect(byokFromEnv()?.model).toBe(DEFAULT_MODEL);
  expect(resolveSavedByok({
    apiKey: "fixture-saved-key",
    provider: "openai-compatible",
    baseURL: "https://saved.example.invalid/v1",
    baseURLProvider: "openai-compatible",
  })?.config.model).toBe(DEFAULT_MODEL);
});
