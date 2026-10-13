import { expect, test } from "vitest";
import {
  ASK_BODY_MAX_BYTES,
  askError,
  readAskBody,
} from "@/lib/agent/request";

async function bodyOf(response: Response) {
  return response.json() as Promise<{ code: string; error: string; retryable: boolean; message: string }>;
}

function streamOf(chunks: Uint8Array[], hooks?: { cancel?: () => void; pull?: () => void }) {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      hooks?.pull?.();
      const next = chunks[index];
      index += 1;
      if (!next) controller.close();
      else controller.enqueue(next);
    },
    cancel() {
      hooks?.cancel?.();
    },
  });
}

function requestWith(body: BodyInit | null, headers?: HeadersInit, signal?: AbortSignal) {
  return new Request("http://localhost/api/lecture/ask", {
    method: "POST",
    body,
    headers,
    signal,
    duplex: "half",
  } as RequestInit);
}

test("8. content-length 超限直接 413 且取消 body；非法/负 length 为 BAD_REQUEST", async () => {
  let cancelled = false;
  let pulled = false;
  const oversized = requestWith(streamOf([new Uint8Array([1])], {
    cancel: () => { cancelled = true; },
    pull: () => { pulled = true; },
  }), { "content-length": String(ASK_BODY_MAX_BYTES + 1) });
  const tooBig = await readAskBody(oversized);
  expect(tooBig.ok).toBe(false);
  if (!tooBig.ok) {
    expect(tooBig.response.status).toBe(413);
    expect(await bodyOf(tooBig.response)).toEqual({
      code: "PAYLOAD_TOO_LARGE",
      error: "PAYLOAD_TOO_LARGE",
      retryable: false,
      message: "请求过大，请移除截图后重新提问。",
    });
  }
  expect(cancelled).toBe(true);
  expect(pulled).toBe(false);

  const hugeHeader = requestWith("{}", { "content-length": String(2n ** 80n) });
  const huge = await readAskBody(hugeHeader);
  expect(huge.ok).toBe(false);
  if (!huge.ok) expect(huge.response.status).toBe(413);

  for (const length of ["-1", "12.0", "1e2", "+5", "01", "", "abc"]) {
    const bad = await readAskBody(requestWith("{}", { "content-length": length }));
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.response.status).toBe(400);
      const body = await bodyOf(bad.response);
      expect(body.code).toBe("BAD_REQUEST");
      expect(body.retryable).toBe(false);
    }
  }

  const headerOnly = await readAskBody(new Request("http://localhost/api/lecture/ask", {
    method: "GET",
    headers: { "content-length": String(ASK_BODY_MAX_BYTES + 1) },
  }));
  expect(headerOnly.ok).toBe(false);
  if (!headerOnly.ok) expect(headerOnly.response.status).toBe(413);

  let shortCancelled = false;
  let shortPulled = 0;
  const lying = requestWith(new ReadableStream<Uint8Array>({
    start(controller) {
      shortPulled += 1;
      controller.enqueue(new Uint8Array(100));
      controller.enqueue(new Uint8Array(ASK_BODY_MAX_BYTES));
    },
    cancel() { shortCancelled = true; },
  }), { "content-length": "1" });
  const lied = await readAskBody(lying);
  expect(lied.ok).toBe(false);
  if (!lied.ok) expect(lied.response.status).toBe(413);
  expect(shortCancelled).toBe(true);
  expect(shortPulled).toBe(1);

  let missingCancelled = false;
  const chunked = requestWith(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("x".repeat(100)));
      controller.enqueue(new TextEncoder().encode("y".repeat(ASK_BODY_MAX_BYTES)));
    },
    cancel() { missingCancelled = true; },
  }));
  expect(chunked.headers.get("content-length")).toBeNull();
  const missing = await readAskBody(chunked);
  expect(missing.ok).toBe(false);
  if (!missing.ok) expect(missing.response.status).toBe(413);
  expect(missingCancelled).toBe(true);
});

test("9. 恰 786432 字节通过，多一字节 413；按字节计而不是 string.length", async () => {
  const han = "测";
  expect(Buffer.byteLength(han)).toBe(3);
  const prefix = '{"q":"';
  const suffix = 'a"}';
  const overhead = Buffer.byteLength(prefix + suffix);
  const hanCount = (ASK_BODY_MAX_BYTES - overhead) / Buffer.byteLength(han);
  expect(Number.isInteger(hanCount)).toBe(true);
  const exactText = prefix + han.repeat(hanCount) + suffix;
  expect(Buffer.byteLength(exactText)).toBe(ASK_BODY_MAX_BYTES);
  expect(exactText.length).toBeLessThan(ASK_BODY_MAX_BYTES);

  const exact = await readAskBody(requestWith(exactText));
  expect(exact.ok).toBe(true);
  if (exact.ok) {
    expect(exact.text).toBe(exactText);
    expect(Buffer.byteLength(exact.text)).toBe(ASK_BODY_MAX_BYTES);
  }

  const overText = exactText + "b";
  expect(Buffer.byteLength(overText)).toBe(ASK_BODY_MAX_BYTES + 1);
  const over = await readAskBody(requestWith(overText));
  expect(over.ok).toBe(false);
  if (!over.ok) expect(over.response.status).toBe(413);

  const declaredExact = await readAskBody(requestWith(exactText, { "content-length": String(ASK_BODY_MAX_BYTES) }));
  expect(declaredExact.ok).toBe(true);

  const encoded = new TextEncoder().encode(exactText);
  const mid = Math.floor(encoded.byteLength / 2);
  const multi = await readAskBody(requestWith(streamOf([
    encoded.slice(0, mid),
    encoded.slice(mid),
  ])));
  expect(multi.ok).toBe(true);
  if (multi.ok) expect(Buffer.byteLength(multi.text)).toBe(ASK_BODY_MAX_BYTES);

  const splitOver = await readAskBody(requestWith(streamOf([
    encoded,
    new TextEncoder().encode("测"),
  ])));
  expect(splitOver.ok).toBe(false);
  if (!splitOver.ok) expect(splitOver.response.status).toBe(413);
});

