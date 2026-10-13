/** 增量读取已校验回答；完整 result 到达前不能当作完成的 StepAnswer。 */
import {
  ByokError,
  resolveByokError,
  UPSTREAM_AUTH_LECTURE_MESSAGE,
  UPSTREAM_ERROR_MESSAGE,
} from "@/lib/byok/client";
import { answerSegmentSchema, stepAnswerSchema } from "@/lib/ask/schema";
import type { AnswerSegment, AskStart, StepAnswer } from "@/lib/ask/types";

export interface AskResponseHandlers {
  onStart?: (start: AskStart) => void;
  onSegment?: (segment: AnswerSegment) => void;
}

/** 与 streamErrorEvent 的固定 retryable 一致。流后只允许其中一部分。 */
const streamErrorRetryable = {
  TIMEOUT: true,
  INVALID_SCRIPT: true,
  UPSTREAM_AUTH: false,
  UPSTREAM_ERROR: true,
  CANCELLED: false,
  BASE_URL_NOT_ALLOWED: false,
  BASE_URL_INVALID: false,
  BYOK_KEY_REQUIRED: false,
  CONFIGURATION_ERROR: false,
  NO_BYOK: false,
  BAD_REQUEST: false,
  BAD_JSON: false,
  NOT_FOUND: false,
  SETTINGS_LOCKED: false,
  INVALID_ANSWER: true,
  STEP_NOT_FOUND: false,
  ASK_BUSY: true,
  RATE_LIMITED: true,
  PAYLOAD_TOO_LARGE: false,
} as const;

type StreamErrorCode = keyof typeof streamErrorRetryable;

/** 首段之后对外 error 只允许这些码。 */
const POST_STREAM_CODES = [
  "UPSTREAM_AUTH",
  "TIMEOUT",
  "UPSTREAM_ERROR",
  "INVALID_ANSWER",
  "CANCELLED",
  "STEP_NOT_FOUND",
] as const satisfies readonly StreamErrorCode[];

const POST_STREAM = new Set<string>(POST_STREAM_CODES);

const LINE_MAX_BYTES = 64 * 1024;
const TOTAL_MAX_BYTES = 512 * 1024;

/** 提问失败的本地固定文案。不展示服务端或模型原文。 */
export const ASK_BUSY_MESSAGE = "上一个问题还在回答，答完再问";
export const ASK_TIMEOUT_MESSAGE = "回答超时，请重新问。";
export const ASK_INVALID_ANSWER_MESSAGE = "回答内容暂时没生成好，请重新问。";
export const ASK_STEP_NOT_FOUND_MESSAGE = "这节课已更新或这一步不可用，请刷新。";
export const ASK_RATE_LIMITED_MESSAGE = "问得有点快，请稍后再问。";
export const ASK_CANCELLED_MESSAGE = "已取消。";
export const ASK_CONFIGURATION_ERROR_MESSAGE = "Key、地址、服务商不一致，去设置检查一下。";
export const ASK_BAD_JSON_MESSAGE = "请求内容无效，请重新发送。";
export const ASK_BAD_REQUEST_MESSAGE = "提问参数不正确，请检查问题和选区。";
export const ASK_PAYLOAD_TOO_LARGE_MESSAGE = "请求过大，请移除截图后重新提问。";
export const ASK_NOT_FOUND_MESSAGE = "没找到这道题，请回路线图重新选择。";
export const ASK_INVALID_STREAM_MESSAGE = "回答数据无法读取，请重新问。";
export const ASK_INCOMPLETE_MESSAGE = `${UPSTREAM_ERROR_MESSAGE}重新问`;

const ASK_ERROR_MESSAGES: Partial<Record<StreamErrorCode, string>> = {
  CONFIGURATION_ERROR: ASK_CONFIGURATION_ERROR_MESSAGE,
  TIMEOUT: ASK_TIMEOUT_MESSAGE,
  INVALID_ANSWER: ASK_INVALID_ANSWER_MESSAGE,
  STEP_NOT_FOUND: ASK_STEP_NOT_FOUND_MESSAGE,
  ASK_BUSY: ASK_BUSY_MESSAGE,
  RATE_LIMITED: ASK_RATE_LIMITED_MESSAGE,
  CANCELLED: ASK_CANCELLED_MESSAGE,
  BAD_JSON: ASK_BAD_JSON_MESSAGE,
  BAD_REQUEST: ASK_BAD_REQUEST_MESSAGE,
  PAYLOAD_TOO_LARGE: ASK_PAYLOAD_TOO_LARGE_MESSAGE,
  NOT_FOUND: ASK_NOT_FOUND_MESSAGE,
  INVALID_SCRIPT: ASK_INVALID_STREAM_MESSAGE,
  UPSTREAM_AUTH: UPSTREAM_AUTH_LECTURE_MESSAGE,
  UPSTREAM_ERROR: UPSTREAM_ERROR_MESSAGE,
};

