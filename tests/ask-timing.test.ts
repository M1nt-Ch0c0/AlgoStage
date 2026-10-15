import { afterEach, describe, expect, test } from "vitest";
import {
  isAskTimingEnabled,
  markAskPhase,
  markAskPointerDown,
  markAskTiming,
  msSinceLongTaskEnd,
  noteLongTaskEnded,
  resetLongTaskEndForTests,
  type AskTimingProbe,
} from "../lib/ask/ask-timing";

function install(probe: AskTimingProbe | undefined) {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: probe === undefined ? {} : { __ASK_TIMING__: probe },
  });
}

afterEach(() => {
  resetLongTaskEndForTests();
  Reflect.deleteProperty(globalThis, "window");
});

describe("ask timing probe", () => {
  test("is a no-op unless window.__ASK_TIMING__ is an object", () => {
    install(undefined);
    expect(isAskTimingEnabled()).toBe(false);
    markAskTiming("captureStart", 10);
    markAskPhase("domToCanvasMs", 40);
    markAskPointerDown(12);
    expect((globalThis as { window?: { __ASK_TIMING__?: AskTimingProbe } }).window?.__ASK_TIMING__).toBeUndefined();
  });

  test("ignores a non-object probe", () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { __ASK_TIMING__: "on" },
    });
    expect(isAskTimingEnabled()).toBe(false);
    markAskTiming("captureStart", 10);
    expect((globalThis as { window: { __ASK_TIMING__: unknown } }).window.__ASK_TIMING__).toBe("on");
  });

  test("records marks, the first pointerdown timeStamp, and phase durations", () => {
    const probe: AskTimingProbe = {};
    install(probe);
    expect(isAskTimingEnabled()).toBe(true);

    markAskTiming("captureStart", 100);
    markAskTiming("longTaskEnd", 900);
    markAskTiming("sentAt", 980);
    markAskTiming("cancelUnmountAt", 990);
    markAskPhase("domToCanvasMs", 800);
    markAskPhase("postToWorkerMs", 4);
    markAskPhase("encodeMs", 30);
    markAskPhase("settleMs", 50);
    markAskPhase("preFetchMs", 20);
    markAskPointerDown(940);

    expect(probe).toEqual({
      captureStart: 100,
      longTaskEnd: 900,
      sentAt: 980,
      cancelUnmountAt: 990,
      domToCanvasMs: 800,
      postToWorkerMs: 4,
      encodeMs: 30,
      settleMs: 50,
      preFetchMs: 20,
      firstPointerDownTs: 940,
    });
  });

  test("keeps the first value of each mark", () => {
    const probe: AskTimingProbe = {};
    install(probe);
    markAskTiming("captureStart", 1);
    markAskTiming("captureStart", 9);
    markAskPointerDown(3);
    markAskPointerDown(8);
    markAskPhase("encodeMs", 12);
    markAskPhase("encodeMs", 40);
    markAskPhase("settleMs", Number.NaN);
    expect(probe.captureStart).toBe(1);
    expect(probe.firstPointerDownTs).toBe(3);
    expect(probe.encodeMs).toBe(12);
    expect(probe.settleMs).toBeUndefined();
  });

  test("remembers when the long task ended even with the probe off", () => {
    install(undefined);
    expect(msSinceLongTaskEnd(1000)).toBe(0);
    noteLongTaskEnded(1000);
    expect(msSinceLongTaskEnd(1040)).toBe(40);
    expect(msSinceLongTaskEnd(900)).toBe(0);
    expect((globalThis as { window?: { __ASK_TIMING__?: AskTimingProbe } }).window?.__ASK_TIMING__).toBeUndefined();
  });
});
