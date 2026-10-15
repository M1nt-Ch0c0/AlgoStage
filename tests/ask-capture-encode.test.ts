import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeCapture, handleEncodeMessage, type EncodeRequest } from "@/lib/ask/capture-encode";

type BlobPlan = { type: string; bytes: Uint8Array };

let plans: BlobPlan[] = [];
let drawImage: ReturnType<typeof vi.fn>;
let context: { drawImage: ReturnType<typeof vi.fn> } | null;
const convertCalls: Array<{ type?: string; quality?: number }> = [];

class FakeOffscreenCanvas {
  width: number;
  height: number;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }

  getContext(): { drawImage: ReturnType<typeof vi.fn> } | null {
    return context;
  }

  convertToBlob(options?: { type?: string; quality?: number }): Promise<Blob> {
    convertCalls.push({ type: options?.type, quality: options?.quality });
    const plan = plans.shift();
    if (!plan) throw new Error("NO_BLOB_PLAN");
    const copy = new ArrayBuffer(plan.bytes.byteLength);
    new Uint8Array(copy).set(plan.bytes);
    return Promise.resolve(new Blob([copy], { type: plan.type }));
  }
}

function bitmap(width = 8, height = 4) {
  return { width, height, close: vi.fn() };
}

function request(overrides: Partial<EncodeRequest> = {}): EncodeRequest {
  return {
    bitmap: bitmap() as unknown as ImageBitmap,
    qualities: [0.8],
    maxBytes: 100,
    webp: true,
    ...overrides,
  };
}

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe("encodeCapture", () => {
  afterEach(() => {
    plans = [];
    convertCalls.length = 0;
    context = null;
    vi.unstubAllGlobals();
  });

  function install(next: { drawImage?: ReturnType<typeof vi.fn>; context?: { drawImage: ReturnType<typeof vi.fn> } | null } = {}) {
    drawImage = next.drawImage ?? vi.fn();
    context = next.context === undefined ? { drawImage } : next.context;
    vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
  }

  it("returns ok webp with base64 and bytes, and closes the bitmap", async () => {
    install();
    const source = bitmap(12, 6);
    const payload = bytes("webp-ok");
    plans = [{ type: "image/webp", bytes: payload }];

    const response = await encodeCapture(
      request({ bitmap: source as unknown as ImageBitmap, qualities: [0.9], maxBytes: payload.length }),
    );

    expect(response).toEqual({
      ok: true,
      mime: "image/webp",
      base64: btoa("webp-ok"),
      bytes: payload.length,
    });
    expect(source.close).toHaveBeenCalledOnce();
    expect(drawImage).toHaveBeenCalledWith(source, 0, 0);
    expect(convertCalls).toEqual([{ type: "image/webp", quality: 0.9 }]);
  });

  it("tries the next quality as image/webp when the first blob is too large", async () => {
    install();
    const source = bitmap();
    const small = bytes("ok");
    plans = [
      { type: "image/webp", bytes: bytes("too-big-for-limit") },
      { type: "image/webp", bytes: small },
    ];

    const response = await encodeCapture(
      request({
        bitmap: source as unknown as ImageBitmap,
        qualities: [0.9, 0.5],
        maxBytes: small.length,
      }),
    );

    expect(response).toEqual({
      ok: true,
      mime: "image/webp",
      base64: btoa("ok"),
      bytes: small.length,
    });
    expect(convertCalls).toEqual([
      { type: "image/webp", quality: 0.9 },
      { type: "image/webp", quality: 0.5 },
    ]);
    expect(source.close).toHaveBeenCalledOnce();
  });

  it("returns tooLarge when every quality exceeds maxBytes", async () => {
    install();
    plans = [
      { type: "image/webp", bytes: bytes("aaaa") },
      { type: "image/webp", bytes: bytes("bbbb") },
    ];

    const response = await encodeCapture(request({ qualities: [0.8, 0.4], maxBytes: 2 }));

    expect(response).toEqual({ ok: false, tooLarge: true });
    expect(convertCalls).toEqual([
      { type: "image/webp", quality: 0.8 },
      { type: "image/webp", quality: 0.4 },
    ]);
  });

  it("falls back to image/jpeg for the current and later qualities when the blob is not webp", async () => {
    install();
    const jpeg = bytes("jpeg");
    plans = [
      { type: "image/png", bytes: bytes("not-webp-and-large") },
      { type: "image/jpeg", bytes: bytes("still-large") },
      { type: "image/jpeg", bytes: jpeg },
    ];

    const response = await encodeCapture(request({ qualities: [0.9, 0.4], maxBytes: jpeg.length }));

    expect(response).toEqual({
      ok: true,
      mime: "image/jpeg",
      base64: btoa("jpeg"),
      bytes: jpeg.length,
    });
    expect(convertCalls).toEqual([
      { type: "image/webp", quality: 0.9 },
      { type: "image/jpeg", quality: 0.9 },
      { type: "image/jpeg", quality: 0.4 },
    ]);
  });

  it("encodes image/jpeg when webp is false", async () => {
    install();
    const payload = bytes("jpg");
    plans = [{ type: "image/jpeg", bytes: payload }];

    const response = await encodeCapture(request({ webp: false, qualities: [0.7], maxBytes: payload.length }));

    expect(response).toEqual({
      ok: true,
      mime: "image/jpeg",
      base64: btoa("jpg"),
      bytes: payload.length,
    });
    expect(convertCalls).toEqual([{ type: "image/jpeg", quality: 0.7 }]);
  });

  it("rejects NO_CONTEXT and closes the bitmap when getContext returns null", async () => {
    install({ context: null });
    const source = bitmap();

    await expect(encodeCapture(request({ bitmap: source as unknown as ImageBitmap }))).rejects.toThrow("NO_CONTEXT");
    expect(source.close).toHaveBeenCalledOnce();
    expect(convertCalls).toEqual([]);
  });
});

describe("handleEncodeMessage", () => {
  afterEach(() => {
    plans = [];
    convertCalls.length = 0;
    context = null;
    vi.unstubAllGlobals();
  });

  it("posts the successful encode result", async () => {
    drawImage = vi.fn();
    context = { drawImage };
    vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
    const payload = bytes("posted");
    plans = [{ type: "image/webp", bytes: payload }];
    const post = vi.fn();

    await handleEncodeMessage(request({ qualities: [0.8], maxBytes: payload.length }), post);

    expect(post).toHaveBeenCalledOnce();
    expect(post).toHaveBeenCalledWith({
      ok: true,
      mime: "image/webp",
      base64: btoa("posted"),
      bytes: payload.length,
    });
  });

  it("posts NO_CONTEXT when encodeCapture rejects with an Error", async () => {
    drawImage = vi.fn();
    context = null;
    vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
    const post = vi.fn();

    await handleEncodeMessage(request(), post);

    expect(post).toHaveBeenCalledOnce();
    expect(post).toHaveBeenCalledWith({ ok: false, error: "NO_CONTEXT" });
  });

  it("posts ENCODE_FAILED when encodeCapture rejects with a non-Error", async () => {
    vi.stubGlobal(
      "OffscreenCanvas",
      class {
        constructor(_width: number, _height: number) {}
        getContext(): never {
          throw "boom";
        }
      },
    );
    const post = vi.fn();

    await handleEncodeMessage(request(), post);

    expect(post).toHaveBeenCalledOnce();
    expect(post).toHaveBeenCalledWith({ ok: false, error: "ENCODE_FAILED" });
  });
});