function isStreamErrorCode(code: string): code is StreamErrorCode {
  return Object.hasOwn(streamErrorRetryable, code);
}

function askError(code: string, message: string): ByokError {
  return new ByokError(code, message);
}

/** fail 先 cancel 再抛，控制流分析不把它当出口。赋值后再取已收窄的值。 */
function defined<T>(value: T | undefined, fail: (code: string, message: string) => never): T {
  if (value === undefined) fail("UPSTREAM_ERROR", ASK_INCOMPLETE_MESSAGE);
  return value as T;
}

function messageFor(code: StreamErrorCode): string {
  return ASK_ERROR_MESSAGES[code] ?? UPSTREAM_ERROR_MESSAGE;
}

/** 已知码只传 code，不把不可信 message 交给 resolveByokError。 */
function httpError(data: unknown): ByokError {
  const record = data !== null && typeof data === "object" ? (data as Record<string, unknown>) : {};
  const raw = record.code ?? record.error;
  const code = typeof raw === "string" ? raw.trim() : "";
  if (code && isStreamErrorCode(code) && ASK_ERROR_MESSAGES[code]) {
    return askError(code, ASK_ERROR_MESSAGES[code]);
  }
  const resolved = resolveByokError(code ? { code, error: code } : undefined);
  if (resolved) return askError(resolved.code, resolved.message);
  return askError("UPSTREAM_ERROR", UPSTREAM_ERROR_MESSAGE);
}

function userAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function isUserAbortError(error: unknown, signal: AbortSignal | undefined): boolean {
  if (userAborted(signal)) return true;
  if (!error || typeof error !== "object") return false;
  const name = (error as { name?: unknown }).name;
  return name === "AbortError" && userAborted(signal);
}

function sameSegment(left: AnswerSegment, right: AnswerSegment): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

type Phase = "start" | "segment" | "done";

