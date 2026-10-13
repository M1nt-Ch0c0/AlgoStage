/** 增量读取已校验步骤；完整 result 到达前不能当作完成的教案。 */
import {
  ByokError,
  LECTURE_TIMEOUT_MESSAGE,
  resolveByokError,
  toByokError,
  UPSTREAM_AUTH_LECTURE_MESSAGE,
  UPSTREAM_ERROR_MESSAGE,
} from "@/lib/byok/client";
import { stepAnswersMapSchema } from "@/lib/ask/schema";
import type { StepAnswersMap } from "@/lib/ask/types";
import { teachingStepSchema } from "@/lib/teaching/schema";
import type { TeachingStep } from "@/lib/teaching/types";

export { LECTURE_TIMEOUT_MESSAGE } from "@/lib/byok/client";

function asRecord(data: unknown): Record<string, unknown> {
  return data !== null && typeof data === "object" ? (data as Record<string, unknown>) : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** 旧响应没有这些字段时用空默认值；不写入播放器 store。 */
export function readLectureMeta(data: unknown): {
  cacheKey: string;
  scriptVersion: string;
  answers: StepAnswersMap;
  askDisabledStepIds: string[];
} {
  const record = asRecord(data);
  const parsedAnswers = stepAnswersMapSchema.safeParse(record.answers);
  const ids = record.askDisabledStepIds;
  return {
    cacheKey: asString(record.cacheKey),
    scriptVersion: asString(record.scriptVersion),
    answers: parsedAnswers.success ? parsedAnswers.data : {},
    askDisabledStepIds: Array.isArray(ids) && ids.every((id) => typeof id === "string") ? ids : [],
  };
}

/** 读流时网络断开（fetch reader 抛 TypeError 等）：已收步骤保留，提示中断。 */
export const LECTURE_INTERRUPTED_MESSAGE = "备课中断，网络连接已断开，请重试。";

/** 浏览器网络/读流错误（TypeError: network error、非用户触发的 AbortError 等），不含业务错误。 */
export function isNetworkStreamError(error: unknown): boolean {
  if (error instanceof ByokError) return error.code === "INTERRUPTED";
  if (error instanceof TypeError) return true;
  const name = (error as { name?: unknown } | null)?.name;
  return name === "AbortError" || name === "NetworkError";
}

/**
 * 把网络/读流错误归一成 A5 错误：已收到 ≥1 步 → INTERRUPTED（保留步骤）；0 步 → UPSTREAM_ERROR。
 * 不是网络错误时返回 null。绝不透出浏览器原文。
 */
export function normalizeNetworkError(
  error: unknown,
  receivedSteps: number,
): { code: string; message: string } | null {
  if (!isNetworkStreamError(error)) return null;
  return receivedSteps > 0
    ? { code: "INTERRUPTED", message: LECTURE_INTERRUPTED_MESSAGE }
    : { code: "UPSTREAM_ERROR", message: UPSTREAM_ERROR_MESSAGE };
}

const STREAM_ERROR_MAP: Record<string, string> = {
  TIMEOUT: LECTURE_TIMEOUT_MESSAGE,
  UPSTREAM_AUTH: UPSTREAM_AUTH_LECTURE_MESSAGE,
  AUTH_ERROR: UPSTREAM_AUTH_LECTURE_MESSAGE,
  INVALID_SCRIPT: "教案不合法，请换用 gpt-6.1-sol。",
  CANCELLED: "备课已取消，未保存教案。",
  UPSTREAM_ERROR: UPSTREAM_ERROR_MESSAGE,
};

export async function readLectureResponse(
  response: Response,
  onProgress: (message: string) => void,
  onStep?: (step: TeachingStep, update: boolean) => void,
): Promise<unknown> {
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw toByokError(
      data,
      "这次备课未能完成，请重试或换用 gpt-6.1-sol。",
    );
  }
  if (
    !(response.headers.get("content-type") ?? "").includes(
      "application/x-ndjson",
    )
  )
    return (await response.json()).script;
  if (!response.body)
    throw new ByokError("EMPTY_BODY", "没有收到教案，请重试或换用 gpt-6.1-sol。");
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let buffer = "",
    script: unknown,
    complete = false;
  const parse = (line: string) => {
    if (!line.trim()) return;
    const event = JSON.parse(line);
    if (
      event.type === "progress" &&
      Number.isInteger(event.attempt) &&
      event.attempt >= 1 &&
      typeof event.message === "string"
    )
      onProgress(event.message);
    else if (event.type === "step" || event.type === "step-update")
      onStep?.(
        teachingStepSchema.parse(event.step),
        event.type === "step-update",
      );
    else if (event.type === "result") {
      script = event.script;
      complete = true;
    } else if (event.type === "error") {
      const rawCode = event.code ?? event.error;
      const code = typeof rawCode === "string" ? rawCode.trim() : "";
      if (!code) {
        throw new ByokError("STREAM_ERROR", "备课失败，请重试或换用 gpt-6.1-sol。");
      }
      const rawMsg =
        typeof event.message === "string" ? event.message.trim() : "";
      const resolved = resolveByokError({ code, error: code });
      if (resolved) {
        if (resolved.code === "UPSTREAM_ERROR") {
          console.warn(rawMsg && rawMsg !== resolved.code ? rawMsg : resolved.code);
        }
        throw new ByokError(resolved.code, resolved.message);
      }
      if (Object.hasOwn(STREAM_ERROR_MAP, code)) {
        const mappedCode = code === "AUTH_ERROR" ? "UPSTREAM_AUTH" : code;
        throw new ByokError(mappedCode, STREAM_ERROR_MAP[code]);
      }
      console.warn(rawMsg && rawMsg !== code ? rawMsg : code);
      throw new ByokError("UPSTREAM_ERROR", UPSTREAM_ERROR_MESSAGE);
    } else
      throw new ByokError("INVALID_STREAM", "备课数据无法读取，请重试或换用 gpt-6.1-sol。");
  };
  try {
    while (true) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (error) {
        if (error instanceof ByokError) throw error;
        // 连接被直接断开（无 error 事件）：浏览器抛 TypeError: network error，归一为 INTERRUPTED。
        throw new ByokError("INTERRUPTED", LECTURE_INTERRUPTED_MESSAGE);
      }
      const { value, done } = chunk;
      buffer += decoder.decode(value, { stream: !done });
      if (buffer.length > 1024 * 1024)
        throw new ByokError("PAYLOAD_TOO_LARGE", "教案数据过大，请重试。");
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
      }
      if (done) break;
    }
    parse(buffer);
    if (!complete)
      throw new ByokError(
        "INCOMPLETE_STREAM",
        "备课中断，未收到完整教案，请重试或换用 gpt-6.1-sol。",
      );
    return script;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/**
 * 备课中途断开类错误：已收到的步骤可保留播放。
 * - TIMEOUT / INTERRUPTED / INCOMPLETE_STREAM（流未完整结束）：总是算断开。
 * - UPSTREAM_ERROR（上游 EOF/RST/500，服务端重试后放弃）：只有已收到 ≥1 步时才算断开；
 *   0 步时仍按普通失败清空。UPSTREAM_AUTH、INVALID_SCRIPT 等不算（v0.2.2 范围）。
 */
export function isLectureCutOff(error: unknown, receivedSteps = 0): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "TIMEOUT" || code === "INTERRUPTED" || code === "INCOMPLETE_STREAM") return true;
  return code === "UPSTREAM_ERROR" && receivedSteps > 0;
}
