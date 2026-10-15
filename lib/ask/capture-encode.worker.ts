/**
 * Crop is already an ImageBitmap. Draw it and try WebP, then JPEG,
 * at each quality until the blob fits maxBytes.
 */

import { encodeTransferList, handleEncodeMessage, type EncodeRequest } from "./capture-encode";

export type { EncodeRequest, EncodeResponse } from "./capture-encode";

self.onmessage = (event: MessageEvent<EncodeRequest>) => {
  void handleEncodeMessage(event.data, (response) => {
    const transfer = encodeTransferList(response);
    if (transfer.length > 0) {
      self.postMessage(response, { transfer });
      return;
    }
    self.postMessage(response);
  });
};
