// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import SettingsPage from "../app/settings/page";
import PlayerControls from "../components/board/player-controls";
import { readLocalByok } from "../lib/byok/storage";
import {
  EFFECT_LEVEL_KEY,
  SPEED_KEY,
  usePlayerStore,
} from "../lib/player/store";

vi.mock("motion/react", () => ({
  motion: {
    svg: "svg",
    path: () => null,
    span: ({ children, className }: { children?: ReactNode; className?: string }) =>
      createElement("span", { className }, children),
  },
}));

function setInputValue(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function clickSave(container: HTMLElement) {
  await act(async () => {
    const button = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("保存设置") || b.textContent?.includes("已保存"),
    );
    button?.click();
  });
}

function findButton(container: HTMLElement, text: string) {
  return Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes(text));
}

describe("settings prefs single-source (v0.2.2 P2)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    localStorage.clear();
    usePlayerStore.getState().reset();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    localStorage.clear();
    usePlayerStore.getState().reset();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  describe.each([
    { mode: "default", serverKeyDisabled: false },
    { mode: "locked (ALGOSTAGE_DISABLE_SERVER_KEY)", serverKeyDisabled: true },
  ])("$mode mode", ({ serverKeyDisabled }) => {
    test("after save localStorage has values and 「已保存」 shown", async () => {
      const writes: Record<string, unknown>[] = [];
      vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
        if (init?.method === "PUT") {
          writes.push(JSON.parse(String(init.body)));
          return Response.json({ ok: true });
        }
        return Response.json({
          settings: {},
          keySource: serverKeyDisabled ? "none" : "env",
          serverKeyDisabled,
        });
      });

      await act(async () => {
        root.render(createElement(SettingsPage));
      });

      // 选 1.5× 和 克制
      const speed15Btn = findButton(container, "1.5×");
      const effectCalmBtn = findButton(container, "克制");
      expect(speed15Btn).toBeDefined();
      expect(effectCalmBtn).toBeDefined();

      await act(async () => {
        speed15Btn!.click();
      });
      await act(async () => {
        effectCalmBtn!.click();
      });

      await clickSave(container);

      expect(localStorage.getItem(SPEED_KEY)).toBe("1.5");
      expect(localStorage.getItem(EFFECT_LEVEL_KEY)).toBe("calm");
      expect(container.textContent).toContain("已保存");
    });

    test("when setItem throws failure copy shown, no 「已保存」, no crash, Key not saved/PUT not sent", async () => {
      let putCalled = false;
      vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
        if (init?.method === "PUT") {
          putCalled = true;
          return Response.json({ ok: true });
        }
        return Response.json({
          settings: {},
          keySource: serverKeyDisabled ? "none" : "env",
          serverKeyDisabled,
        });
      });

      await act(async () => {
        root.render(createElement(SettingsPage));
      });

      // 输入 API Key
      const apiKeyInput = container.querySelector<HTMLInputElement>("#apiKey")!;
      await act(async () => {
        setInputValue(apiKeyInput, "sk-test-failing-save");
      });

      // 模拟 setItem 抛错（例如存储配额满或隐私模式禁用本地存储）
      const setItemSpy = vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
        throw new Error("QuotaExceededError");
      });

      try {
        await clickSave(container);

        // 显示失败文案
        expect(container.textContent).toContain("没保存成功，请确认浏览器允许本地存储后再试。");
        // 不显示「已保存」
        expect(container.textContent).not.toContain("已保存");
        // 默认模式不发 PUT
        expect(putCalled).toBe(false);
        // 锁定模式不写本地 BYOK
        expect(readLocalByok()).toBeNull();
      } finally {
        setItemSpy.mockRestore();
      }
    });

    test("GET returning narrationSpeed '15' and effectLevel 'minimal' is ignored (shows 1× and 华丽)", async () => {
      vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
        return Response.json({
          settings: {
            narrationSpeed: "15",
            effectLevel: "minimal",
          },
          keySource: serverKeyDisabled ? "none" : "env",
          serverKeyDisabled,
        });
      });

      await act(async () => {
        root.render(createElement(SettingsPage));
      });

      const defaultSpeedBtn = findButton(container, "1×（默认）");
      const fullEffectBtn = findButton(container, "华丽");
      const slowSpeedBtn = findButton(container, "0.5×");
      const minimalEffectBtn = findButton(container, "极简");

      expect(defaultSpeedBtn?.getAttribute("aria-pressed")).toBe("true");
      expect(fullEffectBtn?.getAttribute("aria-pressed")).toBe("true");
      expect(slowSpeedBtn?.getAttribute("aria-pressed")).toBe("false");
      expect(minimalEffectBtn?.getAttribute("aria-pressed")).toBe("false");
    });

    test("storage event updates the settings page", async () => {
      vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
        return Response.json({
          settings: {},
          keySource: serverKeyDisabled ? "none" : "env",
          serverKeyDisabled,
        });
      });

      await act(async () => {
        root.render(createElement(SettingsPage));
      });

      // 默认状态：1× 和 华丽
      expect(findButton(container, "1×（默认）")?.getAttribute("aria-pressed")).toBe("true");
      expect(findButton(container, "华丽")?.getAttribute("aria-pressed")).toBe("true");

      // SPEED_KEY 变更
      localStorage.setItem(SPEED_KEY, "2");
      await act(async () => {
        window.dispatchEvent(new StorageEvent("storage", { key: SPEED_KEY }));
      });
      expect(findButton(container, "2×")?.getAttribute("aria-pressed")).toBe("true");
      expect(findButton(container, "1×（默认）")?.getAttribute("aria-pressed")).toBe("false");

      // EFFECT_LEVEL_KEY 变更
      localStorage.setItem(EFFECT_LEVEL_KEY, "calm");
      await act(async () => {
        window.dispatchEvent(new StorageEvent("storage", { key: EFFECT_LEVEL_KEY }));
      });
      expect(findButton(container, "克制")?.getAttribute("aria-pressed")).toBe("true");
      expect(findButton(container, "华丽")?.getAttribute("aria-pressed")).toBe("false");

      // key 为 null（多标签页清理等）
      localStorage.setItem(SPEED_KEY, "0.5");
      localStorage.setItem(EFFECT_LEVEL_KEY, "minimal");
      await act(async () => {
        window.dispatchEvent(new StorageEvent("storage", { key: null }));
      });
      expect(findButton(container, "0.5×")?.getAttribute("aria-pressed")).toBe("true");
      expect(findButton(container, "极简")?.getAttribute("aria-pressed")).toBe("true");
    });
  });

  test("default PUT body lacks narrationSpeed/effectLevel", async () => {
    let capturedSettings: Record<string, unknown> | null = null;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      if (init?.method === "PUT") {
        capturedSettings = JSON.parse(String(init.body)).settings;
        return Response.json({ ok: true });
      }
      return Response.json({
        settings: {},
        keySource: "env",
        serverKeyDisabled: false,
      });
    });

    await act(async () => {
      root.render(createElement(SettingsPage));
    });

    // 改语速、特效与模型名
    await act(async () => {
      findButton(container, "2×")!.click();
      findButton(container, "极简")!.click();
    });

    const modelInput = container.querySelector<HTMLInputElement>("#model")!;
    await act(async () => {
      setInputValue(modelInput, "custom-model");
    });

    await clickSave(container);

    expect(capturedSettings).not.toBeNull();
    const resultSettings = capturedSettings as unknown as Record<string, unknown>;
    expect("narrationSpeed" in resultSettings).toBe(false);
    expect("effectLevel" in resultSettings).toBe(false);
    expect(resultSettings.model).toBe("custom-model");
  });

  test("player-controls listener updates store on storage event", async () => {
    usePlayerStore.setState({ speed: 1, effectLevel: "full" });

    await act(async () => {
      root.render(createElement(PlayerControls));
    });

    expect(usePlayerStore.getState().speed).toBe(1);
    expect(usePlayerStore.getState().effectLevel).toBe("full");

    // 跨标签页修改 SPEED_KEY
    localStorage.setItem(SPEED_KEY, "1.5");
    await act(async () => {
      window.dispatchEvent(new StorageEvent("storage", { key: SPEED_KEY }));
    });
    expect(usePlayerStore.getState().speed).toBe(1.5);
    expect(usePlayerStore.getState().effectLevel).toBe("full");

    // 跨标签页修改 EFFECT_LEVEL_KEY
    localStorage.setItem(EFFECT_LEVEL_KEY, "calm");
    await act(async () => {
      window.dispatchEvent(new StorageEvent("storage", { key: EFFECT_LEVEL_KEY }));
    });
    expect(usePlayerStore.getState().speed).toBe(1.5);
    expect(usePlayerStore.getState().effectLevel).toBe("calm");

    // key 为 null
    localStorage.setItem(SPEED_KEY, "2");
    localStorage.setItem(EFFECT_LEVEL_KEY, "minimal");
    await act(async () => {
      window.dispatchEvent(new StorageEvent("storage", { key: null }));
    });
    expect(usePlayerStore.getState().speed).toBe(2);
    expect(usePlayerStore.getState().effectLevel).toBe("minimal");
  });

  test("save syncs usePlayerStore on success and leaves store unchanged when write fails", async () => {
    usePlayerStore.setState({ speed: 1, effectLevel: "full" });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      if (init?.method === "PUT") {
        return Response.json({ ok: true });
      }
      return Response.json({
        settings: {},
        keySource: "env",
        serverKeyDisabled: false,
      });
    });

    await act(async () => {
      root.render(createElement(SettingsPage));
    });

    await act(async () => {
      findButton(container, "1.5×")!.click();
      findButton(container, "克制")!.click();
    });

    // 1. 任一写失败（SPEED_KEY 失败）时不改 store
    let failKey: string | null = SPEED_KEY;
    const origSetItem = window.localStorage.setItem;
    const setItemSpy = vi.spyOn(window.localStorage, "setItem").mockImplementation((k, v) => {
      if (k === failKey) {
        throw new Error("QuotaExceededError");
      }
      return origSetItem.call(window.localStorage, k, v);
    });

    await clickSave(container);
    expect(usePlayerStore.getState().speed).toBe(1);
    expect(usePlayerStore.getState().effectLevel).toBe("full");

    // 2. 另一个写失败（EFFECT_LEVEL_KEY 失败）时也不改 store
    failKey = EFFECT_LEVEL_KEY;
    await clickSave(container);
    expect(usePlayerStore.getState().speed).toBe(1);
    expect(usePlayerStore.getState().effectLevel).toBe("full");

    // 3. 两项均写成功后 store 更新为新值
    failKey = null;
    await clickSave(container);
    expect(usePlayerStore.getState().speed).toBe(1.5);
    expect(usePlayerStore.getState().effectLevel).toBe("calm");

    setItemSpy.mockRestore();
  });
});
