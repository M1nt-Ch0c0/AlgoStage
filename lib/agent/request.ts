/** AI 路由先校验参数类型，错误响应不携带输入值或 Key。 */
import { z } from "zod";

export const byokRequestSchema = z.object({
  provider: z.enum(["openai-compatible", "anthropic", "google"]).default("openai-compatible"),
  model: z.string().trim().default(""),
  apiKey: z.string().trim().default(""),
  baseURL: z.url().optional(),
});

const common = {
  slug: z.string().trim().min(1),
  byok: byokRequestSchema.nullable().optional(),
};

export const lectureRequestSchema = z.object({
  ...common,
  language: z.enum(["zh", "en"]).default("zh"),
  solutionLanguage: z.enum(["typescript", "python"]).default("typescript"),
});

export const hintRequestSchema = z.object({
  ...common,
  level: z.number().int().min(1).max(5),
  userCode: z.string().optional(),
});

export function badRequest() {
  return Response.json(
    { error: "BAD_REQUEST", message: "请求参数不正确，请检查题目、语言、模型配置或提示级别。" },
    { status: 400 },
  );
}

export function upstreamError() {
  return Response.json(
    { error: "UPSTREAM_ERROR", message: "暂时连不上模型，请检查设置中的接口地址、Key 和模型名后重试。" },
    { status: 502 },
  );
}

export function configurationError() {
  return Response.json({ error: "CONFIGURATION_ERROR", message: "Key 与接口地址配置不一致，请检查设置。环境变量 Key 必须同时配置 AI_BASE_URL；保存 Key 时请同时保存对应接口地址和服务商。" }, { status: 400 });
}
