import { describe, expect, test } from "vitest";
import { shouldRetroCancel } from "../lib/ask/retro-cancel";

describe("shouldRetroCancel", () => {
  test("a pointerdown timeStamp earlier than sentAt cancels even though the event is dispatched late", () => {
    const sentAt = 5_000;
    const downTs = 4_200;
    const dispatchedLate = downTs < sentAt;
    expect(dispatchedLate).toBe(true);
    expect(shouldRetroCancel(downTs, sentAt, true)).toBe(true);
  });

  test("a pointerdown timeStamp after sentAt keeps normal hold behaviour", () => {
    expect(shouldRetroCancel(5_001, 5_000, true)).toBe(false);
  });

  test("a slide off the button does not cancel", () => {
    expect(shouldRetroCancel(4_200, 5_000, false)).toBe(false);
  });

  test("equal timeStamps count as pressed before the send", () => {
    expect(shouldRetroCancel(5_000, 5_000, true)).toBe(true);
  });

  test("no send timestamp does not cancel", () => {
    expect(shouldRetroCancel(4_200, null, true)).toBe(false);
  });
});
