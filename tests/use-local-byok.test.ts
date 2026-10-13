// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  BYOK_CHANGE_EVENT,
  BYOK_STORAGE_KEY,
  clearLocalByok,
  type LocalByok,
  writeLocalByok,
} from "../lib/byok/storage";
import { useLocalByok } from "../lib/byok/use-local-byok";

let root: Root;
let container: HTMLDivElement;
let latest: ReturnType<typeof useLocalByok>;

function TestHarness() {
  latest = useLocalByok();
  return createElement(
    "div",
    {
      "data-ready": String(latest.ready),
      "data-key": latest.byok?.apiKey ?? "",
      "data-base-url": latest.byok?.baseURL ?? "",
      "data-model": latest.byok?.model ?? "",
    },
    latest.byok ? latest.byok.apiKey : "empty",
  );
}

describe("useLocalByok", () => {
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    window.localStorage.clear();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    window.localStorage.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  test("reads initial value from localStorage on mount and sets ready=true", async () => {
    writeLocalByok({
      apiKey: "sk-initial-key",
      baseURL: "https://api.example.com/v1",
      model: "gpt-4o",
    });

    await act(async () => {
      root.render(createElement(TestHarness));
    });

    expect(latest.ready).toBe(true);
    expect(latest.byok).toEqual({
      apiKey: "sk-initial-key",
      baseURL: "https://api.example.com/v1",
      model: "gpt-4o",
    });
  });

  test("save and clear update hook state and localStorage", async () => {
    await act(async () => {
      root.render(createElement(TestHarness));
    });

    expect(latest.ready).toBe(true);
    expect(latest.byok).toBeNull();

    await act(async () => {
      latest.save({
        apiKey: "  sk-saved-12345  ",
        baseURL: "  https://proxy.example.com/v1 ",
        model: "  ",
      });
    });

    expect(latest.byok).toEqual({
      apiKey: "sk-saved-12345",
      baseURL: "https://proxy.example.com/v1",
    });

    await act(async () => {
      latest.clear();
    });

    expect(latest.byok).toBeNull();
    expect(window.localStorage.getItem(BYOK_STORAGE_KEY)).toBeNull();
  });

  test("reacts to external BYOK_CHANGE_EVENT and storage events for BYOK_STORAGE_KEY", async () => {
    await act(async () => {
      root.render(createElement(TestHarness));
    });

    expect(latest.byok).toBeNull();

    await act(async () => {
      writeLocalByok({ apiKey: "sk-from-custom-event", model: "claude-3-7-sonnet" });
    });

    expect(latest.byok).toEqual({
      apiKey: "sk-from-custom-event",
      model: "claude-3-7-sonnet",
    });

    await act(async () => {
      clearLocalByok();
    });

    expect(latest.byok).toBeNull();

    // Simulate cross-tab storage event for BYOK_STORAGE_KEY
    const crossTabValue: LocalByok = { apiKey: "sk-from-storage-event", baseURL: "https://tab2.example.com/v1" };
    await act(async () => {
      window.localStorage.setItem(BYOK_STORAGE_KEY, JSON.stringify(crossTabValue));
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: BYOK_STORAGE_KEY,
          newValue: JSON.stringify(crossTabValue),
        }),
      );
    });

    expect(latest.byok).toEqual(crossTabValue);

    // Unrelated storage key does not clobber state
    await act(async () => {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: "other.key",
          newValue: "something",
        }),
      );
    });

    expect(latest.byok).toEqual(crossTabValue);
  });

  test("cleans up window event listeners on unmount", async () => {
    const addSpy = vi.spyOn(window, "addEventListener");
    const removeSpy = vi.spyOn(window, "removeEventListener");

    await act(async () => {
      root.render(createElement(TestHarness));
    });

    expect(addSpy).toHaveBeenCalledWith(BYOK_CHANGE_EVENT, expect.any(Function));
    expect(addSpy).toHaveBeenCalledWith("storage", expect.any(Function));

    await act(async () => {
      root.unmount();
    });

    expect(removeSpy).toHaveBeenCalledWith(BYOK_CHANGE_EVENT, expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith("storage", expect.any(Function));
  });
});
