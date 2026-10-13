/** AI 路由先校验参数类型，错误响应不携带输入值或 Key。 */
import { z } from "zod";
import { AI_CONNECTION_ERROR, INVALID_AI_BASE_URL, MALFORMED_AI_BASE_URL, normalizeAIBaseURL } from "@/lib/ai/egress-guard";
import { askSelectionSchema } from "@/lib/ask/schema";
import { summarizeSelection } from "@/lib/ask/answers";
import { ASK_LIMITS } from "@/lib/ask/types";
import type { AskSelection } from "@/lib/ask/types";
import { CAPTURE_DEFAULTS, decodedBase64Bytes } from "@/lib/ask/capture";

export const aiBaseURLSchema = z.string().transform((value, ctx) => {
  try { return normalizeAIBaseURL(value); }
  catch {
    ctx.addIssue({ code: "custom", message: MALFORMED_AI_BASE_URL });
    return z.NEVER;
  }
});

export const byokRequestSchema = z.object({
  provider: z.enum(["openai-compatible", "anthropic", "google"]).optional(),
  model: z.string().trim().optional(),
  apiKey: z.string().trim().optional(),
  baseURL: aiBaseURLSchema.optional(),
});

const common = {
  slug: z.string().trim().min(1),
  byok: byokRequestSchema.nullable().optional(),
};

export const lectureRequestSchema = z.object({
  ...common,
  regenerate: z.boolean().default(false),
  language: z.enum(["zh", "en"]).default("zh"),
  solutionLanguage: z.enum(["typescript", "python"]).default("typescript"),
});

export const hintRequestSchema = z.object({
  ...common,
  level: z.number().int().min(1).max(5),
  userCode: z.string().optional(),
});

/** 整个提问请求的 UTF-8 字节上限。 */
export const ASK_BODY_MAX_BYTES = 768 * 1024;

/** 规范化选区摘要的 JSON UTF-8 字节上限，防止未限制的 id/nodeIds 占满上下文。 */
export const ASK_SELECTION_SUMMARY_MAX_BYTES = 16 * 1024;

const sha1Hex = z.string().regex(/^[0-9a-f]{40}$/);
const canonicalBase64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export const askImageSchema = z.object({
  mime: z.enum(["image/webp", "image/jpeg"]),
  dataBase64: z.string().min(1)
    .max(4 * Math.ceil(CAPTURE_DEFAULTS.maxBytes / 3))
    .regex(canonicalBase64)
    .refine(v => Buffer.from(v, "base64").toString("base64") === v)
    .refine(v => decodedBase64Bytes(v) <= CAPTURE_DEFAULTS.maxBytes),
});

export const askRequestSchema = z.object({
  problemSlug: z.string().trim().min(1),
  cacheKey: sha1Hex,
  scriptVersion: sha1Hex,
  stepId: z.string().min(1), // id 不 trim，不改变现有 id 的含义
  question: z.string().trim().min(1).max(ASK_LIMITS.questionMax),
  selection: askSelectionSchema,
  image: askImageSchema.nullable().optional(),
  byok: lectureRequestSchema.shape.byok,
}).superRefine((v, ctx) => {
  if (v.stepId !== v.selection.stepId)
    ctx.addIssue({ code: "custom", path: ["selection", "stepId"], message: "stepId mismatch" });
  if (v.question !== v.selection.question) // 两边已经 trim
    ctx.addIssue({ code: "custom", path: ["selection", "question"], message: "question mismatch" });
  if (v.selection.targets.length === 0)
    ctx.addIssue({ code: "custom", path: ["selection", "targets"], message: "selection required" });
  v.selection.targets.forEach((t, i) => {
    if (t.stepId !== undefined && t.stepId !== v.stepId)
      ctx.addIssue({ code: "custom", path: ["selection", "targets", i, "stepId"], message: "target stepId mismatch" });
  });
  if (!selectionSummaryWithinLimit(v.selection))
    ctx.addIssue({ code: "custom", path: ["selection"], message: "selection summary too large" });
});
export type AskRequest = z.infer<typeof askRequestSchema>;

/** 规范化选区摘要的 JSON UTF-8 字节是否不超过 16 KiB。 */
export function selectionSummaryWithinLimit(selection: AskSelection): boolean {
  const summary = summarizeSelection(selection);
  return Buffer.byteLength(JSON.stringify(summary), "utf8") <= ASK_SELECTION_SUMMARY_MAX_BYTES;
}

export function badRequest(error?: z.ZodError, message = "请求参数不正确，请检查题目、语言、模型配置或提示级别。") {
  if (error?.issues.some(issue => issue.path.at(-1) === "baseURL")) return baseURLInvalid();
  return Response.json(
    { error: "BAD_REQUEST", message },
    { status: 400 },
  );
}

export function baseURLNotAllowed() {
  return Response.json({ code: "BASE_URL_NOT_ALLOWED", error: "BASE_URL_NOT_ALLOWED", message: INVALID_AI_BASE_URL }, { status: 400 });
}

export function baseURLInvalid() {
  return Response.json({ code: "BASE_URL_INVALID", error: "BASE_URL_INVALID", message: MALFORMED_AI_BASE_URL }, { status: 400 });
}

export function byokKeyRequired() {
  return Response.json({ code: "BYOK_KEY_REQUIRED", error: "BYOK_KEY_REQUIRED", message: "用自定义接口地址时，需要同时填你自己的 API Key" }, { status: 400 });
}

