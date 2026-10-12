// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
vi.mock("../lib/runtime", async importOriginal => ({ ...await importOriginal<typeof import("../lib/runtime")>(), IS_DEMO: true }));
import SettingsPage from "../app/settings/page";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.innerHTML = ""; });

test("Demo 设置明确不记录学习进度，不提供导出按钮或请求看板", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ settings: {}, keySource: "none" }));
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(SettingsPage)));
    expect(container.textContent).toContain("在线体验版不记录学习进度，也不提供学习数据导出");
    expect(container.textContent).not.toContain("学习记录只跟着这个浏览器走");
    expect(Array.from(container.querySelectorAll("button")).some(button => button.textContent?.includes("导出"))).toBe(false);
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual(["/api/settings"]);
  } finally { await act(async () => root.unmount()); }
});
