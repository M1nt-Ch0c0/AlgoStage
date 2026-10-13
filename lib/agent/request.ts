/** AI 路由先校验参数类型，错误响应不携带输入值或 Key。 */
import { z } from "zod";
import { AI_CONNECTION_ERROR, INVALID_AI_BASE_URL, normalizeAIBaseURL } from "@/lib/ai/egress-guard";

export const aiBaseURLSchema = z.string().transform((value, ctx) => {
  try { return normalizeAIBaseURL(value); }
  catch {
    ctx.addIssue({ code: "custom", message: INVALID_AI_BASE_URL });
    return z.NEVER;
  }
});

export const byokRequestSchema = z.object({
  provider: z.enum(["openai-compatible", "anthropic", "google"]).default("openai-compatible"),
  model: z.string().trim().default(""),
  apiKey: z.string().trim().default(""),
  baseURL: aiBaseURLSchema.transform(value => value || undefined).optional(),
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
  if (error?.issues.some(issue => issue.path.at(-1) === "baseURL" && issue.code === "custom")) return upstreamError();
  return Response.json(
    { error: "BAD_REQUEST", message },
    { status: 400 },
  );
}

export function baseURLNotAllowed() {
  return Response.json({ error: "BASE_URL_NOT_ALLOWED", message: INVALID_AI_BASE_URL }, { status: 400 });
}

export function upstreamError(status?: number) {
  return Response.json(
    { error: "UPSTREAM_ERROR", message: status === 401 || status === 403 ? "Key 无效或没有权限，请检查设置。" : AI_CONNECTION_ERROR },
    { status: 502 },
  );
}

export function configurationError() {
  return Response.json({ error: "CONFIGURATION_ERROR", message: "Key 与接口地址配置不一致，请检查设置。环境变量 Key 必须同时配置 AI_BASE_URL；保存 Key 时请同时保存对应接口地址和服务商。" }, { status: 400 });
}