test("10. 坏 JSON、空体、非法 UTF-8 为 BAD_JSON；取消为 CANCELLED", async () => {
  for (const raw of ["{bad", "", "   ", "null", "[]", "\"x\"", "1"]) {
    const result = await readAskBody(requestWith(raw));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const body = await bodyOf(result.response);
      expect(body).toMatchObject({ code: "BAD_JSON", error: "BAD_JSON", retryable: false });
      expect(result.response.status).toBe(400);
    }
  }

  const emptyStream = await readAskBody(requestWith(streamOf([])));
  expect(emptyStream.ok).toBe(false);
  if (!emptyStream.ok) expect((await bodyOf(emptyStream.response)).code).toBe("BAD_JSON");

  const badUtf8 = new Uint8Array([0xff, 0xfe, 0xfd]);
  const utf = await readAskBody(requestWith(streamOf([badUtf8])));
  expect(utf.ok).toBe(false);
  if (!utf.ok) expect((await bodyOf(utf.response)).code).toBe("BAD_JSON");

  const splitPayload = new TextEncoder().encode('{"q":"测"}');
  const splitAt = splitPayload.indexOf(0xb5);
  const splitChar = await readAskBody(requestWith(streamOf([
    splitPayload.slice(0, splitAt),
    splitPayload.slice(splitAt),
  ])));
  expect(splitChar.ok).toBe(true);
  if (splitChar.ok) expect(splitChar.text).toBe('{"q":"测"}');

  const already = new AbortController();
  already.abort();
  const pre = await readAskBody(requestWith("{}", undefined, already.signal));
  expect(pre.ok).toBe(false);
  if (!pre.ok) {
    expect(pre.response.status).toBe(499);
    expect(await bodyOf(pre.response)).toMatchObject({ code: "CANCELLED", error: "CANCELLED", retryable: false });
  }

  let midCancelled = false;
  const hanging = new ReadableStream<Uint8Array>({
    pull() {
      return new Promise(() => {});
    },
    cancel() { midCancelled = true; },
  });
  const controller = new AbortController();
  const pending = readAskBody(requestWith(hanging, undefined, controller.signal));
  controller.abort();
  const mid = await pending;
  expect(mid.ok).toBe(false);
  if (!mid.ok) expect((await bodyOf(mid.response)).code).toBe("CANCELLED");
  expect(midCancelled).toBe(true);

  const thrown = new ReadableStream<Uint8Array>({
    pull() {
      return Promise.reject(new DOMException("The operation was aborted.", "AbortError"));
    },
  });
  const thrownResult = await readAskBody(requestWith(thrown));
  expect(thrownResult.ok).toBe(false);
  if (!thrownResult.ok) expect((await bodyOf(thrownResult.response)).code).toBe("CANCELLED");

  const abortedRead = new AbortController();
  const racing = new ReadableStream<Uint8Array>({
    pull() {
      return Promise.reject(new DOMException("The operation was aborted.", "AbortError"));
    },
  });
  const racingRead = readAskBody(requestWith(racing, undefined, abortedRead.signal));
  abortedRead.abort();
  const racingResult = await racingRead;
  expect(racingResult.ok).toBe(false);
  if (!racingResult.ok) expect((await bodyOf(racingResult.response)).code).toBe("CANCELLED");

  const broken = new ReadableStream<Uint8Array>({
    pull() {
      throw new Error("socket reset");
    },
  });
  const brokenResult = await readAskBody(requestWith(broken));
  expect(brokenResult.ok).toBe(false);
  if (!brokenResult.ok) expect((await bodyOf(brokenResult.response)).code).toBe("BAD_JSON");

  const noBody = await readAskBody(new Request("http://localhost/api/lecture/ask", { method: "GET" }));
  expect(noBody.ok).toBe(false);
  if (!noBody.ok) expect((await bodyOf(noBody.response)).code).toBe("BAD_JSON");

  const ok = await readAskBody(requestWith("{\"a\":1}"));
  expect(ok.ok).toBe(true);
  if (ok.ok) expect(JSON.parse(ok.text)).toEqual({ a: 1 });

  const custom = askError("BAD_REQUEST", 400, "自定义", { "x-test": "1" });
  expect(custom.headers.get("x-test")).toBe("1");
  expect(custom.status).toBe(400);
  expect(await bodyOf(custom)).toMatchObject({ code: "BAD_REQUEST", message: "自定义", retryable: false });
});
