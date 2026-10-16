// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AskSelection, AskTarget } from "@/lib/ask/types";
import {
  CAPTURE_DEFAULTS,
  CAPTURE_EXCLUDE_SELECTOR,
  CAPTURE_FALLBACK_NOTICE,
  buildFallbackText,
  captureStage,
  isCaptureExcluded,
  decodedBase64Bytes,
  encodeOffThread,
  CAPTURE_SPACER_HEIGHT_ATTR,
  intersectsBBox,
  resolveStageBackground,
  toCropRect,
} from "@/lib/ask/capture";
import { resetLongTaskEndForTests } from "@/lib/ask/ask-timing";
import { resetEncodeWorkerForTests } from "@/lib/ask/capture-worker";
import type { EncodeRequest, EncodeResponse } from "@/lib/ask/capture-encode";

const { mockState, domToCanvasMock } = vi.hoisted(() => ({
  mockState: { shouldThrow: false },
  domToCanvasMock: vi.fn(),
}));

vi.mock("modern-screenshot", () => {
  if (mockState.shouldThrow) {
    throw new Error("Failed to load modern-screenshot");
  }
  return {
    domToCanvas: domToCanvasMock,
  };
});

describe("lib/ask/capture", () => {
  let container: HTMLDivElement;
  let sourceCanvas: {
    width: number;
    height: number;
    getContext: ReturnType<typeof vi.fn>;
  };
  let createdCanvases: Array<{
    width: number;
    height: number;
    getContext: ReturnType<typeof vi.fn>;
    toDataURL: ReturnType<typeof vi.fn>;
  }>;
  let drawImageMock: ReturnType<typeof vi.fn>;
  let contextMock: { drawImage: ReturnType<typeof vi.fn> };
  let originalCreateElement: typeof document.createElement;

  beforeEach(() => {
    mockState.shouldThrow = false;
    domToCanvasMock.mockReset();

    container = document.createElement("div");
    container.getBoundingClientRect = vi.fn(() => ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 200,
      bottom: 200,
      width: 200,
      height: 200,
      toJSON: () => {},
    }));

    sourceCanvas = {
      width: 400,
      height: 400,
      getContext: vi.fn(),
    };
    domToCanvasMock.mockResolvedValue(sourceCanvas);

    drawImageMock = vi.fn();
    contextMock = { drawImage: drawImageMock };
    createdCanvases = [];

    originalCreateElement = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tagName: string) => {
      if (tagName.toLowerCase() === "canvas") {
        const fakeCanvas = {
          width: 0,
          height: 0,
          getContext: vi.fn((type: string) => {
            if (type === "2d") return contextMock;
            return null;
          }),
          toDataURL: vi.fn((mime: string, _q?: number) => {
            return `data:${mime};base64,AAAA`;
          }),
        };
        createdCanvases.push(fakeCanvas);
        return fakeCanvas as unknown as HTMLCanvasElement;
      }
      return originalCreateElement(tagName);
    });
  });

  afterEach(() => {
    resetEncodeWorkerForTests();
    resetLongTaskEndForTests();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const codeTarget = (id: string, text?: string): AskTarget => ({
    kind: "code",
    id,
    text,
  });

  const baseSel: Pick<AskSelection, "bbox" | "targets"> = {
    bbox: { x: 10, y: 20, width: 30, height: 40 },
    targets: [codeTarget("t1", "Code target")],
  };

  it("exports constants properly", () => {
    expect(CAPTURE_FALLBACK_NOTICE).toBe("没截到图，这次只发送选中的文字。");
    expect(CAPTURE_DEFAULTS.maxBytes).toBe(400 * 1024);
    expect(CAPTURE_DEFAULTS.maxLongSide).toBe(1280);
    expect(CAPTURE_DEFAULTS.qualities).toEqual([0.85, 0.7, 0.55]);
    expect(CAPTURE_DEFAULTS.downscaleFactor).toBe(0.75);
    expect(CAPTURE_DEFAULTS.maxDownscales).toBe(2);
    expect(CAPTURE_DEFAULTS.maxNodes).toBe(1500);
  });

  describe("buildFallbackText", () => {
    it("handles empty targets", () => {
      expect(buildFallbackText([])).toBe("");
    });

    it("drops empty and whitespace-only targets, and targets without text", () => {
      const targets: AskTarget[] = [
        { kind: "code", id: "1", text: "" },
        { kind: "code", id: "2", text: "   " },
        { kind: "viz", id: "3" },
        { kind: "step", id: "4", text: "valid text" },
      ];
      expect(buildFallbackText(targets)).toBe("valid text");
    });

    it("truncates text longer than 200 chars and limits to 20 targets", () => {
      const longText = "a".repeat(250);
      const targets: AskTarget[] = Array.from({ length: 25 }, (_, i) => ({
        kind: "code",
        id: `t-${i}`,
        text: `Target ${i}: ${longText}`,
      }));

      const res = buildFallbackText(targets);
      const lines = res.split("\n");
      expect(lines).toHaveLength(20);
      for (const line of lines) {
        expect(line.length).toBe(200);
      }
    });
  });

  describe("decodedBase64Bytes", () => {
    it("computes decoded byte length with 0, 1, and 2 '=' padding", () => {
      expect(decodedBase64Bytes("")).toBe(0);
      // 'AAAA' -> 3 bytes, 0 padding
      expect(decodedBase64Bytes("AAAA")).toBe(3);
      // 'AAA=' -> 2 bytes, 1 padding
      expect(decodedBase64Bytes("AAA=")).toBe(2);
      // 'AA==' -> 1 byte, 2 padding
      expect(decodedBase64Bytes("AA==")).toBe(1);
      // longer strings
      expect(decodedBase64Bytes("AAAA" + "AAAA")).toBe(6);
      expect(decodedBase64Bytes("AAAA" + "AAA=")).toBe(5);
      expect(decodedBase64Bytes("AAAA" + "AA==")).toBe(4);
    });
  });

  describe("intersectsBBox", () => {
    const containerRect = { left: 100, top: 50, width: 400, height: 300 };

    it("keeps a rect that overlaps the normalized selection", () => {
      expect(
        intersectsBBox(
          { left: 120, top: 70, width: 40, height: 20 },
          containerRect,
          { x: 50, y: 40, width: -30, height: -20 },
        ),
      ).toBe(true);
    });

    it("drops a rect that only touches an edge", () => {
      expect(
        intersectsBBox(
          { left: 140, top: 50, width: 10, height: 20 },
          containerRect,
          { x: 10, y: 20, width: 30, height: 40 },
        ),
      ).toBe(false);
    });
  });

  describe("resolveStageBackground", () => {
    function stubComputed(colors: Map<Element, string>, variable = "") {
      vi.spyOn(window, "getComputedStyle").mockImplementation((el: Element) => {
        const backgroundColor = colors.get(el) ?? "rgba(0, 0, 0, 0)";
        return {
          backgroundColor,
          getPropertyValue: (name: string) => (name === "--color-board-950" ? variable : ""),
        } as CSSStyleDeclaration;
      });
    }

    it("uses the first opaque ancestor when the stage itself is transparent", () => {
      const grand = document.createElement("div");
      const parent = document.createElement("div");
      const stage = document.createElement("div");
      grand.append(parent);
      parent.append(stage);
      document.body.append(grand);
      stubComputed(
        new Map<Element, string>([
          [stage, "transparent"],
          [parent, "rgba(0, 0, 0, 0)"],
          [grand, "rgb(18, 27, 24)"],
        ]),
      );

      expect(resolveStageBackground(stage)).toBe("rgb(18, 27, 24)");
      grand.remove();
    });

    it("keeps the stage color when it is the first painted background", () => {
      const parent = document.createElement("div");
      const stage = document.createElement("div");
      parent.append(stage);
      document.body.append(parent);
      stubComputed(
        new Map<Element, string>([
          [stage, "rgb(12, 19, 17)"],
          [parent, "rgb(255, 0, 0)"],
        ]),
      );

      expect(resolveStageBackground(stage)).toBe("rgb(12, 19, 17)");
      parent.remove();
    });

    it("accepts a semi-transparent color without compositing it", () => {
      const stage = document.createElement("div");
      document.body.append(stage);
      stubComputed(new Map<Element, string>([[stage, "rgba(18, 27, 24, 0.95)"]]));

      expect(resolveStageBackground(stage)).toBe("rgba(18, 27, 24, 0.95)");
      stage.remove();
    });

    it("falls back to --color-board-950, then #000, when every ancestor is transparent", () => {
      const stage = document.createElement("div");
      document.body.append(stage);
      stubComputed(new Map(), "#0c1311");
      expect(resolveStageBackground(stage)).toBe("#0c1311");

      stubComputed(new Map(), "   ");
      expect(resolveStageBackground(stage)).toBe("#000");
      stage.remove();
    });
  });

  describe("toCropRect", () => {
    it("normalizes negative bbox and multiplies by scale", () => {
      const flipped = { x: 50, y: 50, width: -40, height: -30 };
      const rect = toCropRect(flipped, 2, 3);
      expect(rect).toEqual({
        x: 10 * 2,
        y: 20 * 3,
        width: 40 * 2,
        height: 30 * 3,
      });
    });
  });

  describe("captureStage success flows", () => {
    it("handles crop coords with negative bbox and scale 2, calling drawImage with correct coords", async () => {
      // container: 200x200, sourceCanvas: 400x400 => scaleX=2, scaleY=2
      const flipped: Pick<AskSelection, "bbox" | "targets"> = {
        bbox: { x: 50, y: 50, width: -40, height: -30 },
        targets: [codeTarget("t1", "hello")],
      };

      const res = await captureStage(container, flipped);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.encoder).toBe("main");
        expect(res.image.mime).toBe("image/webp");
        expect(res.image.dataBase64).toBe("AAAA");
        expect(res.bytes).toBe(3);
      }
      expect(window.__s4Capture).toEqual({
        encoder: "main",
        mime: "image/webp",
        bytes: 3,
        devicePixelRatio: 1,
        scale: 1,
        crop: { x: 20, y: 40, w: 80, h: 60 },
        canvas: { width: 400, height: 400 },
      });

      // Normalized bbox: x=10, y=20, w=40, h=30 -> scale 2 -> x=20, y=40, w=80, h=60
      expect(drawImageMock).toHaveBeenCalledWith(
        sourceCanvas,
        20,
        40,
        80,
        60,
        0,
        0,
        80,
        60,
      );
    });

    it("clamps crop rect to canvas bounds", async () => {
      // container 200x200, canvas 400x400 (scale 2)
      // bbox: x=-10, y=10, w=100, h=50 -> crop: x=-20, y=20, w=200, h=100
      // Clamped x: Math.max(0, -20) = 0.
      // cropRight: min(400, -20 + 200 = 180) = 180.
      // cropW: 180 - 0 = 180.
      // cropY: 20, cropBottom: 20 + 100 = 120, cropH: 100.
      const sel: Pick<AskSelection, "bbox" | "targets"> = {
        bbox: { x: -10, y: 10, width: 100, height: 50 },
        targets: [codeTarget("c1")],
      };

      const res = await captureStage(container, sel);
      expect(res.ok).toBe(true);
      expect(drawImageMock).toHaveBeenCalledWith(
        sourceCanvas,
        0,
        20,
        180,
        100,
        0,
        0,
        180,
        100,
      );
    });

    it("downscales output when long side exceeds 1280 (never upscales)", async () => {
      // source canvas 3000 x 1500, container 1000 x 500 (scale 3)
      sourceCanvas.width = 3000;
      sourceCanvas.height = 1500;
      container.getBoundingClientRect = vi.fn(() => ({
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 1000,
        bottom: 500,
        width: 1000,
        height: 500,
        toJSON: () => {},
      }));

      // bbox covers whole 1000x500 -> crop 3000x1500
      const sel: Pick<AskSelection, "bbox" | "targets"> = {
        bbox: { x: 0, y: 0, width: 1000, height: 500 },
        targets: [],
      };

      const res = await captureStage(container, sel);
      expect(res.ok).toBe(true);

      // Long side is 3000 > 1280. initialScale = 1280 / 3000 = 0.4266666...
      // outW = Math.round(3000 * (1280 / 3000)) = 1280
      // outH = Math.round(1500 * (1280 / 3000)) = 640
      expect(drawImageMock).toHaveBeenCalledWith(
        sourceCanvas,
        0,
        0,
        3000,
        1500,
        0,
        0,
        1280,
        640,
      );
      const lastCanvas = createdCanvases[createdCanvases.length - 1];
      expect(lastCanvas.width).toBe(1280);
      expect(lastCanvas.height).toBe(640);
    });

    it("steps through qualities 0.85 -> 0.7 -> 0.55 until bytes <= maxBytes", async () => {
      const calls: number[] = [];
      vi.spyOn(document, "createElement").mockImplementation((tagName: string) => {
        if (tagName.toLowerCase() === "canvas") {
          return {
            width: 0,
            height: 0,
            getContext: vi.fn(() => contextMock),
            toDataURL: vi.fn((mime: string, q?: number) => {
              calls.push(q ?? 1);
              if (q === 0.85) {
                // 400 base64 chars -> 300 decoded bytes (> 200)
                return `data:${mime};base64,` + "A".repeat(400);
              }
              // 200 base64 chars -> 150 decoded bytes (<= 200)
              return `data:${mime};base64,` + "A".repeat(200);
            }),
          } as unknown as HTMLCanvasElement;
        }
        return originalCreateElement(tagName);
      });

      const res = await captureStage(container, baseSel, { maxBytes: 200 });
      expect(res.ok).toBe(true);
      expect(calls).toEqual([0.85, 0.7]);
      if (res.ok) {
        expect(res.bytes).toBe(150);
      }
    });

    it("switches to jpeg when webp is unsupported and stays on jpeg for subsequent qualities", async () => {
      const calls: Array<{ mime: string; q: number }> = [];
      vi.spyOn(document, "createElement").mockImplementation((tagName: string) => {
        if (tagName.toLowerCase() === "canvas") {
          return {
            width: 0,
            height: 0,
            getContext: vi.fn(() => contextMock),
            toDataURL: vi.fn((mime: string, q?: number) => {
              calls.push({ mime, q: q ?? 1 });
              if (mime === "image/webp") {
                // Unsupported in browser: returns data:image/png
                return "data:image/png;base64,AAAA";
              }
              if (mime === "image/jpeg" && q === 0.85) {
                // Exceed max bytes: 400 base64 chars -> 300 bytes (> 100)
                return "data:image/jpeg;base64," + "A".repeat(400);
              }
              // 80 base64 chars -> 60 bytes (<= 100)
              return "data:image/jpeg;base64," + "A".repeat(80);
            }),
          } as unknown as HTMLCanvasElement;
        }
        return originalCreateElement(tagName);
      });

      const res = await captureStage(container, baseSel, { maxBytes: 100 });
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.image.mime).toBe("image/jpeg");
        expect(res.bytes).toBe(60);
      }

      // Quality 0.85 tested webp -> unsupported -> fell back to jpeg (too large)
      // Quality 0.7 should directly use jpeg without testing webp again
      expect(calls).toEqual([
        { mime: "image/webp", q: 0.85 },
        { mime: "image/jpeg", q: 0.85 },
        { mime: "image/jpeg", q: 0.7 },
      ]);
    });

    it("accepts an image where base64 length > maxBytes but decoded bytes <= maxBytes", async () => {
      // 4 base64 chars = 3 decoded bytes.
      // If maxBytes = 3, and dataBase64 = "AAAA" (length 4):
      // base64.length (4) > maxBytes (3), but decodedBase64Bytes (3) <= maxBytes (3).
      const res = await captureStage(container, baseSel, { maxBytes: 3 });
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.image.dataBase64).toBe("AAAA");
        expect(res.image.dataBase64.length).toBe(4);
        expect(res.bytes).toBe(3);
      }
    });

    it("falls back to scale 1 when container rect dimensions are 0 or non-finite", async () => {
      container.getBoundingClientRect = vi.fn(() => ({
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        width: 0,
        height: NaN,
        toJSON: () => {},
      }));

      const res = await captureStage(container, baseSel);
      expect(res.ok).toBe(true);
      // scaleX = 1, scaleY = 1. bbox is 10, 20, 30, 40
      expect(drawImageMock).toHaveBeenCalledWith(
        sourceCanvas,
        10,
        20,
        30,
        40,
        0,
        0,
        30,
        40,
      );
    });
  });

  describe("downscaling and fail reasons", () => {
    it("downscales x0.75 up to 2 times, then fails with TOO_LARGE if still too big", async () => {
      const drawnSizes: Array<{ w: number; h: number }> = [];
      vi.spyOn(document, "createElement").mockImplementation((tagName: string) => {
        if (tagName.toLowerCase() === "canvas") {
          return {
            width: 0,
            height: 0,
            getContext: vi.fn(() => ({
              drawImage: vi.fn((_src, _sx, _sy, _sw, _sh, _dx, _dy, dw, dh) => {
                drawnSizes.push({ w: dw, h: dh });
              }),
            })),
            toDataURL: vi.fn((mime: string) => {
              // Always too large (1000 bytes)
              return `data:${mime};base64,` + "A".repeat(1000 * 4 / 3);
            }),
          } as unknown as HTMLCanvasElement;
        }
        return originalCreateElement(tagName);
      });

      // bbox width 100, height 100, scale 1 (container 200x200, canvas 200x200)
      sourceCanvas.width = 200;
      sourceCanvas.height = 200;

      const sel: Pick<AskSelection, "bbox" | "targets"> = {
        bbox: { x: 0, y: 0, width: 100, height: 100 },
        targets: [{ kind: "step", id: "s1", text: "Fallback text" }],
      };

      const res = await captureStage(container, sel, { maxBytes: 100 });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.reason).toBe("TOO_LARGE");
        expect(res.fallbackText).toBe("Fallback text");
      }

      // Initial attempt 0: 100 x 100
      // Downscale 1 (attempt 1): round(100 * 0.75) = 75 x 75
      // Downscale 2 (attempt 2): round(75 * 0.75) = 56 x 56
      expect(drawnSizes).toEqual([
        { w: 100, h: 100 },
        { w: 75, h: 75 },
        { w: 56, h: 56 },
      ]);
    });

    it("fails with NO_CONTAINER when container is null", async () => {
      const res = await captureStage(null, baseSel);
      expect(res).toEqual({
        ok: false,
        reason: "NO_CONTAINER",
        fallbackText: "Code target",
      });
    });

    it("fails with EMPTY_BBOX when normalized bbox has zero or negative dimensions", async () => {
      const zeroW = await captureStage(container, {
        bbox: { x: 10, y: 10, width: 0, height: 20 },
        targets: [codeTarget("t1", "zero width")],
      });
      expect(zeroW).toEqual({
        ok: false,
        reason: "EMPTY_BBOX",
        fallbackText: "zero width",
      });

      const zeroH = await captureStage(container, {
        bbox: { x: 10, y: 10, width: 20, height: 0 },
        targets: [codeTarget("t2", "zero height")],
      });
      expect(zeroH).toEqual({
        ok: false,
        reason: "EMPTY_BBOX",
        fallbackText: "zero height",
      });
    });

    it("fails with EMPTY_BBOX when crop rect is outside canvas after clamping", async () => {
      // bbox x=500 is completely outside 400px canvas (cropW <= 0)
      const resX = await captureStage(container, {
        bbox: { x: 500, y: 10, width: 50, height: 50 },
        targets: [codeTarget("t1", "outside X")],
      });
      expect(resX).toEqual({
        ok: false,
        reason: "EMPTY_BBOX",
        fallbackText: "outside X",
      });

      // bbox y=500 is completely outside 400px canvas (cropW > 0, but cropH <= 0)
      const resY = await captureStage(container, {
        bbox: { x: 10, y: 500, width: 50, height: 50 },
        targets: [codeTarget("t2", "outside Y")],
      });
      expect(resY).toEqual({
        ok: false,
        reason: "EMPTY_BBOX",
        fallbackText: "outside Y",
      });
    });

    it("fails with IMPORT_FAILED when dynamic import of modern-screenshot fails", async () => {
      vi.resetModules();
      vi.doMock("modern-screenshot", () => {
        throw new Error("Cannot load module");
      });
      const { captureStage: dynamicCapture } = await import("@/lib/ask/capture");
      const res = await dynamicCapture(container, baseSel);
      expect(res).toEqual({
        ok: false,
        reason: "IMPORT_FAILED",
        fallbackText: "Code target",
      });
      vi.resetModules();
      vi.doMock("modern-screenshot", () => ({
        domToCanvas: domToCanvasMock,
      }));
    });

    it("fails with RENDER_FAILED when domToCanvas rejects", async () => {
      domToCanvasMock.mockRejectedValue(new Error("domToCanvas error"));
      const res = await captureStage(container, baseSel);
      expect(res).toEqual({
        ok: false,
        reason: "RENDER_FAILED",
        fallbackText: "Code target",
      });
    });

    it("fails with RENDER_FAILED when domToCanvas resolves with non-canvas", async () => {
      // Resolves with null
      domToCanvasMock.mockResolvedValue(null);
      const resNull = await captureStage(container, baseSel);
      expect(resNull).toEqual({
        ok: false,
        reason: "RENDER_FAILED",
        fallbackText: "Code target",
      });

      // Resolves with plain object without getContext
      domToCanvasMock.mockResolvedValue({ width: 100, height: 100 });
      const resObj = await captureStage(container, baseSel);
      expect(resObj).toEqual({
        ok: false,
        reason: "RENDER_FAILED",
        fallbackText: "Code target",
      });
    });

    it("fails with RENDER_FAILED when an unexpected error occurs during rendering", async () => {
      // Make drawImage throw
      drawImageMock.mockImplementation(() => {
        throw new Error("Canvas render crashed");
      });
      const res = await captureStage(container, baseSel);
      expect(res).toEqual({
        ok: false,
        reason: "RENDER_FAILED",
        fallbackText: "Code target",
      });
    });

    it("fails with NO_CONTEXT when outCanvas getContext('2d') returns null", async () => {
      vi.spyOn(document, "createElement").mockImplementation((tagName: string) => {
        if (tagName.toLowerCase() === "canvas") {
          return {
            width: 0,
            height: 0,
            getContext: vi.fn(() => null),
          } as unknown as HTMLCanvasElement;
        }
        return originalCreateElement(tagName);
      });

      const res = await captureStage(container, baseSel);
      expect(res).toEqual({
        ok: false,
        reason: "NO_CONTEXT",
        fallbackText: "Code target",
      });
    });

    it("fails with TIMEOUT when domToCanvas hangs longer than timeoutMs", async () => {
      vi.useFakeTimers();
      domToCanvasMock.mockImplementation(() => new Promise(() => {})); // never resolves

      const promise = captureStage(container, baseSel);
      await vi.advanceTimersByTimeAsync(3001);
      const res = await promise;

      expect(res).toEqual({
        ok: false,
        reason: "TIMEOUT",
        fallbackText: "Code target",
      });
    });

    it("aborts when domToCanvas resolves after timeout fired without creating or drawing canvas", async () => {
      vi.useFakeTimers();

      let resolveDeferredCanvas!: (canvas: unknown) => void;
      const deferredCanvas = new Promise((resolve) => {
        resolveDeferredCanvas = resolve;
      });
      domToCanvasMock.mockImplementation(() => deferredCanvas);

      const toDataURLSpy = vi.fn(() => "data:image/webp;base64,AAAA");
      const createElementSpy = vi.spyOn(document, "createElement").mockImplementation((tagName: string) => {
        if (tagName.toLowerCase() === "canvas") {
          const fakeCanvas = {
            width: 0,
            height: 0,
            getContext: vi.fn((type: string) => {
              if (type === "2d") return contextMock;
              return null;
            }),
            toDataURL: toDataURLSpy,
          };
          createdCanvases.push(fakeCanvas);
          return fakeCanvas as unknown as HTMLCanvasElement;
        }
        return originalCreateElement(tagName);
      });
      const getBoundingClientRectSpy = vi.spyOn(container, "getBoundingClientRect");

      const promise = captureStage(container, baseSel, { timeoutMs: 1000 });
      await vi.advanceTimersByTimeAsync(1001);
      const res = await promise;

      expect(res).toEqual({
        ok: false,
        reason: "TIMEOUT",
        fallbackText: "Code target",
      });

      drawImageMock.mockClear();
      createElementSpy.mockClear();
      getBoundingClientRectSpy.mockClear();
      toDataURLSpy.mockClear();
      createdCanvases = [];

      // Resolve deferred canvas after timeout has already resolved
      resolveDeferredCanvas(sourceCanvas);

      // Flush microtasks
      await Promise.resolve();
      await Promise.resolve();

      expect(getBoundingClientRectSpy).not.toHaveBeenCalled();
      const canvasCalls = createElementSpy.mock.calls.filter(
        ([tag]) => typeof tag === "string" && tag.toLowerCase() === "canvas",
      );
      expect(canvasCalls).toHaveLength(0);
      expect(drawImageMock).not.toHaveBeenCalled();
      expect(toDataURLSpy).not.toHaveBeenCalled();
      expect(createdCanvases).toHaveLength(0);
    });

    it("aborts when dynamic import resolves after timeout fired without calling domToCanvas", async () => {
      vi.useFakeTimers();
      vi.resetModules();

      let resolveDeferredImport!: (mod: unknown) => void;
      const deferredImport = new Promise((resolve) => {
        resolveDeferredImport = resolve;
      });

      vi.doMock("modern-screenshot", () => deferredImport);

      const localDomToCanvas = vi.fn();
      const { captureStage: dynamicCapture } = await import("@/lib/ask/capture");

      const promise = dynamicCapture(container, baseSel, { timeoutMs: 1000 });
      await vi.advanceTimersByTimeAsync(1001);
      const res = await promise;

      expect(res).toEqual({
        ok: false,
        reason: "TIMEOUT",
        fallbackText: "Code target",
      });

      // Resolve the import after timeout
      resolveDeferredImport({ domToCanvas: localDomToCanvas });

      await Promise.resolve();
      await Promise.resolve();

      expect(localDomToCanvas).not.toHaveBeenCalled();

      vi.resetModules();
      vi.doMock("modern-screenshot", () => ({
        domToCanvas: domToCanvasMock,
      }));
    });

    it("records clone, embed, svg, and raster phases when the timing probe is installed", async () => {
      const child = document.createElement("span");
      const nested = document.createElement("em");
      child.append(nested);
      container.append(child);

      const probe: {
        captureCloneMs?: number;
        captureEmbedMs?: number;
        captureSvgMs?: number;
        captureRasterMs?: number;
        captureSourceNodes?: number;
        captureClonedNodes?: number;
      } = {};
      window.__ASK_TIMING__ = probe;

      const order: string[] = [];
      domToCanvasMock.mockImplementation(async (_node: unknown, options: {
        onCloneEachNode?: () => void;
        onCloneNode?: () => void;
        onEmbedNode?: () => void;
        onCreateForeignObjectSvg?: () => void;
      }) => {
        options.onCloneEachNode?.();
        options.onCloneEachNode?.();
        options.onCloneEachNode?.();
        order.push("each");
        options.onCloneNode?.();
        order.push("clone");
        options.onEmbedNode?.();
        order.push("embed");
        options.onCreateForeignObjectSvg?.();
        order.push("svg");
        return sourceCanvas;
      });

      const res = await captureStage(container, baseSel);
      expect(res.ok).toBe(true);
      expect(order).toEqual(["each", "clone", "embed", "svg"]);
      expect(probe.captureCloneMs).toEqual(expect.any(Number));
      expect(probe.captureEmbedMs).toEqual(expect.any(Number));
      expect(probe.captureSvgMs).toEqual(expect.any(Number));
      expect(probe.captureRasterMs).toEqual(expect.any(Number));
      expect(probe.captureCloneMs).toBeGreaterThanOrEqual(0);
      expect(probe.captureEmbedMs).toBeGreaterThanOrEqual(0);
      expect(probe.captureSvgMs).toBeGreaterThanOrEqual(0);
      expect(probe.captureRasterMs).toBeGreaterThanOrEqual(0);
      expect(probe.captureClonedNodes).toBe(3);
      expect(probe.captureSourceNodes).toBe(container.querySelectorAll("*").length);

      delete window.__ASK_TIMING__;
    });

    it("stores the pre-encode crop canvas on the timing probe and skips it when the probe is absent", async () => {
      const probe: { captureCanvas?: HTMLCanvasElement } = {};
      window.__ASK_TIMING__ = probe;
      const res = await captureStage(container, baseSel);
      expect(res.ok).toBe(true);
      const stored = probe.captureCanvas;
      expect(stored).toBeDefined();
      // scale 1, container 200×200, source canvas 400×400 → crop is 2× the CSS bbox.
      expect(stored?.width).toBe(60);
      expect(stored?.height).toBe(80);
      const cropDraw = drawImageMock.mock.calls.find(
        (call) => call[0] === sourceCanvas && call[3] === 60 && call[4] === 80,
      );
      expect(cropDraw).toBeDefined();

      delete window.__ASK_TIMING__;
      const bare = await captureStage(container, baseSel);
      expect(bare.ok).toBe(true);
      expect(window.__ASK_TIMING__).toBeUndefined();
      // The second capture has no probe, so it does not store a canvas.
      expect(probe.captureCanvas).toBe(stored);
    });

    it("calls domToCanvas with font:false, scale:1, and a filter that drops non-intersecting / iframe / video", async () => {
      const hitRect = () =>
        ({ left: 20, top: 30, width: 10, height: 10, right: 30, bottom: 40, x: 20, y: 30, toJSON() {} }) as DOMRect;
      const missRect = () =>
        ({ left: 180, top: 180, width: 10, height: 10, right: 190, bottom: 190, x: 180, y: 180, toJSON() {} }) as DOMRect;

      const inside = document.createElement("div");
      const outside = document.createElement("span");
      const frame = document.createElement("iframe");
      const clip = document.createElement("video");
      const monacoRoot = document.createElement("div");
      monacoRoot.className = "monaco-editor";
      const monacoChild = document.createElement("div");
      monacoChild.className = "view-lines";
      monacoRoot.appendChild(monacoChild);
      const text = document.createTextNode("kept");

      inside.getBoundingClientRect = hitRect;
      outside.getBoundingClientRect = missRect;
      frame.getBoundingClientRect = hitRect;
      clip.getBoundingClientRect = hitRect;
      monacoRoot.getBoundingClientRect = hitRect;
      monacoChild.getBoundingClientRect = hitRect;

      // Must be in the container so the pre-render walk populates `dropped`.
      container.append(inside, outside, frame, clip, monacoRoot, text);

      const res = await captureStage(container, baseSel);
      expect(res.ok).toBe(true);
      expect(domToCanvasMock).toHaveBeenCalledTimes(1);
      const options = domToCanvasMock.mock.calls[0]?.[1] as {
        font: unknown;
        scale: number;
        backgroundColor: string;
        features: { restoreScrollPosition: boolean };
        filter: (node: Node) => boolean;
        timeout: number;
        width: number;
        height: number;
      };
      expect(options.font).toBe(false);
      expect(options.scale).toBe(1);
      expect(options.features).toEqual({ restoreScrollPosition: false });
      expect(options.backgroundColor).toBe(resolveStageBackground(container));
      expect(typeof options.backgroundColor).toBe("string");
      expect(options.backgroundColor.length).toBeGreaterThan(0);
      expect(options.width).toBe(200);
      expect(options.height).toBe(200);
      expect(options.timeout).toBeLessThanOrEqual(CAPTURE_DEFAULTS.timeoutMs);
      expect(options.timeout).toBeGreaterThan(0);
      expect(options.filter(inside)).toBe(true);
      expect(options.filter(outside)).toBe(false);
      expect(options.filter(frame)).toBe(false);
      expect(options.filter(clip)).toBe(false);
      // Monaco stays in the clone. Dropping it collapses the code-board flex
      // child. The raster blanks it in place instead (see the visibility test).
      expect(options.filter(monacoRoot)).toBe(true);
      expect(options.filter(monacoChild)).toBe(true);
      expect(options.filter(text)).toBe(true);
    });

    it("hides each .monaco-editor with visibility during the raster and restores it after", async () => {
      const hitRect = () =>
        ({ left: 20, top: 30, width: 10, height: 10, right: 30, bottom: 40, x: 20, y: 30, toJSON() {} }) as DOMRect;
      const monacoRoot = document.createElement("div");
      monacoRoot.className = "monaco-editor";
      monacoRoot.style.visibility = "visible";
      const monacoChild = document.createElement("div");
      monacoChild.className = "view-lines";
      monacoRoot.appendChild(monacoChild);
      monacoRoot.getBoundingClientRect = hitRect;
      monacoChild.getBoundingClientRect = hitRect;
      container.append(monacoRoot);
      // querySelector only sees a connected tree.
      document.body.append(container);

      let visibilityDuringRaster = "";
      domToCanvasMock.mockImplementation(async () => {
        visibilityDuringRaster = monacoRoot.style.visibility;
        return sourceCanvas;
      });

      const res = await captureStage(container, baseSel);
      expect(res.ok).toBe(true);
      // Hidden while the clone reads computed style, so the box stays and
      // the glyphs do not paint. Restored once the raster returns.
      expect(visibilityDuringRaster).toBe("hidden");
      expect(monacoRoot.style.visibility).toBe("visible");
      container.remove();
    });

    it("clears the selection chrome box-shadow, border, and outline during the raster and restores them", async () => {
      const hitRect = () =>
        ({ left: 20, top: 30, width: 10, height: 10, right: 30, bottom: 40, x: 20, y: 30, toJSON() {} }) as DOMRect;
      const layer = document.createElement("div");
      layer.setAttribute("data-ask-layer", "");
      const selection = document.createElement("div");
      selection.setAttribute("data-ask-selection", "");
      selection.setAttribute("data-ask-capture-exclude", "");
      selection.style.boxShadow = "0 0 0 9999px rgba(0,0,0,0.4)";
      selection.style.border = "2px solid rgb(212, 168, 83)";
      selection.style.outline = "1px solid rgb(212, 168, 83)";
      selection.getBoundingClientRect = hitRect;
      layer.append(selection);
      container.append(layer);
      document.body.append(container);

      let shadowDuring = "unset";
      let borderDuring = "unset";
      let outlineDuring = "unset";
      let displayDuring = "unset";
      domToCanvasMock.mockImplementation(async () => {
        shadowDuring = selection.style.boxShadow;
        borderDuring = selection.style.border;
        outlineDuring = selection.style.outline;
        displayDuring = selection.style.display;
        return sourceCanvas;
      });

      const res = await captureStage(container, baseSel);
      expect(res.ok).toBe(true);
      // display:none collapses the stage column in the clone. Clearing the
      // shadow, border, and outline keeps the box and stops the 9999px dim
      // and the gold ring from painting onto the ancestor. A zero transparent
      // border is what the clone copies; the keyword "none" still serializes.
      expect(shadowDuring).toBe("none");
      expect(borderDuring).toBe("0px none transparent");
      // happy-dom reorders the outline shorthand to color, style, width.
      expect(outlineDuring).toBe("transparent none 0px");
      expect(displayDuring).toBe("");
      expect(selection.style.boxShadow).toBe("0 0 0 9999px rgba(0,0,0,0.4)");
      expect(selection.style.border).toBe("2px solid rgb(212, 168, 83)");
      // happy-dom reorders the restored outline shorthand to color, style, width.
      expect(selection.style.outline).toBe("rgb(212, 168, 83) solid 1px");
      container.remove();
    });

    it("restores monaco visibility when the raster throws", async () => {
      const hitRect = () =>
        ({ left: 20, top: 30, width: 10, height: 10, right: 30, bottom: 40, x: 20, y: 30, toJSON() {} }) as DOMRect;
      const monacoRoot = document.createElement("div");
      monacoRoot.className = "monaco-editor";
      monacoRoot.getBoundingClientRect = hitRect;
      container.append(monacoRoot);
      document.body.append(container);

      domToCanvasMock.mockRejectedValue(new Error("raster"));
      const res = await captureStage(container, baseSel);
      expect(res.ok).toBe(false);
      expect(monacoRoot.style.visibility).toBe("");
      container.remove();
    });

    it("excludes the selection layer chrome and the ask panel when they carry data-ask-capture-exclude", async () => {
      const hitRect = () =>
        ({ left: 20, top: 30, width: 10, height: 10, right: 30, bottom: 40, x: 20, y: 30, toJSON() {} }) as DOMRect;

      const panel = document.createElement("div");
      panel.setAttribute("data-ask-panel", "");
      panel.setAttribute("data-ask-capture-exclude", "");
      const preparing = document.createElement("p");
      preparing.setAttribute("data-ask-capture-preparing", "");
      preparing.setAttribute("data-ask-capture-exclude", "");
      preparing.textContent = "正在准备截图…";
      const preparingText = preparing.firstChild as Text;
      const cancel = document.createElement("button");
      cancel.setAttribute("data-ask-cancel", "");
      cancel.setAttribute("data-ask-capture-exclude", "");
      cancel.textContent = "取消";
      const waiting = document.createElement("p");
      waiting.setAttribute("data-ask-waiting", "");
      waiting.setAttribute("data-ask-capture-exclude", "");
      waiting.textContent = "正在想…";
      const chip = document.createElement("button");
      chip.setAttribute("data-ask-chip", "");
      chip.textContent = "这行在做什么？";
      const question = document.createElement("textarea");
      question.setAttribute("data-ask-question", "");
      panel.append(preparing, cancel, waiting, chip, question);

      // The layer root is a full-stage overlay and is not itself excluded.
      // Chrome inside it is. Stage content stacked under that chrome stays.
      const layer = document.createElement("div");
      layer.setAttribute("data-ask-layer", "");
      const highlight = document.createElement("div");
      highlight.setAttribute("data-ask-highlight", "line:1");
      highlight.setAttribute("data-ask-capture-exclude", "");
      const selectionBox = document.createElement("div");
      selectionBox.setAttribute("data-ask-selection", "");
      selectionBox.setAttribute("data-ask-capture-exclude", "");
      const hint = document.createElement("p");
      hint.setAttribute("data-ask-capture-exclude", "");
      hint.textContent = "拖拽圈选";
      const underChrome = document.createElement("span");
      underChrome.textContent = "1";
      selectionBox.append(underChrome);
      layer.append(highlight, selectionBox, hint);

      const stageContent = document.createElement("div");
      stageContent.setAttribute("data-ask-id", "viz:s1");
      stageContent.textContent = "1";

      for (const node of [panel, preparing, cancel, waiting, chip, question, layer, highlight, selectionBox, hint, underChrome, stageContent]) {
        node.getBoundingClientRect = hitRect;
      }
      container.append(stageContent, layer, panel);

      expect(CAPTURE_EXCLUDE_SELECTOR).toBe("[data-ask-capture-exclude]");
      expect(isCaptureExcluded(preparing)).toBe(true);
      expect(isCaptureExcluded(preparingText)).toBe(false);
      expect(isCaptureExcluded(cancel)).toBe(true);
      expect(isCaptureExcluded(waiting)).toBe(true);
      expect(isCaptureExcluded(panel)).toBe(true);
      expect(isCaptureExcluded(chip)).toBe(true);
      expect(isCaptureExcluded(question)).toBe(true);
      expect(isCaptureExcluded(layer)).toBe(false);
      expect(isCaptureExcluded(highlight)).toBe(true);
      expect(isCaptureExcluded(selectionBox)).toBe(true);
      expect(isCaptureExcluded(hint)).toBe(true);
      expect(isCaptureExcluded(underChrome)).toBe(true);
      expect(isCaptureExcluded(stageContent)).toBe(false);

      const res = await captureStage(container, baseSel);
      expect(res.ok).toBe(true);
      const filter = (domToCanvasMock.mock.calls[0]?.[1] as { filter: (node: Node) => boolean }).filter;
      expect(filter(preparing)).toBe(false);
      expect(filter(cancel)).toBe(false);
      expect(filter(waiting)).toBe(false);
      // Subtree of a marked node is excluded with it.
      const preparingChild = document.createElement("span");
      preparing.appendChild(preparingChild);
      preparingChild.getBoundingClientRect = hitRect;
      expect(filter(preparingChild)).toBe(false);
      expect(filter(panel)).toBe(false);
      expect(filter(chip)).toBe(false);
      expect(filter(question)).toBe(false);
      // The layer root is not marked, so it stays. Its marked chrome does not.
      expect(filter(layer)).toBe(true);
      expect(filter(highlight)).toBe(false);
      expect(filter(selectionBox)).toBe(false);
      expect(filter(hint)).toBe(false);
      // A node under marked chrome is excluded with that ancestor.
      expect(filter(underChrome)).toBe(false);
      // Unmarked stage content that intersects the bbox stays, including when
      // it is stacked under the overlay. Monaco is kept (blanked in place).
      expect(filter(stageContent)).toBe(true);
    });

    it("keeps a column item above the selection and pins its clone height", async () => {
      const hitRect = () =>
        ({ left: 20, top: 30, width: 10, height: 10, right: 30, bottom: 40, x: 20, y: 30, toJSON() {} }) as DOMRect;
      // Ends at y=16. The selection starts at y=20, so this box is entirely above it.
      const aboveRect = () =>
        ({ left: 0, top: 0, width: 100, height: 16, right: 100, bottom: 16, x: 0, y: 0, toJSON() {} }) as DOMRect;
      const column = document.createElement("section");
      column.getBoundingClientRect = hitRect;
      const board = document.createElement("div");
      board.className = "board-surface";
      board.getBoundingClientRect = aboveRect;
      const line = document.createElement("span");
      line.textContent = "code";
      line.getBoundingClientRect = aboveRect;
      board.append(line);
      const viz = document.createElement("div");
      viz.getBoundingClientRect = hitRect;
      column.append(board, viz);
      column.style.display = "flex";
      column.style.flexDirection = "column";
      container.append(column);
      document.body.append(container);

      let pinned = "";
      let basis = "";
      let stampDuring = "missing";
      domToCanvasMock.mockImplementation(async (_node: unknown, options: {
        filter: (node: Node) => boolean;
        onCloneEachNode?: (node: Node) => void;
      }) => {
        stampDuring = board.getAttribute(CAPTURE_SPACER_HEIGHT_ATTR) ?? "none";
        expect(options.filter(board)).toBe(true);
        expect(options.filter(line)).toBe(false);
        expect(options.filter(viz)).toBe(true);
        const clone = board.cloneNode(false) as HTMLElement;
        clone.style.paddingBottom = "6px";
        options.onCloneEachNode?.(clone);
        pinned = clone.style.height;
        basis = clone.style.flexBasis;
        expect(clone.hasAttribute(CAPTURE_SPACER_HEIGHT_ATTR)).toBe(false);
        return sourceCanvas;
      });

      const res = await captureStage(container, baseSel);
      if (!res.ok) throw new Error(`${res.reason} stamp=${stampDuring}`);
      // The walk stamps the live box before the clone reads it, then clears it.
      expect(stampDuring).toBe("16");
      // Live border box 16 plus the clone's own padding-bottom 6.
      expect(pinned).toBe("22px");
      expect(basis).toBe("22px");
      expect(board.hasAttribute(CAPTURE_SPACER_HEIGHT_ATTR)).toBe(false);
      container.remove();
    });

    it("keeps the subtitle header above the selection and skips a flex header of another card", async () => {
      const hitRect = () =>
        ({ left: 20, top: 30, width: 10, height: 10, right: 30, bottom: 40, x: 20, y: 30, toJSON() {} }) as DOMRect;
      const aboveRect = () =>
        ({ left: 0, top: 0, width: 100, height: 16, right: 100, bottom: 16, x: 0, y: 0, toJSON() {} }) as DOMRect;
      const card = document.createElement("div");
      card.setAttribute("data-ask-target", "subtitle");
      card.getBoundingClientRect = hitRect;
      card.style.display = "block";
      const header = document.createElement("div");
      header.className = "mb-1";
      header.style.display = "flex";
      header.getBoundingClientRect = aboveRect;
      const line = document.createElement("p");
      line.textContent = "开局";
      line.getBoundingClientRect = hitRect;
      const floated = document.createElement("div");
      floated.style.position = "absolute";
      floated.getBoundingClientRect = aboveRect;
      const vizCard = document.createElement("div");
      vizCard.style.display = "block";
      vizCard.getBoundingClientRect = hitRect;
      const vizHeader = document.createElement("div");
      vizHeader.style.display = "flex";
      vizHeader.getBoundingClientRect = aboveRect;
      vizCard.append(vizHeader);
      const realGetComputedStyle = window.getComputedStyle.bind(window);
      vi.spyOn(window, "getComputedStyle").mockImplementation((el: Element) => {
        const computed = realGetComputedStyle(el);
        if (el === floated) {
          return new Proxy(computed, {
            get(target, prop, receiver) {
              if (prop === "position") return "absolute";
              return Reflect.get(target, prop, receiver);
            },
          });
        }
        if (el === header || el === vizHeader) {
          return new Proxy(computed, {
            get(target, prop, receiver) {
              if (prop === "display") return "flex";
              return Reflect.get(target, prop, receiver);
            },
          });
        }
        return computed;
      });
      card.append(header, line, floated);
      container.append(card, vizCard);
      document.body.append(container);

      let pinned = "";
      domToCanvasMock.mockImplementation(async (_node: unknown, options: {
        filter: (node: Node) => boolean;
        onCloneEachNode?: (node: Node) => void;
      }) => {
        expect(header.getAttribute(CAPTURE_SPACER_HEIGHT_ATTR)).toBe("16");
        expect(vizHeader.hasAttribute(CAPTURE_SPACER_HEIGHT_ATTR)).toBe(false);
        expect(floated.hasAttribute(CAPTURE_SPACER_HEIGHT_ATTR)).toBe(false);
        expect(options.filter(header)).toBe(true);
        expect(options.filter(vizHeader)).toBe(false);
        expect(options.filter(floated)).toBe(false);
        expect(options.filter(line)).toBe(true);
        const clone = header.cloneNode(false) as HTMLElement;
        options.onCloneEachNode?.(clone);
        pinned = clone.style.height;
        return sourceCanvas;
      });

      const res = await captureStage(container, baseSel);
      expect(res.ok).toBe(true);
      expect(pinned).toBe("16px");
      expect(header.hasAttribute(CAPTURE_SPACER_HEIGHT_ATTR)).toBe(false);
      container.remove();
    });

    it("adds the tutor section's padding-top when that padding sits above the selection", async () => {
      const hitRect = () =>
        ({ left: 20, top: 30, width: 10, height: 10, right: 30, bottom: 40, x: 20, y: 30, toJSON() {} }) as DOMRect;
      const sectionRect = () =>
        ({ left: 0, top: 0, width: 100, height: 80, right: 100, bottom: 80, x: 0, y: 0, toJSON() {} }) as DOMRect;
      const section = document.createElement("section");
      section.className = "rounded-2xl";
      section.getBoundingClientRect = sectionRect;
      section.style.paddingTop = "16px";
      const line = document.createElement("p");
      line.getBoundingClientRect = hitRect;
      section.append(line);
      container.append(section);
      document.body.append(container);

      let padding = "";
      domToCanvasMock.mockImplementation(async (_node: unknown, options: {
        onCloneEachNode?: (node: Node) => void;
      }) => {
        expect(section.getAttribute("data-ask-capture-pad-above")).toBe("16");
        const clone = section.cloneNode(false) as HTMLElement;
        clone.style.paddingTop = "16px";
        options.onCloneEachNode?.(clone);
        padding = clone.style.paddingTop;
        expect(clone.hasAttribute("data-ask-capture-pad-above")).toBe(false);
        return sourceCanvas;
      });

      const res = await captureStage(container, baseSel);
      expect(res.ok).toBe(true);
      // The copied 16px plus the measured 16px that foreignObject drops.
      expect(padding).toBe("32px");
      expect(section.hasAttribute("data-ask-capture-pad-above")).toBe(false);
      container.remove();
    });

    it("returns TOO_MANY_NODES when more than maxNodes kept elements intersect the selection", async () => {
      const hitRect = () =>
        ({ left: 20, top: 30, width: 10, height: 10, right: 30, bottom: 40, x: 20, y: 30, toJSON() {} }) as DOMRect;
      const count = CAPTURE_DEFAULTS.maxNodes + 1;
      for (let i = 0; i < count; i++) {
        const el = document.createElement("div");
        el.getBoundingClientRect = hitRect;
        container.appendChild(el);
      }

      const res = await captureStage(container, baseSel);
      expect(res).toEqual({
        ok: false,
        reason: "TOO_MANY_NODES",
        fallbackText: "Code target",
      });
      expect(domToCanvasMock).not.toHaveBeenCalled();
    });

    it("keeps webp true across off-thread downscale retries after tooLarge", async () => {
      const posted: EncodeRequest[] = [];
      const bitmap = { close: vi.fn() };
      vi.stubGlobal(
        "createImageBitmap",
        vi.fn(async () => bitmap),
      );
      vi.stubGlobal("OffscreenCanvas", class OffscreenCanvas {});

      class FakeWorker {
        listeners = new Map<string, Set<(event: unknown) => void>>();
        terminated = false;
        addEventListener(type: string, handler: (event: unknown) => void) {
          const set = this.listeners.get(type) ?? new Set();
          set.add(handler);
          this.listeners.set(type, set);
        }
        removeEventListener(type: string, handler: (event: unknown) => void) {
          this.listeners.get(type)?.delete(handler);
        }
        postMessage(request: EncodeRequest) {
          posted.push(request);
          const response: EncodeResponse =
            posted.length >= 3
              ? { ok: true, mime: "image/webp", base64: "AAAA", bytes: 3 }
              : { ok: false, tooLarge: true };
          queueMicrotask(() => {
            for (const handler of this.listeners.get("message") ?? []) {
              handler({ data: response });
            }
          });
        }
        terminate() {
          this.terminated = true;
        }
      }

      const worker = new FakeWorker();
      vi.stubGlobal(
        "Worker",
        vi.fn(function Worker() {
          return worker;
        }),
      );

      const canvas = document.createElement("canvas");
      const result = await encodeOffThread(
        canvas,
        { x: 0, y: 0, w: 40, h: 40 },
        100,
        () => false,
      );

      expect(result).toEqual({
        ok: true,
        mime: "image/webp",
        dataBase64: "AAAA",
        bytes: 3,
      });
      expect(posted).toHaveLength(3);
      expect(posted.map((request) => request.webp)).toEqual([true, true, true]);
      expect(worker.terminated).toBe(false);

      vi.unstubAllGlobals();
    });

    it("reports encoder main and publishes it for the perf probe", async () => {
      vi.stubGlobal("Worker", undefined);
      delete window.__s4Capture;

      const res = await captureStage(container, baseSel);
      expect(res).toMatchObject({
        ok: true,
        encoder: "main",
        image: { mime: "image/webp", dataBase64: "AAAA" },
        bytes: 3,
      });
      expect(window.__s4Capture).toEqual({
        encoder: "main",
        mime: "image/webp",
        bytes: 3,
        devicePixelRatio: 1,
        scale: 1,
        crop: { x: 20, y: 40, w: 60, h: 80 },
        canvas: { width: 400, height: 400 },
      });

      vi.unstubAllGlobals();
    });

    it("reports encoder worker when off-thread encode succeeds", async () => {
      const bitmap = { close: vi.fn() };
      vi.stubGlobal("createImageBitmap", vi.fn(async () => bitmap));
      vi.stubGlobal("OffscreenCanvas", class OffscreenCanvas {});
      delete window.__s4Capture;

      class FakeWorker {
        listeners = new Map<string, Set<(event: { data: unknown }) => void>>();
        addEventListener(type: string, handler: (event: { data: unknown }) => void) {
          const set = this.listeners.get(type) ?? new Set();
          set.add(handler);
          this.listeners.set(type, set);
        }
        removeEventListener(type: string, handler: (event: { data: unknown }) => void) {
          this.listeners.get(type)?.delete(handler);
        }
        postMessage() {
          queueMicrotask(() => {
            for (const handler of this.listeners.get("message") ?? []) {
              handler({ data: { ok: true, mime: "image/webp", base64: "AAAA", bytes: 3 } });
            }
          });
        }
        terminate() {}
      }

      vi.stubGlobal(
        "Worker",
        vi.fn(function Worker() {
          return new FakeWorker();
        }),
      );

      const res = await captureStage(container, baseSel);
      expect(res).toMatchObject({
        ok: true,
        encoder: "worker",
        image: { mime: "image/webp", dataBase64: "AAAA" },
        bytes: 3,
      });
      expect(window.__s4Capture).toEqual({
        encoder: "worker",
        mime: "image/webp",
        bytes: 3,
        devicePixelRatio: 1,
        scale: 1,
        crop: { x: 20, y: 40, w: 60, h: 80 },
        canvas: { width: 400, height: 400 },
      });
      expect(createdCanvases).toHaveLength(0);

      vi.unstubAllGlobals();
    });

    it("falls back to main-thread encode when the worker fires messageerror", async () => {
      const bitmap = { close: vi.fn() };
      vi.stubGlobal("createImageBitmap", vi.fn(async () => bitmap));
      vi.stubGlobal("OffscreenCanvas", class OffscreenCanvas {});

      class FakeWorker {
        listeners = new Map<string, Set<(event: Event) => void>>();
        terminated = false;
        addEventListener(type: string, handler: (event: Event) => void) {
          const set = this.listeners.get(type) ?? new Set();
          set.add(handler);
          this.listeners.set(type, set);
        }
        removeEventListener(type: string, handler: (event: Event) => void) {
          this.listeners.get(type)?.delete(handler);
        }
        postMessage() {
          queueMicrotask(() => {
            const event = new Event("messageerror");
            for (const handler of this.listeners.get("messageerror") ?? []) {
              handler(event);
            }
          });
        }
        terminate() {
          this.terminated = true;
        }
      }

      const worker = new FakeWorker();
      vi.stubGlobal(
        "Worker",
        vi.fn(function Worker() {
          return worker;
        }),
      );

      const canvas = document.createElement("canvas");
      const off = await encodeOffThread(canvas, { x: 0, y: 0, w: 40, h: 40 }, 100, () => false);
      expect(off).toBe("FALLBACK");
      expect(worker.terminated).toBe(true);

      const res = await captureStage(container, baseSel);
      expect(res).toMatchObject({ ok: true, encoder: "main" });
      expect(createdCanvases.length).toBeGreaterThan(0);

      vi.unstubAllGlobals();
    });

    it("falls back to main-thread encode when Worker is unavailable", async () => {
      // Force the off-thread gate off (happy-dom usually already lacks Worker).
      vi.stubGlobal("Worker", undefined);
      vi.stubGlobal("OffscreenCanvas", undefined);
      vi.stubGlobal("createImageBitmap", undefined);

      const res = await captureStage(container, baseSel);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.image.dataBase64.length).toBeGreaterThan(0);
      }
      expect(createdCanvases.length).toBeGreaterThan(0);
      expect(domToCanvasMock).toHaveBeenCalledTimes(1);

      vi.unstubAllGlobals();
    });

    it("runs the ASK_TEST_STALL_HOOK busy loop before domToCanvas, then yields once, when NEXT_PUBLIC_ASK_TEST_STALL_MS is set", async () => {
      const source = captureStage.toString();
      expect(source).toContain("ASK_TEST_STALL_HOOK");
      expect(source).toContain('process.env.NEXT_PUBLIC_ASK_TEST_BUILD === "1"');
      expect(source).toContain("process.env.NEXT_PUBLIC_ASK_TEST_STALL_MS");
      const hookAt = source.indexOf("ASK_TEST_STALL_HOOK");
      const callAt = source.indexOf("mod.domToCanvas");
      expect(callAt).toBeGreaterThan(hookAt);
      // The marker string lives only inside the compile-time test block.
      const blockStart = source.lastIndexOf("if (", hookAt);
      expect(source.slice(blockStart, hookAt)).toContain('process.env.NEXT_PUBLIC_ASK_TEST_BUILD === "1"');
      // The stall stays before the raster call. One input yield sits between
      // them so a 取消 queued during the busy loop aborts before raster.
      // That yield is the only await in the gap (the call's own await is
      // stripped from the end of the slice).
      const between = source.slice(hookAt, callAt).replace(/await\s*$/, "");
      // After the stall the wait is the input settle, which ends when the
      // signal aborts. The no-stall path is the two-macrotask yield.
      expect(between).toContain("yieldMacrotask");
      expect(between).toContain("yieldForQueuedInput");
      expect(between.match(/await/g)?.length).toBe(1);
      expect(source.indexOf("beforeEncode", callAt)).toBeGreaterThan(callAt);

      vi.stubEnv("NEXT_PUBLIC_ASK_TEST_BUILD", "1");
      vi.stubEnv("NEXT_PUBLIC_ASK_TEST_STALL_MS", "80");
      let enteredAfterMs = 0;
      const stalledStart = performance.now();
      domToCanvasMock.mockImplementation(() => {
        enteredAfterMs = performance.now() - stalledStart;
        return Promise.resolve(sourceCanvas);
      });
      const res = await captureStage(container, baseSel);
      expect(res.ok).toBe(true);
      expect(domToCanvasMock).toHaveBeenCalledTimes(1);
      // The stubbed 80ms elapses inside the synchronous loop, before the call.
      expect(enteredAfterMs).toBeGreaterThanOrEqual(70);

      vi.unstubAllEnvs();
    });

    it("an aborted signal before domToCanvas skips raster and returns ABORTED", async () => {
      const controller = new AbortController();
      controller.abort();
      const res = await captureStage(container, baseSel, { signal: controller.signal });
      expect(res).toEqual({
        ok: false,
        reason: "ABORTED",
        fallbackText: "Code target",
      });
      expect(domToCanvasMock).not.toHaveBeenCalled();
    });

    it("a stall longer than timeoutMs returns ABORTED when 取消 aborted during the stall", async () => {
      vi.useFakeTimers();
      const controller = new AbortController();
      domToCanvasMock.mockImplementation(() => {
        controller.abort();
        return new Promise(() => {});
      });

      const pending = captureStage(container, baseSel, { timeoutMs: 1000, signal: controller.signal });
      // No stall in this unit test, so the pre-raster wait is two
      // macrotasks. A 取消 issued during a stall is queued behind the first
      // and runs on the second, before domToCanvas.
      await Promise.resolve();
      setTimeout(() => {
        controller.abort();
      }, 0);
      await vi.advanceTimersByTimeAsync(0);
      const res = await pending;
      expect(domToCanvasMock).not.toHaveBeenCalled();

      expect(res).toEqual({
        ok: false,
        reason: "ABORTED",
        fallbackText: "Code target",
      });
      vi.useRealTimers();
    });

    it("a stall longer than timeoutMs returns ABORTED when 取消 aborts on the macrotask after the timer", async () => {
      vi.useFakeTimers();
      const controller = new AbortController();
      domToCanvasMock.mockImplementation(() => new Promise(() => {}));

      const pending = captureStage(container, baseSel, { timeoutMs: 1000, signal: controller.signal });
      // The pre-raster yield is one macrotask and domToCanvas starts after
      // it. The 1000ms timer yields its own macrotask before it commits.
      // The press queued behind the stall aborts in that gap, then the next
      // tick commits ABORTED. No extra advance sits between the start and
      // the timeout: one would run the pre-raster yield and leave the
      // timeout's own yield with nothing queued behind it.
      await vi.advanceTimersByTimeAsync(1000);
      controller.abort();
      await vi.advanceTimersByTimeAsync(1);
      const res = await pending;

      expect(res).toEqual({
        ok: false,
        reason: "ABORTED",
        fallbackText: "Code target",
      });
      vi.useRealTimers();
    });

    it("returns ABORTED when the timeout timer fires and a cancel is queued behind it with setTimeout(0)", async () => {
      vi.useFakeTimers();
      const controller = new AbortController();
      domToCanvasMock.mockImplementation(() => new Promise(() => {}));

      const pending = captureStage(container, baseSel, { timeoutMs: 1000, signal: controller.signal });
      // The timeout callback is queued together with the pre-raster yield.
      // The cancel is registered after that callback, also as a timer, so
      // it runs once the callback has started and yielded its macrotask.
      await vi.advanceTimersByTimeAsync(1000);
      setTimeout(() => {
        controller.abort();
      }, 0);
      await vi.advanceTimersByTimeAsync(1);
      const res = await pending;

      expect(res).toEqual({
        ok: false,
        reason: "ABORTED",
        fallbackText: "Code target",
      });
      vi.useRealTimers();
    });

    it("yields once after domToCanvas and before encode, and an abort there skips encode", async () => {
      const order: string[] = [];
      let releaseYield: (() => void) | undefined;
      domToCanvasMock.mockImplementation(() => {
        order.push("dom");
        return Promise.resolve(sourceCanvas);
      });
      const bitmap = vi.fn(async () => {
        order.push("encode");
        return { close() {} };
      });
      vi.stubGlobal("createImageBitmap", bitmap);
      const controller = new AbortController();
      const beforeEncode = () =>
        new Promise<void>((resolve) => {
          order.push("yield");
          releaseYield = () => {
            controller.abort();
            resolve();
          };
        });

      const pending = captureStage(container, baseSel, { signal: controller.signal, beforeEncode });
      await vi.waitFor(() => {
        expect(releaseYield).toBeTypeOf("function");
      });
      expect(order).toEqual(["dom", "yield"]);
      expect(bitmap).not.toHaveBeenCalled();
      releaseYield?.();
      const res = await pending;
      expect(res).toMatchObject({ ok: false, reason: "ABORTED" });
      expect(bitmap).not.toHaveBeenCalled();
      expect(order).toEqual(["dom", "yield"]);
      vi.unstubAllGlobals();
    });

    it("calls domToCanvas without a second animation-frame pair", async () => {
      const order: string[] = [];
      const raf = vi.fn((cb: FrameRequestCallback) => {
        order.push("raf");
        cb(0);
        return 1;
      });
      vi.stubGlobal("requestAnimationFrame", raf);
      domToCanvasMock.mockImplementation(() => {
        order.push("dom");
        return Promise.resolve(sourceCanvas);
      });

      const res = await captureStage(container, baseSel);
      expect(res.ok).toBe(true);
      expect(raf).not.toHaveBeenCalled();
      expect(order).toEqual(["dom"]);
      vi.unstubAllGlobals();
    });

    it("honors custom timeoutMs option", async () => {
      vi.useFakeTimers();
      domToCanvasMock.mockImplementation(() => new Promise(() => {}));

      const promise = captureStage(container, baseSel, { timeoutMs: 500 });
      await vi.advanceTimersByTimeAsync(501);
      const res = await promise;

      expect(res).toEqual({
        ok: false,
        reason: "TIMEOUT",
        fallbackText: "Code target",
      });
    });
  });
});
