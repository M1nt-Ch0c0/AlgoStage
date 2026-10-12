/**
 * BYOK 模型 Provider 注册（docs/01 §2-②）
 * 用户只需提供 API Key + model name（+ 可选 baseURL），
 * 配置存本地 Setting 表 / 环境变量，请求从本机直连厂商。
 */
import { DEFAULT_MODEL } from "./defaults";
import { byokRequestSchema } from "./request";
import { prisma } from "@/lib/db/prisma";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";

export interface ByokConfig {
  provider: "openai-compatible" | "anthropic" | "google";
  model: string;
  apiKey: string;
  /** openai-compatible 需要，如 https://api.deepseek.com/v1 */
  baseURL?: string;
}

export const PROVIDER_PRESETS: {
  id: ByokConfig["provider"];
  label: string;
  baseURL?: string;
  modelExample: string;
}[] = [
  {
    id: "openai-compatible",
    label: "OpenAI 兼容（DeepSeek / 通义 / Moonshot / OpenAI…）",
    baseURL: "https://api.openai.com/v1",
    modelExample: DEFAULT_MODEL,
  },
  { id: "anthropic", label: "Anthropic Claude", modelExample: "claude-sonnet-4-5" },
  { id: "google", label: "Google Gemini", modelExample: "gemini-2.5-flash" },
];

/** 只使用类型正确且 Key、模型名都完整的配置；所有来源共用这一规则。 */
function completeByok(value: unknown): ByokConfig | null {
  const parsed = byokRequestSchema.safeParse(value);
  return parsed.success && parsed.data.apiKey && parsed.data.model ? parsed.data : null;
}

/** 从环境变量读取（.env.local），作为设置页未配置时的兜底。 */
export function byokFromEnv(): ByokConfig | null {
  return completeByok({
    provider: process.env.AI_PROVIDER || "openai-compatible",
    model: process.env.AI_MODEL || DEFAULT_MODEL,
    apiKey: process.env.AI_API_KEY,
    baseURL: process.env.AI_BASE_URL || undefined,
  });
}

/** Key 来源只由实际使用的密钥决定，不受模型或接口地址来源影响。 */
export function savedKeySource(settings: Record<string, string>): "settings" | "env" | "none" {
  if (settings.apiKey?.trim()) return "settings";
  return process.env.AI_API_KEY?.trim() ? "env" : "none";
}

/** 按字段合并：设置页非空值优先，空白字段才回退到环境变量或默认值。 */
export function resolveSavedByok(settings: Record<string, string>): {
  config: ByokConfig;
  source: "settings" | "env";
} | null {
  const source = savedKeySource(settings);
  const config = completeByok({
    provider: settings.provider?.trim() || process.env.AI_PROVIDER?.trim() || "openai-compatible",
    apiKey: settings.apiKey?.trim() || process.env.AI_API_KEY?.trim(),
    model: settings.model?.trim() || process.env.AI_MODEL?.trim() || DEFAULT_MODEL,
    baseURL: settings.baseURL?.trim() || process.env.AI_BASE_URL?.trim() || undefined,
  });
  return config && source !== "none" ? { config, source } : null;
}

/** 请求中的完整配置优先，其次使用本机保存的配置，最后回退到环境变量。 */
export async function resolveByok(bodyByok?: ByokConfig | null): Promise<{
  config: ByokConfig;
  source: "request" | "settings" | "env";
} | null> {
  const config = completeByok(bodyByok);
  if (config) return { config, source: "request" };
  const rows = await prisma.setting.findMany({ where: { userId: "local-default" } });
  return resolveSavedByok(Object.fromEntries(rows.map((row) => [row.key, row.value])));
}

/** 由 BYOK 配置构造 AI SDK LanguageModel */
export function createModel(config: ByokConfig) {
  switch (config.provider) {
    case "anthropic":
      return createAnthropic({ apiKey: config.apiKey })(config.model);
    case "google":
      return createGoogleGenerativeAI({ apiKey: config.apiKey })(config.model);
    case "openai-compatible":
    default: {
      const preset = PROVIDER_PRESETS.find(
        (p) => p.id === "openai-compatible",
      )!;
      return createOpenAICompatible({
        name: "byok",
        supportsStructuredOutputs: true,
        apiKey: config.apiKey,
        baseURL: config.baseURL ?? preset.baseURL!,
      })(config.model);
    }
  }
}
