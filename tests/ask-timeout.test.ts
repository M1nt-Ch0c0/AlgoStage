import { afterEach, expect, test } from "vitest";
import { ASK_TIMEOUT_MS, askTimeoutMs, HINT_TIMEOUT_MS, hintTimeoutMs } from "../lib/agent/defaults";

afterEach(() => {
  delete process.env.ASK_TIMEOUT_MS;
});

test("31. askTimeoutMs 默认 90000；空白正整数覆盖；非法值回退", () => {
  expect(ASK_TIMEOUT_MS).toBe(90_000);
  expect(askTimeoutMs()).toBe(90_000);
  expect(askTimeoutMs(undefined)).toBe(90_000);

  for (const invalid of ["", " ", "0", "-1", "3.5", "1e5", "90s", "00", "NaN", "Infinity", "+90", "90000.0"]) {
    process.env.ASK_TIMEOUT_MS = invalid;
    expect(askTimeoutMs()).toBe(90_000);
    expect(askTimeoutMs(invalid)).toBe(90_000);
  }
  expect(askTimeoutMs(1 as unknown as string)).toBe(90_000);
  expect(askTimeoutMs(null as unknown as string)).toBe(90_000);

  expect(askTimeoutMs("  120000  ")).toBe(120_000);
  process.env.ASK_TIMEOUT_MS = " 45000 ";
  expect(askTimeoutMs()).toBe(45_000);

  const overSafe = String(Number.MAX_SAFE_INTEGER + 2);
  expect(Number.isSafeInteger(Number(overSafe))).toBe(false);
  expect(askTimeoutMs(overSafe)).toBe(90_000);
  expect(askTimeoutMs(String(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);

  // 大于 Node setTimeout 单次上限（2^31-1）的合法毫秒必须原样返回，不能收成 1。
  const aboveTimer = String(2_147_483_647 + 1);
  expect(askTimeoutMs(aboveTimer)).toBe(2_147_483_648);
  expect(askTimeoutMs(aboveTimer)).not.toBe(1);
});

test("hintTimeoutMs 行为不被 ask 超时改动", () => {
  expect(HINT_TIMEOUT_MS).toBe(60_000);
  expect(hintTimeoutMs("45000")).toBe(45_000);
  expect(hintTimeoutMs("0")).toBe(60_000);
  expect(hintTimeoutMs(undefined)).toBe(60_000);
  const previous = process.env.HINT_TIMEOUT_MS;
  delete process.env.HINT_TIMEOUT_MS;
  expect(hintTimeoutMs()).toBe(60_000);
  if (previous === undefined) delete process.env.HINT_TIMEOUT_MS;
  else process.env.HINT_TIMEOUT_MS = previous;
});
