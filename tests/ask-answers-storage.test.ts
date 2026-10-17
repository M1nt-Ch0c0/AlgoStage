// @vitest-environment happy-dom
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  answersStorageKey,
  clearBrowserAnswersAfterRegenerate,
  readBrowserAnswers,
  writeBrowserAnswers,
} from "@/lib/ask/answers-storage";
import type { StepAnswer, StepAnswersMap } from "@/lib/ask/types";

function answer(overrides: Partial<StepAnswer> = {}): StepAnswer {
  return {
    v: 1,
    id: "a1",
    stepId: "s1",
    question: "为什么？",
    selection: {
      mode: "single",
      bbox: { x: 0, y: 0, width: 10, height: 10 },
      targets: [{ kind: "code", id: "c1", text: "map" }],
    },
    segments: [{ id: "seg", narration: "因为查找。" }],
    createdAt: "2026-10-13T08:00:00.000Z",
    ...overrides,
  };
}

const valid = new Set(["s1", "s2"]);

beforeEach(() => {
  window.localStorage.clear();
});

describe("browser answers storage", () => {
  test("30. exact key round-trips a StepAnswersMap and refresh reads it back", () => {
    const map: StepAnswersMap = {
      s1: [answer({ id: "early", createdAt: "2026-10-13T09:00:00.000Z" }), answer({ id: "late", createdAt: "2026-10-13T08:00:00.000Z" })],
    };
    writeBrowserAnswers("cache-a", "v1", map);
    expect(answersStorageKey("cache-a", "v1")).toBe("algostage.answers.cache-a.v1");
    expect(window.localStorage.getItem("algostage.answers.cache-a.v1")).toBeTruthy();
    const read = readBrowserAnswers("cache-a", "v1", valid);
    expect(read.s1?.map((item) => item.id)).toEqual(["late", "early"]);
  });

  test("31. bad JSON, invalid schema, and stepId mismatch return {} and drop the key", () => {
    window.localStorage.setItem(answersStorageKey("cache-a", "v1"), "{not-json");
    expect(readBrowserAnswers("cache-a", "v1", valid)).toEqual({});
    expect(window.localStorage.getItem(answersStorageKey("cache-a", "v1"))).toBeNull();

    window.localStorage.setItem(answersStorageKey("cache-a", "v1"), JSON.stringify({ s1: [{ nope: true }] }));
    expect(readBrowserAnswers("cache-a", "v1", valid)).toEqual({});
    expect(window.localStorage.getItem(answersStorageKey("cache-a", "v1"))).toBeNull();

    const mismatch = { s1: [answer({ stepId: "other" })] };
    window.localStorage.setItem(answersStorageKey("cache-a", "v1"), JSON.stringify(mismatch));
    expect(readBrowserAnswers("cache-a", "v1", valid)).toEqual({});
    expect(window.localStorage.getItem(answersStorageKey("cache-a", "v1"))).toBeNull();
  });

  test("31. a legal map filters unknown and disabled steps and sorts by createdAt", () => {
    const stored = {
      s1: [
        answer({ id: "b", createdAt: "2026-10-13T10:00:00+08:00" }),
        answer({ id: "a", createdAt: "2026-10-13T01:00:00.000Z" }),
      ],
      banned: [answer({ id: "x", stepId: "banned" })],
      mystery: [answer({ id: "y", stepId: "mystery" })],
    };
    window.localStorage.setItem(answersStorageKey("cache-a", "v1"), JSON.stringify(stored));
    const read = readBrowserAnswers("cache-a", "v1", new Set(["s1"]));
    expect(Object.keys(read)).toEqual(["s1"]);
    expect(read.s1?.map((item) => item.id)).toEqual(["a", "b"]);
    expect(window.localStorage.getItem(answersStorageKey("cache-a", "v1"))).toBeTruthy();
  });

  test("32. QuotaExceededError and SecurityError stay silent; missing window is a no-op", () => {
    const map = { s1: [answer()] };
    const setItem = vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      const error = new Error("quota");
      error.name = "QuotaExceededError";
      throw error;
    });
    expect(() => writeBrowserAnswers("cache-a", "v1", map)).not.toThrow();
    setItem.mockImplementation(() => {
      const error = new Error("denied");
      error.name = "SecurityError";
      throw error;
    });
    expect(() => writeBrowserAnswers("cache-a", "v1", map)).not.toThrow();
    setItem.mockRestore();

    const getItem = vi.spyOn(window.localStorage, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(readBrowserAnswers("cache-a", "v1", valid)).toEqual({});
    getItem.mockRestore();

    const removeItem = vi.spyOn(window.localStorage, "removeItem").mockImplementation(() => {
      throw new Error("denied");
    });
    window.localStorage.setItem(answersStorageKey("cache-a", "v1"), "{");
    expect(readBrowserAnswers("cache-a", "v1", valid)).toEqual({});
    expect(() => clearBrowserAnswersAfterRegenerate("cache-a")).not.toThrow();
    removeItem.mockRestore();

    const original = globalThis.window;
    // @ts-expect-error simulate SSR
    delete globalThis.window;
    expect(readBrowserAnswers("cache-a", "v1", valid)).toEqual({});
    expect(() => writeBrowserAnswers("cache-a", "v1", map)).not.toThrow();
    expect(() => clearBrowserAnswersAfterRegenerate("cache-a")).not.toThrow();
    globalThis.window = original;
  });

  test("33. persisted JSON keeps only protocol fields", () => {
    const dirty = {
      s1: [{
        ...answer(),
        image: "data:image/png;base64,AAAA",
        dataBase64: "AAAA",
        apiKey: "sk-secret",
        byok: { apiKey: "sk-secret" },
        body: { prompt: "secret" },
        draft: "unsent",
      }],
    } as unknown as StepAnswersMap;
    writeBrowserAnswers("cache-a", "v1", dirty);
    const raw = window.localStorage.getItem(answersStorageKey("cache-a", "v1")) ?? "";
    expect(raw).not.toMatch(/image|dataBase64|apiKey|sk-secret|byok|prompt|draft/i);
    const parsed = JSON.parse(raw) as { s1: Array<Record<string, unknown>> };
    expect(Object.keys(parsed.s1[0]!).sort()).toEqual(
      ["createdAt", "id", "question", "segments", "selection", "stepId", "v"],
    );
  });

  test("34. versions do not mix; clear removes only that cacheKey prefix", () => {
    writeBrowserAnswers("cache-a", "v1", { s1: [answer({ id: "old" })] });
    writeBrowserAnswers("cache-a", "v2", { s1: [answer({ id: "new" })] });
    writeBrowserAnswers("cache-b", "v1", { s1: [answer({ id: "other" })] });
    window.localStorage.setItem("algostage.byok.apiKey", "sk-keep");
    window.localStorage.setItem("algostage.autoAdvance", "true");

    expect(readBrowserAnswers("cache-a", "v1", valid).s1?.[0]?.id).toBe("old");
    expect(readBrowserAnswers("cache-a", "v2", valid).s1?.[0]?.id).toBe("new");

    clearBrowserAnswersAfterRegenerate("cache-a");
    expect(window.localStorage.getItem(answersStorageKey("cache-a", "v1"))).toBeNull();
    expect(window.localStorage.getItem(answersStorageKey("cache-a", "v2"))).toBeNull();
    expect(readBrowserAnswers("cache-b", "v1", valid).s1?.[0]?.id).toBe("other");
    expect(window.localStorage.getItem("algostage.byok.apiKey")).toBe("sk-keep");
    expect(window.localStorage.getItem("algostage.autoAdvance")).toBe("true");
  });

  test("35. regenerate clears the current version key even when the version is unchanged", () => {
    writeBrowserAnswers("cache-a", "same", { s1: [answer()] });
    clearBrowserAnswersAfterRegenerate("cache-a");
    expect(window.localStorage.getItem(answersStorageKey("cache-a", "same"))).toBeNull();
    expect(readBrowserAnswers("cache-a", "same", valid)).toEqual({});
  });

  test("empty cacheKey or version does not construct a key", () => {
    writeBrowserAnswers("", "v1", { s1: [answer()] });
    writeBrowserAnswers("cache-a", "", { s1: [answer()] });
    expect(window.localStorage.length).toBe(0);
    expect(readBrowserAnswers("", "v1", valid)).toEqual({});
    expect(readBrowserAnswers("cache-a", "", valid)).toEqual({});
    window.localStorage.setItem("algostage.answers.", "nope");
    clearBrowserAnswersAfterRegenerate("");
    expect(window.localStorage.getItem("algostage.answers.")).toBe("nope");
  });

  test("round-trips map with imageAttached true/false and reads back same", () => {
    const map: StepAnswersMap = {
      s1: [
        answer({ id: "with-image", imageAttached: true, createdAt: "2026-10-13T08:00:00.000Z" }),
        answer({ id: "without-image", imageAttached: false, createdAt: "2026-10-13T09:00:00.000Z" }),
      ],
    };
    writeBrowserAnswers("cache-a", "v1", map);
    const read = readBrowserAnswers("cache-a", "v1", valid);
    expect(read.s1?.[0]?.imageAttached).toBe(true);
    expect(read.s1?.[1]?.imageAttached).toBe(false);
  });

  test("round-trips map without imageAttached field and reads back undefined/absent", () => {
    const map: StepAnswersMap = {
      s1: [answer({ id: "no-image" })],
    };
    writeBrowserAnswers("cache-a", "v1", map);
    const read = readBrowserAnswers("cache-a", "v1", valid);
    expect(read.s1?.[0]?.imageAttached).toBeUndefined();
    expect("imageAttached" in (read.s1?.[0] ?? {})).toBe(false);
  });
});
