import { describe, expect, test } from "vitest";
import { chooseAskScrollBlock } from "../lib/ask/ask-scroll";

describe("chooseAskScrollBlock", () => {
  test("a marker taller than the space above the drawer uses start", () => {
    expect(chooseAskScrollBlock(240, 180)).toBe("start");
  });

  test("a marker equal to the available height uses nearest", () => {
    expect(chooseAskScrollBlock(180, 180)).toBe("nearest");
  });

  test("a marker shorter than the available height uses nearest", () => {
    expect(chooseAskScrollBlock(40, 180)).toBe("nearest");
  });
});
