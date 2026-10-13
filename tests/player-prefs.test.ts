// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { EFFECT_LEVEL_KEY, readEffectLevel, readSpeed, SPEED_KEY, usePlayerStore } from "../lib/player/store";
import type { TeachingScript } from "../lib/teaching/types";

const s = () => usePlayerStore.getState();

const script: TeachingScript = {
  problemSlug: "two-sum",
  mode: "lecture",
  language: "zh",
  solutionLanguage: "typescript",
  steps: [
    { id: "s1", narration: "第一步", targets: [], effects: [] },
    { id: "s2", narration: "第二步", targets: [], effects: [] },
  ],
};

beforeEach(() => {
  localStorage.clear();
  usePlayerStore.getState().setSpeed(1);
  usePlayerStore.getState().setEffectLevel("full");
  localStorage.clear();
  usePlayerStore.getState().reset();
});

afterEach(() => {
  usePlayerStore.getState().reset();
  vi.restoreAllMocks();
});

test("setSpeed(1.5) 写入 localStorage，且在 reset / loadScript / beginStream 后保持 1.5", () => {
  expect(s().speed).toBe(1);
  s().setSpeed(1.5);
  expect(s().speed).toBe(1.5);
  expect(localStorage.getItem(SPEED_KEY)).toBe("1.5");

  s().reset();
  expect(s().speed).toBe(1.5);

  s().loadScript(script);
  expect(s().speed).toBe(1.5);

  s().beginStream(script);
  expect(s().speed).toBe(1.5);
});

test("localStorage 已设 speed 时重新导入 store 模块，初始 speed 为 1.5", async () => {
  localStorage.setItem(SPEED_KEY, "1.5");
  vi.resetModules();
  const { usePlayerStore: freshStore } = await import("../lib/player/store");
  expect(freshStore.getState().speed).toBe(1.5);
});

test("setEffectLevel('calm') 写入 localStorage，且在 reset / loadScript / beginStream 后保持 'calm'", () => {
  expect(s().effectLevel).toBe("full");
  s().setEffectLevel("calm");
  expect(s().effectLevel).toBe("calm");
  expect(localStorage.getItem(EFFECT_LEVEL_KEY)).toBe("calm");

  s().reset();
  expect(s().effectLevel).toBe("calm");

  s().loadScript(script);
  expect(s().effectLevel).toBe("calm");

  s().beginStream(script);
  expect(s().effectLevel).toBe("calm");
});

test("localStorage 已设 effectLevel 时重新导入 store 模块，初始 effectLevel 为 'calm'", async () => {
  localStorage.setItem(EFFECT_LEVEL_KEY, "calm");
  vi.resetModules();
  const { usePlayerStore: freshStore } = await import("../lib/player/store");
  expect(freshStore.getState().effectLevel).toBe("calm");
});

test("localStorage 中非法值 ('3', 'loud') 回退到默认值 1 和 'full'", async () => {
  localStorage.setItem(SPEED_KEY, "3");
  localStorage.setItem(EFFECT_LEVEL_KEY, "loud");
  expect(readSpeed()).toBe(1);
  expect(readEffectLevel()).toBe("full");

  vi.resetModules();
  const { usePlayerStore: freshStore } = await import("../lib/player/store");
  expect(freshStore.getState().speed).toBe(1);
  expect(freshStore.getState().effectLevel).toBe("full");
});

test("localStorage 读写异常时 readSpeed / readEffectLevel / setSpeed / setEffectLevel 不抛错", async () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("SecurityError");
  });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("QuotaExceededError");
  });

  expect(readSpeed()).toBe(1);
  expect(readEffectLevel()).toBe("full");

  expect(() => s().setSpeed(2)).not.toThrow();
  expect(s().speed).toBe(2);

  expect(() => s().setEffectLevel("minimal")).not.toThrow();
  expect(s().effectLevel).toBe("minimal");
});
