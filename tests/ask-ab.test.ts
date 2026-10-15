import { afterEach, describe, expect, test } from "vitest";
import { askAb, askAbFlags } from "../lib/ask/ask-ab";

afterEach(() => {
  Reflect.deleteProperty(globalThis, "window");
});

function install(value: unknown) {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value,
  });
}

describe("ask A/B flags", () => {
  test("every flag is off when window.__ASK_AB__ is absent", () => {
    install({});
    expect(askAbFlags()).toBeNull();
    expect(askAb("noPrewarm")).toBe(false);
    expect(askAb("noDoubleRaf")).toBe(false);
    expect(askAb("noSettle")).toBe(false);
  });

  test("a non-object value is a no-op", () => {
    install({ __ASK_AB__: "noPrewarm" });
    expect(askAbFlags()).toBeNull();
    expect(askAb("noPrewarm")).toBe(false);
  });

  test("reads the flags that are set and leaves the others off", () => {
    install({ __ASK_AB__: { noPrewarm: true, noSettle: false } });
    expect(askAb("noPrewarm")).toBe(true);
    expect(askAb("noDoubleRaf")).toBe(false);
    expect(askAb("noSettle")).toBe(false);
  });
});