export function settingsLocked() {
  return Response.json({ code: "SETTINGS_LOCKED", error: "SETTINGS_LOCKED", message: "公共实例不支持修改服务器设置" }, { status: 403 });
}

export function upstreamAuthError() {
  return Response.json({ code: "UPSTREAM_AUTH", error: "UPSTREAM_AUTH", retryable: false, message: "API Key 无效或没有权限" }, { status: 400 });
}

export function upstreamError(status?: number) {
  if (status === 401 || status === 403) return upstreamAuthError();
  return Response.json(
    { code: "UPSTREAM_ERROR", error: "UPSTREAM_ERROR", retryable: true, message: AI_CONNECTION_ERROR },
    { status: 502 },
  );
}

export function configurationError() {
  return Response.json({ error: "CONFIGURATION_ERROR", message: "API Key 与接口地址配置不一致，请检查设置。环境变量里的 API Key 必须同时配置 AI_BASE_URL；保存 API Key 时请同时保存对应接口地址和服务商。" }, { status: 400 });
}

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

const ASK_ERROR_MESSAGES = {
  BAD_JSON: "请求内容无效，请重新发送。",
  BAD_REQUEST: "提问参数不正确，请检查问题和选区。",
  PAYLOAD_TOO_LARGE: "请求过大，请移除截图后重新提问。",
  CANCELLED: "已取消。",
} as const;

export type AskErrorCode = keyof typeof ASK_ERROR_MESSAGES;

/** 提问接口固定错误体：code、error、retryable、message 四字段。 */
export function askError(code: AskErrorCode, status: number, message?: string, headers?: HeadersInit) {
  return Response.json(
    { code, error: code, retryable: streamErrorRetryable[code], message: message ?? ASK_ERROR_MESSAGES[code] },
    { status, headers },
  );
}

export type AskBodyResult =
  | { ok: true; text: string }
  | { ok: false; response: Response };

function invalidContentLength(raw: string): boolean {
  return !/^(?:0|[1-9]\d*)$/.test(raw);
}

/**
 * 读提问请求体：先按 content-length 拒绝，再按真实 UTF-8 字节计数。
 * 取消中途返回 CANCELLED，不把中断误报成 BAD_JSON。
 */
export async function readAskBody(req: Request, signal?: AbortSignal): Promise<AskBodyResult> {
  const abortSignal = signal ?? req.signal;
  if (abortSignal.aborted) return { ok: false, response: askError("CANCELLED", 499) };

  const declared = req.headers.get("content-length");
  if (declared !== null) {
    const raw = declared.trim();
    if (invalidContentLength(raw)) return { ok: false, response: askError("BAD_REQUEST", 400) };
    if (BigInt(raw) > BigInt(ASK_BODY_MAX_BYTES)) {
      await req.body?.cancel();
      return { ok: false, response: askError("PAYLOAD_TOO_LARGE", 413) };
    }
  }

  if (!req.body) return { ok: false, response: askError("BAD_JSON", 400) };

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let cancelSettled: Promise<void> | undefined;
  const cancelReader = () => {
    cancelSettled ??= reader.cancel().then(() => undefined, () => undefined);
    return cancelSettled;
  };
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<void>(resolve => {
    onAbort = () => resolve();
    if (abortSignal.aborted) resolve();
    else abortSignal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    for (;;) {
      const read = reader.read().then(
        value => ({ kind: "chunk" as const, value }),
        (error: unknown) => ({ kind: "error" as const, error }),
      );
      const winner = await Promise.race([
        read,
        aborted.then(() => ({ kind: "abort" as const })),
      ]);
      if (winner.kind === "abort") {
        await cancelReader();
        return { ok: false, response: askError("CANCELLED", 499) };
      }
      if (winner.kind === "error") {
        await cancelReader();
        const error = winner.error;
        if (abortSignal.aborted || (error instanceof Error && error.name === "AbortError")) {
          return { ok: false, response: askError("CANCELLED", 499) };
        }
        return { ok: false, response: askError("BAD_JSON", 400) };
      }
      const { done, value } = winner.value;
      if (done) break;
      const size = value.byteLength;
      if (total + size > ASK_BODY_MAX_BYTES) {
        chunks.length = 0;
        await cancelReader();
        return { ok: false, response: askError("PAYLOAD_TOO_LARGE", 413) };
      }
      total += size;
      chunks.push(value);
    }
  } finally {
    if (onAbort) abortSignal.removeEventListener("abort", onAbort);
  }

  if (total === 0) return { ok: false, response: askError("BAD_JSON", 400) };

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(concatChunks(chunks, total));
  } catch {
    return { ok: false, response: askError("BAD_JSON", 400) };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, response: askError("BAD_JSON", 400) };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, response: askError("BAD_JSON", 400) };
  }
  return { ok: true, text };
}

function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** NDJSON 错误只允许固定错误码和重试标志，绝不携带原始异常或额外字段。 */
export function streamErrorEvent(value: unknown) {
  const code = typeof value === "string" && Object.hasOwn(streamErrorRetryable, value)
    ? value as keyof typeof streamErrorRetryable
    : "UPSTREAM_ERROR";
  return { type: "error" as const, code, retryable: streamErrorRetryable[code] };
}
