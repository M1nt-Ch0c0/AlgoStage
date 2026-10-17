// @vitest-environment happy-dom
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  applyAskSelectingRootVars,
  computeBottomOcclusion,
  createAskMeasureCache,
  getAskBottomObstacle,
  getAskBottomOcclusion,
  invalidateAskMeasureCache,
  measureAskElementHeight,
  measureAskPlayerBarHeight,
  selectingRootVarsFromCache,
  sharedAskMeasureCache,
  writeAskRootVars,
  type AskMeasureCache,
} from "../lib/ask/ask-occlusion";

afterEach(() => {
  invalidateAskMeasureCache(sharedAskMeasureCache);
});

describe("getAskBottomOcclusion", () => {
  afterEach(() => {
    document.documentElement.style.removeProperty("--ask-bottom-occlusion");
    vi.restoreAllMocks();
  });

  describe("set value", () => {
    test("reads from document.documentElement by default when inline style is set", () => {
      document.documentElement.style.setProperty("--ask-bottom-occlusion", "120px");
      expect(getAskBottomOcclusion()).toBe(120);
    });

    test("reads from custom HTMLElement argument with inline style", () => {
      const el = document.createElement("div");
      el.style.setProperty("--ask-bottom-occlusion", "136px");
      expect(getAskBottomOcclusion(el)).toBe(136);
    });

    test("reads 0px as 0", () => {
      const el = document.createElement("div");
      el.style.setProperty("--ask-bottom-occlusion", "0px");
      expect(getAskBottomOcclusion(el)).toBe(0);
    });

    test("reads fractional pixel values", () => {
      const el = document.createElement("div");
      el.style.setProperty("--ask-bottom-occlusion", "120.5px");
      expect(getAskBottomOcclusion(el)).toBe(120.5);
    });

    test("reads numeric values without px suffix", () => {
      const el = document.createElement("div");
      el.style.setProperty("--ask-bottom-occlusion", "80");
      expect(getAskBottomOcclusion(el)).toBe(80);
    });

    test("inline style takes precedence over getComputedStyle", () => {
      const el = document.createElement("div");
      el.style.setProperty("--ask-bottom-occlusion", "150px");
      vi.spyOn(window, "getComputedStyle").mockReturnValue({
        getPropertyValue: vi.fn().mockReturnValue("200px"),
      } as unknown as CSSStyleDeclaration);

      expect(getAskBottomOcclusion(el)).toBe(150);
    });

    test("falls back to getComputedStyle when inline style is not set", () => {
      const el = document.createElement("div");
      vi.spyOn(window, "getComputedStyle").mockReturnValue({
        getPropertyValue: vi.fn().mockImplementation((prop: string) => {
          if (prop === "--ask-bottom-occlusion") return "96px";
          return "";
        }),
      } as unknown as CSSStyleDeclaration);

      expect(getAskBottomOcclusion(el)).toBe(96);
    });
  });

  describe("missing value", () => {
    test("returns 0 when variable is not set in inline or computed style", () => {
      const el = document.createElement("div");
      expect(getAskBottomOcclusion(el)).toBe(0);
    });

    test("returns 0 when inline style is empty string and computed style is empty", () => {
      const el = document.createElement("div");
      el.style.setProperty("--ask-bottom-occlusion", "");
      expect(getAskBottomOcclusion(el)).toBe(0);
    });

    test("returns 0 when inline style is whitespace only", () => {
      const el = document.createElement("div");
      el.style.setProperty("--ask-bottom-occlusion", "   ");
      expect(getAskBottomOcclusion(el)).toBe(0);
    });

    test("returns 0 when root element is null or undefined", () => {
      expect(getAskBottomOcclusion(null as unknown as HTMLElement)).toBe(0);
      expect(getAskBottomOcclusion(undefined as unknown as HTMLElement)).toBe(0);
    });

    test("returns 0 when root element does not implement style", () => {
      expect(getAskBottomOcclusion({} as HTMLElement)).toBe(0);
    });
  });

  describe("unparsable value", () => {
    test("returns 0 for arbitrary non-numeric text", () => {
      const el = document.createElement("div");
      el.style.setProperty("--ask-bottom-occlusion", "invalid");
      expect(getAskBottomOcclusion(el)).toBe(0);
    });

    test("returns 0 for keywords like auto or none", () => {
      const el = document.createElement("div");
      el.style.setProperty("--ask-bottom-occlusion", "auto");
      expect(getAskBottomOcclusion(el)).toBe(0);

      el.style.setProperty("--ask-bottom-occlusion", "none");
      expect(getAskBottomOcclusion(el)).toBe(0);
    });

    test("returns 0 for CSS calc expressions", () => {
      const el = document.createElement("div");
      el.style.setProperty("--ask-bottom-occlusion", "calc(100px + 20px)");
      expect(getAskBottomOcclusion(el)).toBe(0);
    });

    test("returns 0 for unit only without number", () => {
      const el = document.createElement("div");
      el.style.setProperty("--ask-bottom-occlusion", "px");
      expect(getAskBottomOcclusion(el)).toBe(0);
    });

    test("returns 0 for multi-token or garbage values", () => {
      const el = document.createElement("div");
      el.style.setProperty("--ask-bottom-occlusion", "10px 20px");
      expect(getAskBottomOcclusion(el)).toBe(0);

      el.style.setProperty("--ask-bottom-occlusion", "10px solid red");
      expect(getAskBottomOcclusion(el)).toBe(0);
    });

    test("returns 0 for NaN or Infinity tokens", () => {
      const el = document.createElement("div");
      el.style.setProperty("--ask-bottom-occlusion", "NaN");
      expect(getAskBottomOcclusion(el)).toBe(0);

      el.style.setProperty("--ask-bottom-occlusion", "Infinitypx");
      expect(getAskBottomOcclusion(el)).toBe(0);
    });

    test("returns 0 when computed style returns unparsable value", () => {
      const el = document.createElement("div");
      vi.spyOn(window, "getComputedStyle").mockReturnValue({
        getPropertyValue: vi.fn().mockReturnValue("unparsable-calc()"),
      } as unknown as CSSStyleDeclaration);

      expect(getAskBottomOcclusion(el)).toBe(0);
    });
  });

  describe("SSR fallback", () => {
    test("returns 0 when document and window are undefined", () => {
      const originalDoc = globalThis.document;
      const originalWin = globalThis.window;
      try {
        // @ts-expect-error simulating SSR
        delete globalThis.document;
        // @ts-expect-error simulating SSR
        delete globalThis.window;
        expect(getAskBottomOcclusion()).toBe(0);
      } finally {
        globalThis.document = originalDoc;
        globalThis.window = originalWin;
      }
    });
  });
});

