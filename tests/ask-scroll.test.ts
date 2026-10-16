// @vitest-environment happy-dom
import { describe, expect, test } from "vitest";
import { getAskBottomOcclusion } from "../lib/ask/ask-occlusion";
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

  test("visible height minus bottom occlusion (player bar + bottom bar + panel) chooses the block", () => {
    document.documentElement.style.setProperty("--ask-bottom-occlusion", "360px");
    const visibleHeight = 800;
    const drawerBottomOffset = 0;
    const bottomOcclusion = getAskBottomOcclusion();
    expect(bottomOcclusion).toBe(360);
    const availableHeight = visibleHeight - bottomOcclusion - drawerBottomOffset;
    // 500 fits above a panel-only obstacle (600) and does not fit above player + bar + panel (440).
    expect(chooseAskScrollBlock(500, availableHeight)).toBe("start");
    expect(chooseAskScrollBlock(500, visibleHeight - 200 - drawerBottomOffset)).toBe("nearest");
    document.documentElement.style.removeProperty("--ask-bottom-occlusion");
  });
});
