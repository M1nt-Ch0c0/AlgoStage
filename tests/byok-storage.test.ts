// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  BYOK_CHANGE_EVENT,
  BYOK_STORAGE_KEY,
  clearLocalByok,
  type LocalByok,
  maskKey,
  readLocalByok,
  writeLocalByok,
} from "../lib/byok/storage";

describe("lib/byok/storage", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });
  test("constants match contract", () => {
    expect(BYOK_STORAGE_KEY).toBe("algostage.byok");
    expect(BYOK_CHANGE_EVENT).toBe("algostage:byok-change");
  });

  test("readLocalByok returns null when storage is empty or invalid", () => {
    expect(readLocalByok()).toBeNull();

    window.localStorage.setItem(BYOK_STORAGE_KEY, "not-json{");
    expect(readLocalByok()).toBeNull();

    window.localStorage.setItem(BYOK_STORAGE_KEY, JSON.stringify(null));
    expect(readLocalByok()).toBeNull();

    window.localStorage.setItem(BYOK_STORAGE_KEY, JSON.stringify(["array"]));
    expect(readLocalByok()).toBeNull();

    window.localStorage.setItem(BYOK_STORAGE_KEY, JSON.stringify({ apiKey: "   " }));
    expect(readLocalByok()).toBeNull();

    window.localStorage.setItem(BYOK_STORAGE_KEY, JSON.stringify({ apiKey: 12345 }));
    expect(readLocalByok()).toBeNull();
  });

  test("readLocalByok trims strings and drops empty optional fields", () => {
    window.localStorage.setItem(
      BYOK_STORAGE_KEY,
      JSON.stringify({
        apiKey: "  sk-test-123456  ",
        baseURL: "   ",
        model: "  deepseek-chat  ",
      }),
    );
    expect(readLocalByok()).toEqual({
      apiKey: "sk-test-123456",
      model: "deepseek-chat",
    });
  });

  test("writeLocalByok validates, stores sanitized JSON, and dispatches BYOK_CHANGE_EVENT", () => {
    const events: CustomEvent[] = [];
    const listener = (e: Event) => events.push(e as CustomEvent);
    window.addEventListener(BYOK_CHANGE_EVENT, listener);

    try {
      const saved = writeLocalByok({
        apiKey: "  sk-secret-key-9999 ",
        baseURL: " https://api.example.com/v1 ",
        model: "   ",
      });
      expect(saved).toEqual({
        apiKey: "sk-secret-key-9999",
        baseURL: "https://api.example.com/v1",
      });

      const raw = window.localStorage.getItem(BYOK_STORAGE_KEY);
      expect(raw).toBe(
        JSON.stringify({
          apiKey: "sk-secret-key-9999",
          baseURL: "https://api.example.com/v1",
        }),
      );
      expect(readLocalByok()).toEqual({
        apiKey: "sk-secret-key-9999",
        baseURL: "https://api.example.com/v1",
      });
      expect(events).toHaveLength(1);
    } finally {
      window.removeEventListener(BYOK_CHANGE_EVENT, listener);
    }
  });

  test("writeLocalByok rejects empty apiKey without overwriting or dispatching", () => {
    writeLocalByok({ apiKey: "sk-valid-12345678" });
    const events: Event[] = [];
    const listener = (e: Event) => events.push(e);
    window.addEventListener(BYOK_CHANGE_EVENT, listener);

    try {
      expect(writeLocalByok({ apiKey: "   " })).toBeNull();
      expect(writeLocalByok({} as LocalByok)).toBeNull();
      expect(readLocalByok()).toEqual({ apiKey: "sk-valid-12345678" });
      expect(events).toHaveLength(0);
    } finally {
      window.removeEventListener(BYOK_CHANGE_EVENT, listener);
    }
  });

  test("clearLocalByok removes storage item and dispatches BYOK_CHANGE_EVENT", () => {
    writeLocalByok({ apiKey: "sk-to-be-cleared" });
    const events: Event[] = [];
    const listener = (e: Event) => events.push(e);
    window.addEventListener(BYOK_CHANGE_EVENT, listener);

    try {
      clearLocalByok();
      expect(window.localStorage.getItem(BYOK_STORAGE_KEY)).toBeNull();
      expect(readLocalByok()).toBeNull();
      expect(events).toHaveLength(1);
    } finally {
      window.removeEventListener(BYOK_CHANGE_EVENT, listener);
    }
  });

  test("SSR safety when window is undefined", () => {
    vi.stubGlobal("window", undefined);
    expect(readLocalByok()).toBeNull();
    expect(writeLocalByok({ apiKey: "sk-ssr-test" })).toBeNull();
    expect(() => clearLocalByok()).not.toThrow();
  });

  test("maskKey masks keys <= 8 chars completely and shows last 4 for longer keys", () => {
    expect(maskKey("")).toBe("");
    expect(maskKey("a")).toBe("•");
    expect(maskKey("abcd")).toBe("••••");
    expect(maskKey("12345678")).toBe("••••••••");
    expect(maskKey("123456789")).toBe("••••6789");
    expect(maskKey("sk-prefix-test-abcd")).toBe("••••abcd");
  });
});