describe("measureAskElementHeight / getAskBottomObstacle", () => {
  function fakeEl(height: number): HTMLElement {
    const el = document.createElement("div");
    el.getBoundingClientRect = () => ({ height, width: 0, top: 0, left: 0, right: 0, bottom: height, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    return el;
  }

  test("measure rounds up and treats missing/zero as 0", () => {
    expect(measureAskElementHeight(fakeEl(59.2))).toBe(60);
    expect(measureAskElementHeight(fakeEl(0))).toBe(0);
    expect(measureAskElementHeight(null)).toBe(0);
  });

  test("obstacle uses the published occlusion when present", () => {
    const root = document.createElement("div");
    root.style.setProperty("--ask-bottom-occlusion", "230px");
    expect(getAskBottomObstacle(fakeEl(60), root)).toBe(230);
  });

  test("obstacle falls back to the bar height before occlusion is published", () => {
    const root = document.createElement("div");
    root.style.setProperty("--ask-bottom-occlusion", "0px");
    expect(getAskBottomObstacle(fakeEl(60), root)).toBe(60);
    expect(getAskBottomObstacle(null, root)).toBe(0);
  });

  test("obstacle is the player-bar height when the player area is on screen", () => {
    const originalMatchMedia = window.matchMedia;
    const originalHeight = window.innerHeight;
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 844 });
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === "(max-width: 639px)",
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })) as unknown as typeof window.matchMedia;

    const player = document.createElement("div");
    player.setAttribute("aria-label", "讲解播放区");
    player.getBoundingClientRect = () =>
      ({ height: 162, width: 390, top: 682, left: 0, right: 390, bottom: 844, x: 0, y: 682, toJSON: () => ({}) }) as DOMRect;
    document.body.appendChild(player);

    const root = document.createElement("div");
    root.style.setProperty("--ask-bottom-occlusion", "230px");
    expect(measureAskPlayerBarHeight()).toBe(162);
    // The obstacle keeps its original meaning even on a narrow viewport.
    expect(getAskBottomObstacle(fakeEl(60), root)).toBe(230);

    player.remove();
    Object.defineProperty(window, "innerHeight", { configurable: true, value: originalHeight });
    window.matchMedia = originalMatchMedia;
  });
});

