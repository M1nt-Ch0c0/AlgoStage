// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  EFFECT_LEVEL_KEY,
  readEffectLevel,
  readSpeed,
  SPEED_KEY,
  syncPrefsFromStorage,
  usePlayerStore,
  writeEffectLevel,
  writeSpeed,
} from "../lib/player/store";

describe("player prefs storage and store sync", () => {
  beforeEach(() => {
    localStorage.clear();
    usePlayerStore.getState().reset();
    usePlayerStore.setState({ speed: 1, effectLevel: "full" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    localStorage.clear();
    usePlayerStore.getState().reset();
  });

  test("write* true normally and false when setItem throws or window undefined", () => {
    expect(writeSpeed(0.5)).toBe(true);
    expect(localStorage.getItem(SPEED_KEY)).toBe("0.5");

    expect(writeSpeed(1.5)).toBe(true);
    expect(localStorage.getItem(SPEED_KEY)).toBe("1.5");

    expect(writeEffectLevel("calm")).toBe(true);
    expect(localStorage.getItem(EFFECT_LEVEL_KEY)).toBe("calm");

    expect(writeEffectLevel("minimal")).toBe(true);
    expect(localStorage.getItem(EFFECT_LEVEL_KEY)).toBe("minimal");

    // setItem 抛错时返回 false
    const setItemSpy = vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(writeSpeed(2)).toBe(false);
    expect(writeEffectLevel("full")).toBe(false);
    setItemSpy.mockRestore();

    // window 为 undefined 时返回 false
    vi.stubGlobal("window", undefined);
    expect(writeSpeed(2)).toBe(false);
    expect(writeEffectLevel("calm")).toBe(false);
    vi.unstubAllGlobals();
  });

  test("set* still update memory when setItem throws and return false", () => {
    expect(usePlayerStore.getState().speed).toBe(1);
    expect(usePlayerStore.getState().effectLevel).toBe("full");

    const spy = vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });

    const speedRes = usePlayerStore.getState().setSpeed(1.5);
    expect(speedRes).toBe(false);
    expect(usePlayerStore.getState().speed).toBe(1.5);

    const levelRes = usePlayerStore.getState().setEffectLevel("calm");
    expect(levelRes).toBe(false);
    expect(usePlayerStore.getState().effectLevel).toBe("calm");

    // 正常时不仅更新内存，还写入 localStorage 并返回 true
    spy.mockRestore();
    const okSpeed = usePlayerStore.getState().setSpeed(2);
    expect(okSpeed).toBe(true);
    expect(usePlayerStore.getState().speed).toBe(2);
    expect(localStorage.getItem(SPEED_KEY)).toBe("2");

    const okLevel = usePlayerStore.getState().setEffectLevel("minimal");
    expect(okLevel).toBe(true);
    expect(usePlayerStore.getState().effectLevel).toBe("minimal");
    expect(localStorage.getItem(EFFECT_LEVEL_KEY)).toBe("minimal");
  });

  test("read* default to 1/full for 'abc','3','' and getItem throwing", () => {
    // 非法字符串 'abc'
    localStorage.setItem(SPEED_KEY, "abc");
    localStorage.setItem(EFFECT_LEVEL_KEY, "abc");
    expect(readSpeed()).toBe(1);
    expect(readEffectLevel()).toBe("full");

    // 超出范围的 '3'
    localStorage.setItem(SPEED_KEY, "3");
    localStorage.setItem(EFFECT_LEVEL_KEY, "3");
    expect(readSpeed()).toBe(1);
    expect(readEffectLevel()).toBe("full");

    // 空字符串 ''
    localStorage.setItem(SPEED_KEY, "");
    localStorage.setItem(EFFECT_LEVEL_KEY, "");
    expect(readSpeed()).toBe(1);
    expect(readEffectLevel()).toBe("full");

    // getItem 抛出异常（存储中原本有合法的非默认值）
    localStorage.setItem(SPEED_KEY, "2");
    localStorage.setItem(EFFECT_LEVEL_KEY, "minimal");
    const getItemSpy = vi.spyOn(window.localStorage, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    expect(readSpeed()).toBe(1);
    expect(readEffectLevel()).toBe("full");
    getItemSpy.mockRestore();
  });

  test("syncPrefsFromStorage updates store and never calls setItem", () => {
    const setItemSpy = vi.spyOn(window.localStorage, "setItem");

    // 初始状态
    usePlayerStore.setState({ speed: 1, effectLevel: "full" });

    // 1. SPEED_KEY 变更
    localStorage.setItem(SPEED_KEY, "1.5");
    setItemSpy.mockClear();
    syncPrefsFromStorage(new StorageEvent("storage", { key: SPEED_KEY }));
    expect(usePlayerStore.getState().speed).toBe(1.5);
    expect(usePlayerStore.getState().effectLevel).toBe("full");
    expect(setItemSpy).not.toHaveBeenCalled();

    // 2. EFFECT_LEVEL_KEY 变更
    localStorage.setItem(EFFECT_LEVEL_KEY, "calm");
    setItemSpy.mockClear();
    syncPrefsFromStorage(new StorageEvent("storage", { key: EFFECT_LEVEL_KEY }));
    expect(usePlayerStore.getState().speed).toBe(1.5);
    expect(usePlayerStore.getState().effectLevel).toBe("calm");
    expect(setItemSpy).not.toHaveBeenCalled();

    // 3. key 为 null (例如多标签页清空 localStorage 时)
    localStorage.setItem(SPEED_KEY, "2");
    localStorage.setItem(EFFECT_LEVEL_KEY, "minimal");
    setItemSpy.mockClear();
    syncPrefsFromStorage(new StorageEvent("storage", { key: null }));
    expect(usePlayerStore.getState().speed).toBe(2);
    expect(usePlayerStore.getState().effectLevel).toBe("minimal");
    expect(setItemSpy).not.toHaveBeenCalled();

    // 4. 无关 key 不触发 store 更新
    localStorage.setItem(SPEED_KEY, "0.5");
    setItemSpy.mockClear();
    syncPrefsFromStorage(new StorageEvent("storage", { key: "unrelated.key" }));
    expect(usePlayerStore.getState().speed).toBe(2);
    expect(usePlayerStore.getState().effectLevel).toBe("minimal");
    expect(setItemSpy).not.toHaveBeenCalled();
  });
});
