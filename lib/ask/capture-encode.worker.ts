/**
 * Crop is already an ImageBitmap. Draw it and try WebP, then JPEG,
 * at each quality until the blob fits maxBytes.
 */

import { handleEncodeMessage, type EncodeRequest } from "./capture-encode";

export type { EncodeRequest, EncodeResponse } from "./capture-encode";

self.onmessage = (event: MessageEvent<EncodeRequest>) => {
  void handleEncodeMessage(event.data, (r) => self.postMessage(r));
};
