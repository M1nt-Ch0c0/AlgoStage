/** 一次提问一次上游生成：JSON 行逐段校验后才回调。失败不重试、不打印原文。 */
import { streamText, type ModelMessage, type TextStreamPart, type ToolSet } from "ai";
import { answerSegmentSchema } from "@/lib/ask/schema";
import { ASK_LIMITS } from "@/lib/ask/types";
import type { AnswerSegment } from "@/lib/ask/types";
import { createModel, type ByokConfig } from "./provider";
import { upstreamStatusCode } from "./upstream-retry";

export class InvalidAnswerError extends Error {}

export type AskGenerationResult =
  | { ok: true; segments: AnswerSegment[] }
  | {
      ok: false;
      status: number;
      error: "UPSTREAM_AUTH" | "UPSTREAM_ERROR" | "TIMEOUT" | "CANCELLED" | "INVALID_ANSWER";
    };

/** Upstream text ceiling. A request body uses 413; model output uses INVALID_ANSWER. */
const UPSTREAM_TEXT_MAX_BYTES = 512 * 1024;
const UPSTREAM_LINE_MAX_BYTES = 64 * 1024;
const NORMALIZED_SEGMENT_MAX_BYTES = 4 * 1024;

export async function generateAsk(input: {
  config: ByokConfig;
  prompt: string;
  image?: { mime: "image/webp" | "image/jpeg"; dataBase64: string };
  signal: AbortSignal;
  assertNoRequestKey: (value: unknown) => void;
  onSegment: (segment: AnswerSegment) => void;
  /**
   * Deviation from the §3.2 signature: optional reference code so code-line and
   * code-token targets can be checked against the current problem. The route
   * owns the trusted script and passes the same reference it used for validation.
   */
  referenceCode?: string;
}): Promise<AskGenerationResult> {
  const parser = new SegmentParser(input);
  try {
    const stream = streamText({
      model: createModel(input.config),
      system: input.prompt,
      messages: [userMessage(input.image)],
      maxRetries: 0,
      maxOutputTokens: 4096,
      abortSignal: input.signal,
      onError: () => {},
      include: { rawChunks: true },
    });
    for await (const part of stream.fullStream) {
      if (input.signal.aborted) return abortResult(input.signal);
      const failure = consumePart(part, parser);
      if (failure) return failure;
    }
    if (input.signal.aborted) return abortResult(input.signal);
    return parser.finish(await stream.finishReason);
  } catch (error) {
    if (input.signal.aborted) return abortResult(input.signal);
    if (error instanceof InvalidAnswerError) return invalid();
    return mapUpstream(error);
  }
}

function userMessage(image: { mime: "image/webp" | "image/jpeg"; dataBase64: string } | undefined): ModelMessage {
  if (!image) {
    return { role: "user", content: "请按系统规范，只回答资料中的当前问题。" };
  }
  // Decoded bytes, not the base64 string. The SDK rewrites an image part into a
  // file part and may sniff media type from the bytes; the caller already decided
  // this model accepts an image.
  return {
    role: "user",
    content: [
      { type: "text", text: "请按系统规范，只回答资料中的当前问题。截图仅作参照。" },
      { type: "image", image: Buffer.from(image.dataBase64, "base64"), mediaType: image.mime },
    ],
  };
}

function consumePart(part: TextStreamPart<ToolSet>, parser: SegmentParser): AskGenerationResult | undefined {
  if (part.type === "raw") {
    const status = upstreamStatusCode(part.rawValue);
    if (status === 401 || status === 403) return auth();
    return undefined;
  }
  if (part.type === "error") return mapUpstream(part.error);
  if (part.type !== "text-delta") return undefined;
  try {
    parser.push(part.text);
  } catch (error) {
    if (error instanceof InvalidAnswerError) return invalid();
    throw error;
  }
  return undefined;
}

function abortResult(signal: AbortSignal): AskGenerationResult {
  const reason = signal.reason;
  if (reason === "timeout" || (typeof reason === "object" && reason !== null && (reason as { code?: unknown }).code === "TIMEOUT")) {
    return { ok: false, status: 504, error: "TIMEOUT" };
  }
  return { ok: false, status: 499, error: "CANCELLED" };
}

function mapUpstream(error: unknown): AskGenerationResult {
  if (isAbortError(error)) return { ok: false, status: 499, error: "CANCELLED" };
  const status = upstreamStatusCode(error);
  // 只记录固定分类和状态码。原始错误、URL 和 Key 都不打印。
  console.warn("ask_upstream", JSON.stringify({ type: "upstream_error", status: status ?? null }));
  if (status === 401 || status === 403) return auth();
  return { ok: false, status: 502, error: "UPSTREAM_ERROR" };
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === "AbortError") ||
    (typeof error === "object" && error !== null && (error as { name?: unknown }).name === "AbortError")
  );
}

