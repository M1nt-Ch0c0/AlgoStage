// @vitest-environment happy-dom
import { afterEach, describe, expect, test, vi } from "vitest";
import { getAskBottomObstacle, getAskBottomOcclusion, measureAskElementHeight, measureAskPlayerBarHeight } from "../lib/ask/ask-occlusion";

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
