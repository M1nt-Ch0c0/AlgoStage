/**
 * BYOK 模型 Provider 注册（docs/01 §2-②）
 * 用户只需提供 API Key + model name（+ 可选 baseURL），
 * 配置存本地 Setting 表 / 环境变量，请求从本机直连厂商。
 */
import { DEFAULT_MODEL } from "./defaults";
import { savedEndpoint } from "./saved-endpoint";
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

export class ByokConfigurationError extends Error {
  constructor() { super("Key 与接口地址必须来自同一配置来源，请同时配置 Key、接口地址和服务商，或清空设置页 Key 后使用环境变量。"); }
}
type Origin = "settings" | "env";
type CredentialOrigin = { key: Origin; baseURL: Origin; provider: Origin };
const origins = new WeakMap<ByokConfig, CredentialOrigin>();

/** 发送前硬校验；即使调用者复制配置或修改 URL，也不能把环境 Key 送往其他接口。 */
export function assertCredentialDestination(config: ByokConfig) {
  const origin = origins.get(config);
  if (origin && (origin.key !== origin.baseURL || origin.key !== origin.provider)) throw new ByokConfigurationError();
  const envKey = process.env.AI_API_KEY?.trim();
  if (origin?.key === "env" || (envKey && config.apiKey === envKey)) {
    const endpoint = process.env.AI_BASE_URL?.trim();
    const provider = process.env.AI_PROVIDER?.trim() || "openai-compatible";
    if (!endpoint || config.baseURL !== endpoint || config.provider !== provider) throw new ByokConfigurationError();
  }
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

/** 环境 Key 与环境接口成组使用，设置页只可覆盖模型；保存 Key 时拒绝混用其他来源。 */
export function resolveSavedByok(settings: Record<string, string>): {
  config: ByokConfig;
  source: "settings" | "env";
} | null {
  const source = savedKeySource(settings);
  const useSaved = source === "settings";
  const provider = (useSaved ? settings.provider?.trim() : "") || process.env.AI_PROVIDER?.trim() || "openai-compatible";
  const savedURL = savedEndpoint(settings);
  // 原生厂商没有专属地址时使用其官方默认地址，绝不接上旧代理或环境地址。
  const nativeDefault = useSaved && provider !== "openai-compatible" && !savedURL;
  const config = completeByok({
    provider,
    apiKey: settings.apiKey?.trim() || process.env.AI_API_KEY?.trim(),
    model: settings.model?.trim() || process.env.AI_MODEL?.trim() || DEFAULT_MODEL,
    baseURL: nativeDefault ? undefined : (useSaved ? savedURL : undefined) || process.env.AI_BASE_URL?.trim() || undefined,
  });
  if (!config || source === "none") return null;
  origins.set(config, {
    key: source,
    baseURL: useSaved && (nativeDefault || savedURL || !process.env.AI_BASE_URL?.trim()) ? "settings" : "env",
    provider: useSaved && (settings.provider?.trim() || !process.env.AI_PROVIDER?.trim()) ? "settings" : "env",
  });
  assertCredentialDestination(config);
  return { config, source };
}

/** 请求中的完整配置优先，其次使用本机保存的配置，最后回退到环境变量。 */
export async function resolveByok(bodyByok?: ByokConfig | null): Promise<{
  config: ByokConfig;
  source: "request" | "settings" | "env";
} | null> {
  const config = completeByok(bodyByok);
  if (config) { assertCredentialDestination(config); return { config, source: "request" }; }
  const rows = await prisma.setting.findMany({ where: { userId: "local-default" } });
  return resolveSavedByok(Object.fromEntries(rows.map((row) => [row.key, row.value])));
}

/** 由 BYOK 配置构造 AI SDK LanguageModel */
export function createModel(config: ByokConfig) {
  assertCredentialDestination(config);
  const guardedFetch: typeof fetch = (input, init) => {
    assertCredentialDestination(config);
    if (origins.get(config)?.key === "env" || config.apiKey === process.env.AI_API_KEY?.trim()) {
      const base = new URL(process.env.AI_BASE_URL!.trim());
      const target = new URL(input instanceof Request ? input.url : String(input));
      const prefix = base.pathname.replace(/\/$/, "");
      if (target.origin !== base.origin || !(target.pathname === prefix || target.pathname.startsWith(`${prefix}/`))) throw new ByokConfigurationError();
    }
    // 禁止上游重定向携带凭据到另一地址；错误仍走固定错误码，不输出请求信息。
    return globalThis.fetch(input, { ...init, redirect: "error" });
  };
  switch (config.provider) {
    case "anthropic":
      return createAnthropic({ apiKey: config.apiKey, baseURL: config.baseURL, fetch: guardedFetch })(config.model);
    case "google":
      return createGoogleGenerativeAI({ apiKey: config.apiKey, baseURL: config.baseURL, fetch: guardedFetch })(config.model);
    case "openai-compatible":
    default: {
      const preset = PROVIDER_PRESETS.find(
        (p) => p.id === "openai-compatible",
      )!;
      return createOpenAICompatible({
        name: "byok",
        supportsStructuredOutputs: true,
        apiKey: config.apiKey,
        fetch: guardedFetch,
        baseURL: config.baseURL ?? preset.baseURL!,
      })(config.model);
    }
  }
}
