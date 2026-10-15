// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AskSelection, AskTarget } from "@/lib/ask/types";
import {
  CAPTURE_DEFAULTS,
  CAPTURE_FALLBACK_NOTICE,
  buildFallbackText,
  captureStage,
  decodedBase64Bytes,
  encodeOffThread,
  intersectsBBox,
  toCropRect,
  yieldTwoFrames,
} from "@/lib/ask/capture";
import type { EncodeRequest, EncodeResponse } from "@/lib/ask/capture-encode.worker";

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

    it("calls domToCanvas with font:false, scale:1, and a filter that drops non-intersecting / monaco / iframe / video", async () => {
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
        features: { restoreScrollPosition: boolean };
        filter: (node: Node) => boolean;
        timeout: number;
        width: number;
        height: number;
      };
      expect(options.font).toBe(false);
      expect(options.scale).toBe(1);
      expect(options.features).toEqual({ restoreScrollPosition: false });
      expect(options.width).toBe(200);
      expect(options.height).toBe(200);
      expect(options.timeout).toBeLessThanOrEqual(CAPTURE_DEFAULTS.timeoutMs);
      expect(options.timeout).toBeGreaterThan(0);
      expect(options.filter(inside)).toBe(true);
      expect(options.filter(outside)).toBe(false);
      expect(options.filter(frame)).toBe(false);
      expect(options.filter(clip)).toBe(false);
      expect(options.filter(monacoRoot)).toBe(false);
      // Child is not entered by the walk (REJECT on root) and modern-screenshot
      // also skips children of filtered roots; the set may not list the child.
      expect(options.filter(text)).toBe(true);
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
      expect(worker.terminated).toBe(true);

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

    it("yields two animation frames before calling domToCanvas", async () => {
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
      expect(raf).toHaveBeenCalledTimes(2);
      expect(order).toEqual(["raf", "raf", "dom"]);
      vi.unstubAllGlobals();
    });

    it("uses setTimeout(0) when requestAnimationFrame is missing", async () => {
      vi.useFakeTimers();
      vi.stubGlobal("requestAnimationFrame", undefined);
      const pending = yieldTwoFrames();
      await vi.advanceTimersByTimeAsync(0);
      await pending;

      const promise = captureStage(container, baseSel);
      await vi.advanceTimersByTimeAsync(0);
      const res = await promise;
      expect(res.ok).toBe(true);
      expect(domToCanvasMock).toHaveBeenCalledTimes(1);
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
