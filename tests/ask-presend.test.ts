import { describe, expect, test } from "vitest";
import { shouldDropBeforeSend } from "../lib/ask/presend";

const clear = {
  epochNow: 1,
  epochAtCapture: 1,
  aborted: false,
  releasedOnCancel: false,
  latched: null,
} as const;

describe("shouldDropBeforeSend", () => {
  test("released-on-cancel alone drops the send", () => {
    expect(shouldDropBeforeSend({ ...clear, releasedOnCancel: true })).toBe(true);
  });

  test('latched "cancel" alone drops the send', () => {
    expect(shouldDropBeforeSend({ ...clear, latched: "cancel" })).toBe(true);
  });

  test('latched "send" does not drop', () => {
    expect(shouldDropBeforeSend({ ...clear, latched: "send" })).toBe(false);
  });

  test("an epoch mismatch drops the send", () => {
    expect(shouldDropBeforeSend({ ...clear, epochNow: 2, epochAtCapture: 1 })).toBe(true);
  });

  test("an aborted capture signal drops the send", () => {
    expect(shouldDropBeforeSend({ ...clear, aborted: true })).toBe(true);
  });

  test("all clear sends", () => {
    expect(shouldDropBeforeSend(clear)).toBe(false);
  });
});
