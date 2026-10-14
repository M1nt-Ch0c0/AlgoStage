/**
 * §9 #44 #45 #46 #47 — 客户端 readAskResponse。
 * 顺序、固定文案、断流、缓冲与清理。不打印响应原文。
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { ByokError, NO_BYOK_MESSAGE, UPSTREAM_AUTH_LECTURE_MESSAGE, UPSTREAM_ERROR_MESSAGE } from "@/lib/byok/client";
import {
  ASK_BAD_JSON_MESSAGE,
  ASK_BAD_REQUEST_MESSAGE,
  ASK_BUSY_MESSAGE,
  ASK_CANCELLED_MESSAGE,
  ASK_CONFIGURATION_ERROR_MESSAGE,
  ASK_INCOMPLETE_MESSAGE,
  ASK_INVALID_ANSWER_MESSAGE,
  ASK_NOT_FOUND_MESSAGE,
  ASK_PAYLOAD_TOO_LARGE_MESSAGE,
  ASK_RATE_LIMITED_MESSAGE,
  ASK_STEP_NOT_FOUND_MESSAGE,
  ASK_TIMEOUT_MESSAGE,
  readAskResponse,
} from "@/lib/ask/ask-response";
import type { AnswerSegment, StepAnswer } from "@/lib/ask/types";

const headers = { "Content-Type": "application/x-ndjson; charset=utf-8" };

const segment = (id = "a1", narration = "这一段解释当前问题。"): AnswerSegment => ({ id, narration });

function answer(overrides: Partial<StepAnswer> = {}, segments: AnswerSegment[] = [segment()]): StepAnswer {
  return {
    v: 1,
    id: "ans-1",
    stepId: "s3",
    question: "为什么这样写？",
    selection: {
      mode: "single",
      bbox: { x: 0, y: 0, width: 44, height: 44 },
      targets: [{ kind: "subtitle", id: "subtitle-s3", stepId: "s3", text: "当前字幕" }],
    },
    segments,
    createdAt: "2026-10-13T11:00:00.000Z",
    ...overrides,
  };
}

function startLine(extra: Record<string, unknown> = {}) {
  return JSON.stringify({ type: "start", answerId: "ans-1", stepId: "s3", imageUsed: false, ...extra });
}

function segmentLine(item: AnswerSegment = segment()) {
  return JSON.stringify({ type: "segment", segment: item });
}

function resultLine(value: StepAnswer = answer()) {
  return JSON.stringify({ type: "result", answer: value });
}

function ndjson(...lines: string[]) {
  return `${lines.join("\n")}\n`;
}

function streamFrom(chunks: string[], hooks: { cancel?: () => void; error?: Error } = {}) {
  const encoder = new TextEncoder();
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (hooks.error && index === 0) {
        controller.error(hooks.error);
        return;
      }
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunks[index]!));
      index += 1;
    },
    cancel() {
      hooks.cancel?.();
    },
  });
  return body;
}

function responseOf(text: string, init: ResponseInit = {}) {
  return new Response(text, { headers: { ...headers, ...init.headers }, status: init.status ?? 200 });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("readAskResponse §9 #44", () => {
  test("start→segment→result 才 resolve；回调顺序与规范化片段一致", async () => {
    const seenStart: unknown[] = [];
    const seen: AnswerSegment[] = [];
    const value = answer();
    const result = await readAskResponse(responseOf(ndjson(startLine(), segmentLine(), resultLine(value))), {
      onStart: (start) => seenStart.push(start),
      onSegment: (item) => seen.push(item),
    });
    expect(result).toEqual(value);
    expect(seenStart).toEqual([{ answerId: "ans-1", stepId: "s3", imageUsed: false }]);
    expect(seen).toEqual(value.segments);
  });

  test.each([
    ["start 与 result 的 id 不符", ndjson(startLine(), segmentLine(), resultLine(answer({ id: "other" })))],
    ["start 与 result 的 stepId 不符", ndjson(startLine(), segmentLine(), resultLine(answer({ stepId: "s9" })))],
    ["重复 result", ndjson(startLine(), segmentLine(), resultLine(), resultLine())],
    ["重复 start", ndjson(startLine(), startLine(), segmentLine(), resultLine())],
    ["result 之后还有事件", ndjson(startLine(), segmentLine(), resultLine(), segmentLine())],
    ["缺 result 的 EOF", ndjson(startLine(), segmentLine())],
    ["未知事件", ndjson(startLine(), JSON.stringify({ type: "progress", message: "nope" }))],
    ["segment 在 start 之前", ndjson(segmentLine(), startLine(), resultLine())],
    ["没有 segment 直接 result", ndjson(startLine(), resultLine())],
    ["result 的 segments 与回调不一致", ndjson(startLine(), segmentLine(), resultLine(answer({}, [segment("a1", "另一段说明。")])))],
  ])("%s 固定失败并取消 reader", async (_label, text) => {
    let cancelled = false;
    const body = streamFrom([text], { cancel: () => { cancelled = true; } });
    const onSegment = vi.fn();
    await expect(readAskResponse(new Response(body, { headers }), { onSegment })).rejects.toMatchObject({
      name: "ByokError",
      code: expect.stringMatching(/INVALID_ANSWER|UPSTREAM_ERROR/),
    });
    if (!cancelled) expect(body.locked).toBe(false); else expect(cancelled).toBe(true);
    expect(body.locked).toBe(false);
    await expect(readAskResponse(responseOf(text), { onSegment })).rejects.toBeInstanceOf(ByokError);
  });
});

describe("readAskResponse §9 #45", () => {
  test("HTTP 配置错误复用 resolveByokError，不展示原 message", async () => {
    const secret = "raw-upstream-secret-do-not-show";
    const cases: Array<[number, Record<string, unknown>, string, string]> = [
      [400, { error: "CONFIGURATION_ERROR", message: secret }, "CONFIGURATION_ERROR", ASK_CONFIGURATION_ERROR_MESSAGE],
      [400, { code: "BYOK_KEY_REQUIRED", message: secret }, "BYOK_KEY_REQUIRED", "用自定义接口地址时，需要同时填你自己的 API Key"],
      [400, { error: "BASE_URL_INVALID", message: secret }, "BASE_URL_INVALID", "接口地址格式不对，要以 http:// 或 https:// 开头"],
      [400, { code: "NO_BYOK", message: secret }, "NO_BYOK", NO_BYOK_MESSAGE],
      [400, { error: "UPSTREAM_AUTH", message: secret }, "UPSTREAM_AUTH", UPSTREAM_AUTH_LECTURE_MESSAGE],
      [502, { code: "UPSTREAM_ERROR", message: secret }, "UPSTREAM_ERROR", UPSTREAM_ERROR_MESSAGE],
    ];
    for (const [status, body, code, message] of cases) {
      const error = await readAskResponse(Response.json(body, { status })).catch((caught: unknown) => caught);
      expect(error, code).toMatchObject({ code, message });
      expect((error as Error).message).not.toContain(secret);
    }
  });

  test("ask 专属码使用本地固定文案，忽略服务端 message", async () => {
    const secret = "服务端原文不能出现";
    const cases: Array<[string, string]> = [
      ["TIMEOUT", ASK_TIMEOUT_MESSAGE],
      ["INVALID_ANSWER", ASK_INVALID_ANSWER_MESSAGE],
      ["STEP_NOT_FOUND", ASK_STEP_NOT_FOUND_MESSAGE],
      ["ASK_BUSY", ASK_BUSY_MESSAGE],
      ["RATE_LIMITED", ASK_RATE_LIMITED_MESSAGE],
      ["CANCELLED", ASK_CANCELLED_MESSAGE],
      ["BAD_JSON", ASK_BAD_JSON_MESSAGE],
      ["BAD_REQUEST", ASK_BAD_REQUEST_MESSAGE],
      ["PAYLOAD_TOO_LARGE", ASK_PAYLOAD_TOO_LARGE_MESSAGE],
      ["NOT_FOUND", ASK_NOT_FOUND_MESSAGE],
    ];
    expect(ASK_BUSY_MESSAGE).toBe("上一个问题还在回答，答完再问");
    for (const [code, message] of cases) {
      const error = await readAskResponse(Response.json(
        { code, error: code, message: secret, retryable: true },
        { status: 400 },
      )).catch((caught: unknown) => caught);
      expect(error, code).toMatchObject({ code, message });
      expect((error as Error).message).not.toContain(secret);
    }
  });

  test("流内 retryable 必须与白名单一致，否则拒绝且不展示原文", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const secret = "late-secret-message";
    const mismatch = ndjson(
      startLine(),
      segmentLine(),
      JSON.stringify({ type: "error", code: "TIMEOUT", retryable: false, message: secret }),
    );
    const onSegment = vi.fn();
    await expect(readAskResponse(responseOf(mismatch), { onSegment })).rejects.toMatchObject({
      code: "UPSTREAM_ERROR",
      message: UPSTREAM_ERROR_MESSAGE,
    });
    expect(onSegment).toHaveBeenCalledTimes(1);

    const extra = ndjson(
      startLine(),
      segmentLine(),
      JSON.stringify({ type: "error", code: "STEP_NOT_FOUND", retryable: false, message: secret }),
    );
    await expect(readAskResponse(responseOf(extra))).rejects.toMatchObject({
      code: "UPSTREAM_ERROR",
    });

    const askBusy = ndjson(
      startLine(),
      segmentLine(),
      JSON.stringify({ type: "error", code: "ASK_BUSY", retryable: true }),
    );
    await expect(readAskResponse(responseOf(askBusy))).rejects.toMatchObject({
      code: "UPSTREAM_ERROR",
      message: UPSTREAM_ERROR_MESSAGE,
    });

    const allowed = ndjson(
      startLine(),
      segmentLine(),
      JSON.stringify({ type: "error", code: "TIMEOUT", retryable: true }),
    );
    await expect(readAskResponse(responseOf(allowed))).rejects.toMatchObject({
      code: "TIMEOUT",
      message: ASK_TIMEOUT_MESSAGE,
    });

    const stepMissing = ndjson(
      startLine(),
      segmentLine(),
      JSON.stringify({ type: "error", code: "STEP_NOT_FOUND", retryable: false }),
    );
    await expect(readAskResponse(responseOf(stepMissing))).rejects.toMatchObject({
      code: "STEP_NOT_FOUND",
      message: ASK_STEP_NOT_FOUND_MESSAGE,
    });

    const dumped = `${warn.mock.calls}${log.mock.calls}`;
    expect(dumped).not.toContain(secret);
  });
});

describe("readAskResponse §9 #46", () => {
  test("读流 TypeError、非用户 AbortError、断流使用固定文案，不露浏览器原文", async () => {
    const secret = "TypeError: network error secret-browser-text";
    const cases: unknown[] = [
      new TypeError(secret),
      Object.assign(new Error(secret), { name: "AbortError" }),
      Object.assign(new Error(secret), { name: "NetworkError" }),
    ];
    for (const error of cases) {
      const body = new ReadableStream({
        start(controller) {
          controller.error(error);
        },
      });
      const onSegment = vi.fn();
      const caught = await readAskResponse(new Response(body, { headers }), { onSegment }).catch((item: unknown) => item);
      expect(caught).toMatchObject({ code: "UPSTREAM_ERROR", message: ASK_INCOMPLETE_MESSAGE });
      expect((caught as Error).message).toContain("重新问");
      expect((caught as Error).message).not.toContain("secret-browser-text");
      expect((caught as Error).message).not.toContain("TypeError");
      expect(onSegment).not.toHaveBeenCalled();
      expect(body.locked).toBe(false);
    }
  });

  test("用户 signal 已 abort 映射为 CANCELLED，已收片段不算成功", async () => {
    const controller = new AbortController();
    controller.abort();
    const onSegment = vi.fn();
    const body = streamFrom([ndjson(startLine(), segmentLine(), resultLine())]);
    await expect(readAskResponse(new Response(body, { headers }), { onSegment }, { signal: controller.signal }))
      .rejects.toMatchObject({ code: "CANCELLED", message: ASK_CANCELLED_MESSAGE });
    expect(body.locked).toBe(false);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const hanging = new ReadableStream<Uint8Array>({
      async pull(ctrl) {
        ctrl.enqueue(new TextEncoder().encode(`${startLine()}\n${segmentLine()}\n`));
        await gate;
        ctrl.close();
      },
    });
    const live = new AbortController();
    const pending = readAskResponse(new Response(hanging, { headers }), { onSegment }, { signal: live.signal });
    await vi.waitFor(() => expect(onSegment).toHaveBeenCalled());
    live.abort();
    release();
    await expect(pending).rejects.toMatchObject({ code: "CANCELLED", message: ASK_CANCELLED_MESSAGE });
    expect(hanging.locked).toBe(false);
  });
});

describe("readAskResponse §9 #47", () => {
  test("UTF-8、跨 chunk、CRLF 与尾行无换行都能还原完整回答", async () => {
    const narration = "补数是目标减去当前值。";
    const value = answer({}, [segment("a1", narration), segment("a2", "再看哈希表。")]);
    const text = [
      startLine(),
      segmentLine(value.segments[0]!),
      segmentLine(value.segments[1]!),
      resultLine(value),
    ].join("\r\n");
    const bytes = Buffer.from(text, "utf8");
    const chunks: string[] = [];
    const decoder = new TextDecoder("utf-8");
    for (let index = 0; index < bytes.length; index += 5) {
      const part = decoder.decode(bytes.subarray(index, Math.min(index + 5, bytes.length)), { stream: true });
      if (part) chunks.push(part);
    }
    const tail = decoder.decode();
    if (tail) chunks.push(tail);
    const seen: AnswerSegment[] = [];
    const result = await readAskResponse(new Response(streamFrom(chunks), { headers }), {
      onSegment: (item) => seen.push(item),
    });
    expect(result).toEqual(value);
    expect(seen).toEqual(value.segments);
  });

  test("单行与总字节上限、缺 body、畸形 JSON 都失败并释放锁", async () => {
    let cancelled = false;
    const huge = "x".repeat(64 * 1024 + 1);
    const lineBody = streamFrom([huge], { cancel: () => { cancelled = true; } });
    await expect(readAskResponse(new Response(lineBody, { headers }))).rejects.toMatchObject({
      code: "INVALID_ANSWER",
      message: ASK_INVALID_ANSWER_MESSAGE,
    });
    expect(cancelled).toBe(true);
    expect(lineBody.locked).toBe(false);

    let totalCancelled = false;
    const filler = `${"y".repeat(1024)}\n`;
    const totalBody = streamFrom([filler.repeat(513)], { cancel: () => { totalCancelled = true; } });
    await expect(readAskResponse(new Response(totalBody, { headers }))).rejects.toMatchObject({
      code: "INVALID_ANSWER",
    });
    expect(totalCancelled).toBe(true);
    expect(totalBody.locked).toBe(false);

    await expect(readAskResponse(new Response(null, { headers }))).rejects.toMatchObject({
      code: "INVALID_ANSWER",
      message: ASK_INVALID_ANSWER_MESSAGE,
    });

    const broken = streamFrom([`${startLine()}\n{`], {
      cancel: () => { cancelled = true; },
    });
    cancelled = false;
    await expect(readAskResponse(new Response(broken, { headers }))).rejects.toMatchObject({
      code: "INVALID_ANSWER",
    });
    if (!cancelled) expect(broken.locked).toBe(false); else expect(cancelled).toBe(true);
    expect(broken.locked).toBe(false);
  });

  test("JSON 成功兼容校验 answer；非法 JSON 不能成功；不打印 rawMsg", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const value = answer();
    const secret = "raw-json-secret";
    await expect(readAskResponse(Response.json({ answer: value }))).resolves.toEqual(value);
    await expect(readAskResponse(Response.json({ answer: { ...value, v: 2 }, message: secret }))).rejects.toMatchObject({
      code: "INVALID_ANSWER",
    });
    await expect(readAskResponse(new Response("not-json", {
      headers: { "Content-Type": "application/json" },
    }))).rejects.toMatchObject({ code: "INVALID_ANSWER" });

    const errorBody = streamFrom([ndjson(
      startLine(),
      segmentLine(),
      JSON.stringify({ type: "error", code: "INVALID_ANSWER", retryable: true, message: secret }),
    )]);
    await expect(readAskResponse(new Response(errorBody, { headers }))).rejects.toMatchObject({
      code: "UPSTREAM_ERROR",
    });
    const dumped = JSON.stringify([warn.mock.calls, info.mock.calls, log.mock.calls]);
    expect(dumped).not.toContain(secret);
    expect(errorBody.locked).toBe(false);
  });

  test("回调抛错也取消 reader 并释放锁", async () => {
    let cancelled = false;
    const body = streamFrom([ndjson(startLine(), segmentLine(), resultLine())], {
      cancel: () => { cancelled = true; },
    });
    await expect(readAskResponse(new Response(body, { headers }), {
      onSegment: () => { throw new Error("preview failed"); },
    })).rejects.toThrow("preview failed");
    expect(cancelled).toBe(true);
    expect(body.locked).toBe(false);
  });
});