describe("ask root var writes", () => {
  function styleTarget(): HTMLElement {
    const el = document.createElement("div");
    document.body.appendChild(el);
    return el;
  }

  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  test("writeAskRootVars skips setProperty when the inline value is unchanged", () => {
    const el = styleTarget();
    el.style.setProperty("--ask-player-bar-h", "60px");
    el.style.setProperty("--ask-bottom-bar-h", "52px");
    const setProperty = vi.spyOn(el.style, "setProperty");

    expect(
      writeAskRootVars(
        { "--ask-player-bar-h": "60px", "--ask-bottom-bar-h": "52px" },
        el.style,
      ),
    ).toEqual([]);
    expect(setProperty).not.toHaveBeenCalled();
  });

  test("writeAskRootVars writes only the names whose inline value differs", () => {
    const el = styleTarget();
    el.style.setProperty("--ask-bottom-bar-h", "52px");
    el.style.setProperty("--ask-bottom-occlusion", "120px");

    const written = writeAskRootVars(
      {
        "--ask-bottom-bar-h": "52px",
        "--ask-bottom-occlusion": "0px",
        "--ask-player-bar-h": "60px",
      },
      el.style,
    );

    expect(written).toEqual(["--ask-player-bar-h", "--ask-bottom-occlusion"]);
    expect(el.style.getPropertyValue("--ask-player-bar-h")).toBe("60px");
    expect(el.style.getPropertyValue("--ask-bottom-bar-h")).toBe("52px");
    expect(el.style.getPropertyValue("--ask-bottom-occlusion")).toBe("0px");
  });

  test("writeAskRootVars reads every current inline value before any setProperty", () => {
    const el = styleTarget();
    el.style.setProperty("--ask-bottom-bar-h", "10px");
    el.style.setProperty("--ask-bottom-occlusion", "20px");
    const order: string[] = [];
    const rawGet = el.style.getPropertyValue.bind(el.style);
    const rawSet = el.style.setProperty.bind(el.style);
    vi.spyOn(el.style, "getPropertyValue").mockImplementation((property: string) => {
      order.push(`read:${property}`);
      return rawGet(property);
    });
    vi.spyOn(el.style, "setProperty").mockImplementation((property: string, value: string | null, priority?: string) => {
      order.push(`write:${property}`);
      return rawSet(property, value, priority);
    });

    const written = writeAskRootVars(
      {
        "--ask-player-bar-h": "4px",
        "--ask-bottom-bar-h": "10px",
        "--ask-bottom-occlusion": "30px",
      },
      el.style,
    );

    expect(written).toEqual(["--ask-player-bar-h", "--ask-bottom-occlusion"]);
    const firstWrite = order.findIndex((entry) => entry.startsWith("write:"));
    expect(firstWrite).toBeGreaterThan(0);
    expect(order.slice(0, firstWrite).every((entry) => entry.startsWith("read:"))).toBe(true);
    expect(order.slice(firstWrite).some((entry) => entry.startsWith("read:"))).toBe(false);
    expect(order.filter((entry) => entry.startsWith("read:"))).toEqual([
      "read:--ask-player-bar-h",
      "read:--ask-bottom-bar-h",
      "read:--ask-bottom-occlusion",
    ]);
  });

  test("selectingRootVarsFromCache returns null until every field the formula needs is filled", () => {
    const empty = createAskMeasureCache();
    expect(selectingRootVarsFromCache(empty, true)).toBeNull();

    const missingBar: AskMeasureCache = {
      isMobile: true,
      keyboardOpen: false,
      playerHeight: 164,
      barHeight: null,
    };
    expect(selectingRootVarsFromCache(missingBar, true)).toBeNull();

    const missingKeyboard: AskMeasureCache = { ...missingBar, barHeight: 60, keyboardOpen: null };
    expect(selectingRootVarsFromCache(missingKeyboard, true)).toBeNull();
  });

  test("selectingRootVarsFromCache publishes 0px when inactive, desktop, or the keyboard is open", () => {
    const mobile: AskMeasureCache = {
      isMobile: true,
      keyboardOpen: false,
      playerHeight: 164,
      barHeight: 60,
    };
    const zero = { "--ask-bottom-bar-h": "0px", "--ask-bottom-occlusion": "0px" };
    expect(selectingRootVarsFromCache(mobile, false)).toEqual(zero);
    expect(selectingRootVarsFromCache({ ...mobile, isMobile: false, playerHeight: null, barHeight: null }, true)).toEqual(zero);
    expect(selectingRootVarsFromCache({ ...mobile, keyboardOpen: true }, true)).toEqual(zero);
  });

  test("selectingRootVarsFromCache uses computeBottomOcclusion with a zero panel", () => {
    const playerHeight = 164;
    const barHeight = 60;
    expect(computeBottomOcclusion({ playerHeight, barHeight, panelHeight: 0 })).toBe(232);
    expect(
      selectingRootVarsFromCache(
        { isMobile: true, keyboardOpen: false, playerHeight, barHeight },
        true,
      ),
    ).toEqual({
      "--ask-bottom-bar-h": "60px",
      "--ask-bottom-occlusion": "232px",
    });
  });

  test("invalidateAskMeasureCache nulls every field", () => {
    const cache = createAskMeasureCache();
    expect(cache).toEqual({ isMobile: null, keyboardOpen: null, playerHeight: null, barHeight: null });
    cache.isMobile = true;
    cache.keyboardOpen = false;
    cache.playerHeight = 164;
    cache.barHeight = 60;
    invalidateAskMeasureCache(cache);
    expect(cache).toEqual({ isMobile: null, keyboardOpen: null, playerHeight: null, barHeight: null });
  });

  test("applyAskSelectingRootVars defers when the cache is incomplete and writes when it is not", () => {
    const el = styleTarget();
    const cache = createAskMeasureCache();

    expect(applyAskSelectingRootVars(cache, true, el.style)).toEqual({ written: [], deferred: true });
    expect(el.style.getPropertyValue("--ask-bottom-bar-h")).toBe("");
    expect(el.style.getPropertyValue("--ask-bottom-occlusion")).toBe("");

    cache.isMobile = true;
    cache.keyboardOpen = false;
    cache.playerHeight = 164;
    cache.barHeight = 60;
    expect(applyAskSelectingRootVars(cache, true, el.style)).toEqual({
      written: ["--ask-bottom-bar-h", "--ask-bottom-occlusion"],
      deferred: false,
    });
    expect(el.style.getPropertyValue("--ask-bottom-occlusion")).toBe("232px");

    expect(applyAskSelectingRootVars(cache, true, el.style)).toEqual({ written: [], deferred: false });
  });
});