function auth(): AskGenerationResult {
  return { ok: false, status: 400, error: "UPSTREAM_AUTH" };
}

function invalid(): AskGenerationResult {
  return { ok: false, status: 422, error: "INVALID_ANSWER" };
}

class SegmentParser {
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private pending: Uint8Array = new Uint8Array(0);
  private totalBytes = 0;
  private readonly segments: AnswerSegment[] = [];
  private readonly ids = new Set<string>();
  private finished = false;
  private readonly lineCount: number;

  constructor(private readonly input: {
    assertNoRequestKey: (value: unknown) => void;
    onSegment: (segment: AnswerSegment) => void;
    referenceCode?: string;
  }) {
    // Same trim as the numbered code in the prompt, so a trailing newline is not an extra line.
    const code = (input.referenceCode ?? "").trimEnd();
    this.lineCount = code.length === 0 ? 0 : code.split("\n").length;
  }

  push(text: string): void {
    if (text.length === 0) return;
    const bytes = Buffer.from(text, "utf8");
    this.totalBytes += bytes.byteLength;
    if (this.totalBytes > UPSTREAM_TEXT_MAX_BYTES) throw new InvalidAnswerError();
    const merged = new Uint8Array(this.pending.byteLength + bytes.byteLength);
    merged.set(this.pending, 0);
    merged.set(bytes, this.pending.byteLength);
    const { lines, rest } = splitLines(merged);
    if (rest.byteLength > UPSTREAM_LINE_MAX_BYTES) throw new InvalidAnswerError();
    this.pending = rest;
    for (const line of lines) {
      if (line.byteLength > UPSTREAM_LINE_MAX_BYTES) throw new InvalidAnswerError();
      this.acceptLine(line);
    }
  }

  finish(finishReason: string): AskGenerationResult {
    if (finishReason === "length") return invalid();
    if (this.pending.byteLength > UPSTREAM_LINE_MAX_BYTES) throw new InvalidAnswerError();
    if (this.pending.byteLength > 0) {
      this.acceptLine(this.pending);
      this.pending = new Uint8Array(0);
    }
    if (!this.finished || this.segments.length === 0) return invalid();
    return { ok: true, segments: this.segments };
  }

  private acceptLine(bytes: Uint8Array): void {
    // Bytes were encoded from JS strings, so this is valid UTF-8.
    const text = this.decoder.decode(bytes);
    if (text.length === 0) return;
    if (this.finished) throw new InvalidAnswerError();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new InvalidAnswerError();
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new InvalidAnswerError();
    const record = parsed as { type?: unknown; segment?: unknown };
    if (record.type === "finish") {
      if (this.segments.length === 0 || Object.keys(record).some((key) => key !== "type")) {
        throw new InvalidAnswerError();
      }
      this.input.assertNoRequestKey(text);
      this.finished = true;
      return;
    }
    if (record.type !== "segment") throw new InvalidAnswerError();
    if (this.segments.length >= ASK_LIMITS.segmentsMax) throw new InvalidAnswerError();
    this.input.assertNoRequestKey(text);
    this.input.assertNoRequestKey(record.segment);
    const result = answerSegmentSchema.safeParse(record.segment);
    if (!result.success) throw new InvalidAnswerError();
    const segment = result.data;
    this.checkSemantics(segment);
    const normalized = JSON.stringify(segment);
    if (Buffer.byteLength(normalized, "utf8") > NORMALIZED_SEGMENT_MAX_BYTES) throw new InvalidAnswerError();
    this.input.assertNoRequestKey(segment);
    this.ids.add(segment.id);
    this.segments.push(segment);
    this.input.onSegment(segment);
  }

  private checkSemantics(segment: AnswerSegment): void {
    if (segment.id.trim().length === 0 || this.ids.has(segment.id)) throw new InvalidAnswerError();
    const targets = segment.targets ?? [];
    for (const effect of segment.effects ?? []) {
      if (effect.targetIndex !== undefined && effect.targetIndex >= targets.length) {
        throw new InvalidAnswerError();
      }
    }
    for (const target of targets) {
      if (target.kind === "code-line") {
        const end = target.end ?? target.start;
        if (target.start > this.lineCount || end > this.lineCount) throw new InvalidAnswerError();
      } else if (target.kind === "code-token") {
        if (target.line > this.lineCount) throw new InvalidAnswerError();
      }
    }
  }
}

/** Split on LF. A trailing CR on a complete line is the CRLF terminator, not content. */
function splitLines(bytes: Uint8Array): { lines: Uint8Array[]; rest: Uint8Array } {
  const lines: Uint8Array[] = [];
  let start = 0;
  for (let index = 0; index < bytes.byteLength; index++) {
    if (bytes[index] !== 0x0a) continue;
    let end = index;
    if (end > start && bytes[end - 1] === 0x0d) end -= 1;
    lines.push(bytes.subarray(start, end));
    start = index + 1;
  }
  return { lines, rest: bytes.subarray(start) };
}
