/**
 * Crop is already an ImageBitmap. Draw it and try WebP, then JPEG,
 * at each quality until the blob fits maxBytes.
 */

export type EncodeRequest = {
  bitmap: ImageBitmap;
  qualities: readonly number[];
  maxBytes: number;
  webp: boolean;
};

export type EncodeResponse =
  | {
      ok: true;
      mime: "image/webp" | "image/jpeg";
      base64: string;
      bytes: number;
      /** Present when the worker could transfer the encoded bytes. */
      buffer?: ArrayBuffer;
    }
  | { ok: false; tooLarge: true }
  | { ok: false; error: string };

function bytesOf(blob: Blob): Promise<{ bytes: Uint8Array; base64: string; buffer: ArrayBuffer }> {
  return blob.arrayBuffer().then((buffer) => {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return { bytes, base64: btoa(binary), buffer };
  });
}

export async function encodeCapture(request: EncodeRequest): Promise<EncodeResponse> {
  const width = request.bitmap.width;
  const height = request.bitmap.height;
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    request.bitmap.close();
    throw new Error("NO_CONTEXT");
  }
  ctx.drawImage(request.bitmap, 0, 0);
  request.bitmap.close();

  let webp = request.webp;
  for (const quality of request.qualities) {
    let mime: "image/webp" | "image/jpeg" = webp ? "image/webp" : "image/jpeg";
    let blob = await canvas.convertToBlob({ type: mime, quality });
    if (webp && blob.type !== "image/webp") {
      webp = false;
      mime = "image/jpeg";
      blob = await canvas.convertToBlob({ type: mime, quality });
    }
    if (blob.size <= request.maxBytes) {
      const encoded = await bytesOf(blob);
      return { ok: true, mime, base64: encoded.base64, bytes: encoded.bytes.length, buffer: encoded.buffer };
    }
  }
  return { ok: false, tooLarge: true };
}

/** Transfer list for a worker reply. The encoded bytes move instead of being copied. */
export function encodeTransferList(response: EncodeResponse): Transferable[] {
  if (response.ok && response.buffer) return [response.buffer];
  return [];
}

export async function handleEncodeMessage(
  request: EncodeRequest,
  post: (r: EncodeResponse) => void,
): Promise<void> {
  try {
    post(await encodeCapture(request));
  } catch (error: unknown) {
    post({
      ok: false,
      error: error instanceof Error ? error.message : "ENCODE_FAILED",
    });
  }
}
