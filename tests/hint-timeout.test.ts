import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { HINT_TIMEOUT_MS, hintTimeoutMs } from "../lib/agent/defaults";

afterEach(() => {
  delete process.env.HINT_TIMEOUT_MS;
});

test("未设置或非法值回退 60000，正整数生效", () => {
  expect(HINT_TIMEOUT_MS).toBe(60_000);
  for (const invalid of [undefined, "", " ", "0", "-1", "abc", "3.5", "60s", "00", "NaN"]) {
    if (invalid === undefined) delete process.env.HINT_TIMEOUT_MS;
    else process.env.HINT_TIMEOUT_MS = invalid;
    expect(hintTimeoutMs()).toBe(60_000);
    expect(hintTimeoutMs(invalid)).toBe(60_000);
  }
  expect(hintTimeoutMs("90000")).toBe(90_000);
  process.env.HINT_TIMEOUT_MS = "45000";
  expect(hintTimeoutMs()).toBe(45_000);
});

test("hint route 使用 hintTimeoutMs 而非写死 30s", () => {
  const src = readFileSync(join(__dirname, "../app/api/hint/route.ts"), "utf8");
  expect(src).toContain("hintTimeoutMs()");
  expect(src).not.toMatch(/AbortSignal\.timeout\(\s*30_000\s*\)/);
});