export async function readAskResponse(
  response: Response,
  handlers: AskResponseHandlers = {},
  options: { signal?: AbortSignal } = {},
): Promise<StepAnswer> {
  const signal = options.signal;
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    if (userAborted(signal)) throw askError("CANCELLED", ASK_CANCELLED_MESSAGE);
    throw httpError(data);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/x-ndjson")) {
    const data = await response.json().catch(() => null);
    if (userAborted(signal)) throw askError("CANCELLED", ASK_CANCELLED_MESSAGE);
    const answer = data !== null && typeof data === "object" ? (data as { answer?: unknown }).answer : undefined;
    const parsed = stepAnswerSchema.safeParse(answer);
    if (!parsed.success) throw askError("INVALID_ANSWER", ASK_INVALID_ANSWER_MESSAGE);
    return parsed.data;
  }

  if (!response.body) throw askError("INVALID_ANSWER", ASK_INVALID_ANSWER_MESSAGE);

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let totalBytes = 0;
  let phase: Phase = "start";
  let start: AskStart | undefined;
  const segments: AnswerSegment[] = [];
  let answer: StepAnswer | undefined;
  let complete = false;
  let onAbort: (() => void) | undefined;

  const fail = (code: string, message: string): never => {
    // 流已被读完时 finally 里的 cancel 不会再触发底层 cancel。先取消再抛。
    void reader.cancel().catch(() => {});
    throw askError(code, message);
  };

  const parse = (line: string) => {
    if (!line.trim()) return;
    if (complete) fail("INVALID_ANSWER", ASK_INVALID_ANSWER_MESSAGE);
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      fail("INVALID_ANSWER", ASK_INVALID_ANSWER_MESSAGE);
    }
    if (event === null || typeof event !== "object" || Array.isArray(event)) {
      fail("INVALID_ANSWER", ASK_INVALID_ANSWER_MESSAGE);
    }
    const record = event as Record<string, unknown>;
    if (record.type === "start") {
      if (phase !== "start") fail("INVALID_ANSWER", ASK_INVALID_ANSWER_MESSAGE);
      const answerId = record.answerId;
      const stepId = record.stepId;
      const imageUsed = record.imageUsed;
      if (
        typeof answerId === "string" && answerId &&
        typeof stepId === "string" && stepId &&
        typeof imageUsed === "boolean"
      ) {
        const id = answerId;
        const step = stepId;
        const used = imageUsed;
        start = { answerId: id, stepId: step, imageUsed: used };
        phase = "segment";
        handlers.onStart?.(start);
        return;
      }
      fail("INVALID_ANSWER", ASK_INVALID_ANSWER_MESSAGE);
    }
    if (record.type === "segment") {
      if (phase !== "segment" || !start) fail("INVALID_ANSWER", ASK_INVALID_ANSWER_MESSAGE);
      const parsed = answerSegmentSchema.safeParse(record.segment);
      if (!parsed.success) fail("INVALID_ANSWER", ASK_INVALID_ANSWER_MESSAGE);
      const segment = parsed.data;
      if (segment) {
        segments.push(segment);
        phase = "segment";
        handlers.onSegment?.(segment);
        return;
      }
      fail("INVALID_ANSWER", ASK_INVALID_ANSWER_MESSAGE);
    }
    if (record.type === "result") {
      if (phase !== "segment" || !start || segments.length === 0) {
        fail("INVALID_ANSWER", ASK_INVALID_ANSWER_MESSAGE);
      }
      const currentStart = start;
      const parsed = stepAnswerSchema.safeParse(record.answer);
      if (!parsed.success) fail("INVALID_ANSWER", ASK_INVALID_ANSWER_MESSAGE);
      const value = parsed.data;
      if (value && currentStart) {
        if (value.id !== currentStart.answerId || value.stepId !== currentStart.stepId) {
          fail("INVALID_ANSWER", ASK_INVALID_ANSWER_MESSAGE);
        }
        if (value.segments.length !== segments.length || value.segments.some((item, index) => !sameSegment(item, segments[index]!))) {
          fail("INVALID_ANSWER", ASK_INVALID_ANSWER_MESSAGE);
        }
        answer = value;
        complete = true;
        phase = "done";
        return;
      }
      fail("INVALID_ANSWER", ASK_INVALID_ANSWER_MESSAGE);
    }
    if (record.type === "error") {
      const rawCode = record.code ?? record.error;
      const code = typeof rawCode === "string" ? rawCode.trim() : "";
      if (!code || !POST_STREAM.has(code) || !isStreamErrorCode(code)) {
        fail("UPSTREAM_ERROR", UPSTREAM_ERROR_MESSAGE);
      }
      const known = code as StreamErrorCode;
      if (record.retryable !== streamErrorRetryable[known]) {
        fail("UPSTREAM_ERROR", UPSTREAM_ERROR_MESSAGE);
      }
      const keys = Object.keys(record);
      if (keys.some(key => key !== "type" && key !== "code" && key !== "retryable")) {
        fail("UPSTREAM_ERROR", UPSTREAM_ERROR_MESSAGE);
      }
      fail(known, messageFor(known));
    }
    fail("INVALID_ANSWER", ASK_INVALID_ANSWER_MESSAGE);
  };

  const aborted = () => {
    if (!userAborted(signal)) return;
    fail("CANCELLED", ASK_CANCELLED_MESSAGE);
  };

  if (signal) {
    onAbort = () => {
      void reader.cancel().catch(() => {});
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    aborted();
    while (true) {
      let chunk: ReadableStreamReadResult<Uint8Array> | undefined;
      try {
        chunk = await reader.read();
      } catch (error) {
        if (error instanceof ByokError) throw error;
        if (isUserAbortError(error, signal)) fail("CANCELLED", ASK_CANCELLED_MESSAGE);
        // 连接被直接断开：不透出浏览器原文。
        fail("UPSTREAM_ERROR", ASK_INCOMPLETE_MESSAGE);
      }
      if (chunk === undefined) fail("UPSTREAM_ERROR", ASK_INCOMPLETE_MESSAGE);
      aborted();
      const read = defined(chunk, fail);
      const { value, done } = read;
      if (value) {
        totalBytes += value.byteLength;
        if (totalBytes > TOTAL_MAX_BYTES) fail("INVALID_ANSWER", ASK_INVALID_ANSWER_MESSAGE);
        let text = "";
        try {
          text = decoder.decode(value, { stream: !done });
        } catch {
          fail("INVALID_ANSWER", ASK_INVALID_ANSWER_MESSAGE);
        }
        buffer += text;
      } else if (done) {
        try {
          buffer += decoder.decode();
        } catch {
          fail("INVALID_ANSWER", ASK_INVALID_ANSWER_MESSAGE);
        }
      }
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end);
        const lineBytes = new TextEncoder().encode(line.replace(/\r$/, "")).byteLength;
        if (lineBytes > LINE_MAX_BYTES) fail("INVALID_ANSWER", ASK_INVALID_ANSWER_MESSAGE);
        buffer = buffer.slice(end + 1);
        parse(line.endsWith("\r") ? line.slice(0, -1) : line);
        aborted();
      }
      if (new TextEncoder().encode(buffer).byteLength > LINE_MAX_BYTES) {
        fail("INVALID_ANSWER", ASK_INVALID_ANSWER_MESSAGE);
      }
      if (done) break;
    }
    if (buffer.length > 0) {
      if (new TextEncoder().encode(buffer).byteLength > LINE_MAX_BYTES) {
        fail("INVALID_ANSWER", ASK_INVALID_ANSWER_MESSAGE);
      }
      parse(buffer);
    }
    aborted();
    if (!complete || !answer) fail("UPSTREAM_ERROR", ASK_INCOMPLETE_MESSAGE);
    if (!answer) fail("UPSTREAM_ERROR", ASK_INCOMPLETE_MESSAGE);
    return defined(answer, fail);
  } finally {
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
