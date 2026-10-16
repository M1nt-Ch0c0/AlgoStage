import { describe, expect, test } from "vitest";
import { shouldRetroCancel } from "../lib/ask/retro-cancel";

describe("shouldRetroCancel", () => {
  test("a press that hit 取消, released on the button after the fetch, cancels", () => {
    expect(shouldRetroCancel(true, true, true)).toBe(true);
  });

  test("a press that did not hit 取消 does not cancel", () => {
    expect(shouldRetroCancel(false, true, true)).toBe(false);
  });

  test("a slide off the button does not cancel", () => {
    expect(shouldRetroCancel(true, true, false)).toBe(false);
  });

  test("a hit that released before the fetch is the hold's cancel, not a retro cancel", () => {
    expect(shouldRetroCancel(true, false, true)).toBe(false);
  });
});
