// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import SettingsPage from "../app/settings/page";

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
