/** AI 路由先校验参数类型，错误响应不携带输入值或 Key。 */
import { z } from "zod";
import { AI_CONNECTION_ERROR, INVALID_AI_BASE_URL, MALFORMED_AI_BASE_URL, normalizeAIBaseURL } from "@/lib/ai/egress-guard";

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
  return Response.json({ error: "CONFIGURATION_ERROR", message: "Key 与接口地址配置不一致，请检查设置。环境变量 Key 必须同时配置 AI_BASE_URL；保存 Key 时请同时保存对应接口地址和服务商。" }, { status: 400 });
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
} as const;

/** NDJSON 错误只允许固定错误码和重试标志，绝不携带原始异常或额外字段。 */
export function streamErrorEvent(value: unknown) {
  const code = typeof value === "string" && Object.hasOwn(streamErrorRetryable, value)
    ? value as keyof typeof streamErrorRetryable
    : "UPSTREAM_ERROR";
  return { type: "error" as const, code, retryable: streamErrorRetryable[code] };
}
