/**
 * BYOK 模型 Provider 注册（docs/01 §2-②）
 * 用户只需提供 API Key + model name（+ 可选 baseURL），
 * 配置存本地 Setting 表 / 环境变量，请求从本机直连厂商。
 */
import { DEFAULT_MODEL } from "./defaults";
import { savedEndpoint } from "./saved-endpoint";
import { byokRequestSchema } from "./request";
import { aiEgressFetch, InvalidAIBaseURLError, normalizeAIBaseURL, ServerAIBaseURLError } from "@/lib/ai/egress-guard";
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

export function serverKeyDisabled(): boolean {
  return ["true", "1", "on", "yes"].includes(process.env.ALGOSTAGE_DISABLE_SERVER_KEY?.trim().toLowerCase() ?? "");
}

export class ByokKeyRequiredError extends Error {
  constructor() { super("用自定义接口地址时，需要同时填你自己的 API Key"); }
}

export class ByokConfigurationError extends Error {
  constructor() { super("Key 与接口地址必须来自同一配置来源，请同时配置 Key、接口地址和服务商，或清空设置页 Key 后使用环境变量。"); }
}
type Origin = "settings" | "env";
type CredentialOrigin = {
  key: Origin; baseURL: Origin; provider: Origin;
  destination: string; providerId: ByokConfig["provider"];
};
const origins = new WeakMap<ByokConfig, CredentialOrigin>();
/** Configs whose baseURL came from saved settings (user-fixable), not from env. */
const savedURLConfigs = new WeakSet<ByokConfig>();

/** The saved-settings baseURL this config will call, if any; env-sourced URLs return undefined. */
export function savedBaseURLOf(config: ByokConfig): string | undefined {
  return savedURLConfigs.has(config) ? config.baseURL : undefined;
}

/** 发送前硬校验；即使调用者复制配置或修改 URL，也不能把环境 Key 送往其他接口。 */
export function assertCredentialDestination(config: ByokConfig) {
  const origin = origins.get(config);
  if (origin && (origin.key !== origin.baseURL || origin.key !== origin.provider)) throw new ByokConfigurationError();
  if (origin && (effectiveBaseURL(config) !== origin.destination || config.provider !== origin.providerId)) throw new ByokConfigurationError();
  const envKey = process.env.AI_API_KEY?.trim();
  if (origin?.key === "env" || (envKey && config.apiKey === envKey)) {
    const endpoint = normalizeAIBaseURL(process.env.AI_BASE_URL ?? "");
    const provider = process.env.AI_PROVIDER?.trim() || "openai-compatible";
    if (!endpoint || normalizeAIBaseURL(config.baseURL ?? "") !== endpoint || config.provider !== provider) throw new ByokConfigurationError();
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
  if (!parsed.success || !parsed.data.apiKey || !parsed.data.model) return null;
  return { ...parsed.data, provider: parsed.data.provider ?? "openai-compatible", apiKey: parsed.data.apiKey, model: parsed.data.model, baseURL: parsed.data.baseURL || undefined };
}

/** Include SDK defaults when comparing destinations; compare the full normalized path. */
function effectiveBaseURL(config: Pick<ByokConfig, "provider" | "baseURL">): string {
  const defaults = {
    "openai-compatible": "https://api.openai.com/v1",
    anthropic: "https://api.anthropic.com/v1",
    google: "https://generativelanguage.googleapis.com/v1beta",
  };
  return normalizeAIBaseURL(config.baseURL || defaults[config.provider]);
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

/** Read non-secret defaults even when use of the server credential is disabled. */
function savedByokDefaults(settings: Record<string, string>) {
  const useSaved = savedKeySource(settings) === "settings";
  const provider = (useSaved ? settings.provider?.trim() : "") || process.env.AI_PROVIDER?.trim() || "openai-compatible";
  const savedURL = savedEndpoint(settings);
  // Explicitly saved empty URLs use the SDK default; missing legacy fields must
  // still pass the existing credential-origin checks before using a server key.
  const savedDefault = useSaved && !savedURL && (provider !== "openai-compatible" || settings.baseURLProvider === provider);
  const baseURL = savedDefault ? undefined : (useSaved ? savedURL : undefined) || process.env.AI_BASE_URL?.trim() || undefined;
  return { useSaved, provider, savedURL, savedDefault, baseURL, model: settings.model?.trim() || process.env.AI_MODEL?.trim() || DEFAULT_MODEL };
}

/** 环境 Key 与环境接口成组使用，设置页只可覆盖模型；保存 Key 时拒绝混用其他来源。 */
export function resolveSavedByok(settings: Record<string, string>): {
  config: ByokConfig;
  source: "settings" | "env";
} | null {
  if (serverKeyDisabled()) return null;
  const source = savedKeySource(settings);
  const { useSaved, provider, savedURL, savedDefault, baseURL, model } = savedByokDefaults(settings);
  // 旧设置或环境变量中的坏地址也要明确报错，不能伪装成未配置 AI。
  if (baseURL) normalizeAIBaseURL(baseURL);
  const config = completeByok({
    provider,
    apiKey: settings.apiKey?.trim() || process.env.AI_API_KEY?.trim(),
    model,
    baseURL,
  });
  if (!config || source === "none") return null;
  origins.set(config, {
    key: source,
    baseURL: useSaved && (savedDefault || savedURL || !process.env.AI_BASE_URL?.trim()) ? "settings" : "env",
    provider: useSaved && (settings.provider?.trim() || !process.env.AI_PROVIDER?.trim()) ? "settings" : "env",
    destination: effectiveBaseURL(config),
    providerId: config.provider,
  });
  if (useSaved && savedURL && config.baseURL) savedURLConfigs.add(config);
  assertCredentialDestination(config);
  return { config, source };
}

/** Request credentials stay in memory. Never borrow a server key for an edited destination. */
function envBaseURLMalformed(): boolean {
  const value = process.env.AI_BASE_URL?.trim();
  if (!value) return false;
  try { normalizeAIBaseURL(value); return false; } catch { return true; }
}

/** 区分地址来源：请求体或设置里的坏地址（用户可修）保留 InvalidAIBaseURLError；环境变量里的坏地址转成 ServerAIBaseURLError。 */
export async function resolveByok(bodyByok?: Partial<ByokConfig> | null): Promise<{
  config: ByokConfig;
  source: "request" | "settings" | "env";
} | null> {
  try {
    return await resolveByokInner(bodyByok);
  } catch (error) {
    if (error instanceof InvalidAIBaseURLError && envBaseURLMalformed()) {
      const rows = await prisma.setting.findMany({ where: { userId: "local-default" } });
      const settings = Object.fromEntries(rows.map((row) => [row.key, row.value]));
      const { useSaved, savedURL } = savedByokDefaults(settings);
      if (!(useSaved && savedURL)) throw new ServerAIBaseURLError();
    }
    throw error;
  }
}

async function resolveByokInner(bodyByok?: Partial<ByokConfig> | null): Promise<{
  config: ByokConfig;
  source: "request" | "settings" | "env";
} | null> {
  const parsed = byokRequestSchema.safeParse(bodyByok ?? {});
  if (!parsed.success) throw new ByokConfigurationError();
  const request = parsed.data;
  const rows = await prisma.setting.findMany({ where: { userId: "local-default" } });
  const settings = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  const defaults = savedByokDefaults(settings);
  const provider = byokRequestSchema.shape.provider.safeParse(defaults.provider);
  const server: Pick<ByokConfig, "provider" | "baseURL"> = {
    provider: provider.success && provider.data ? provider.data : "openai-compatible",
    baseURL: defaults.baseURL,
  };
  if (request.apiKey) {
    const config = completeByok({
      ...request,
      provider: request.provider ?? server.provider,
      model: request.model || defaults.model,
      // An explicit provider with no URL uses that SDK's default, as before.
      baseURL: request.baseURL ?? (request.provider ? undefined : server.baseURL),
    });
    if (!config) throw new ByokConfigurationError();
    if (request.baseURL === undefined && !request.provider && defaults.useSaved && defaults.savedURL && config.baseURL) savedURLConfigs.add(config);
    if (config.apiKey === settings.apiKey?.trim() && (effectiveBaseURL(config) !== effectiveBaseURL(server) || config.provider !== server.provider)) throw new ByokConfigurationError();
    assertCredentialDestination(config);
    return { config, source: "request" };
  }
  if (
    (request.baseURL !== undefined && effectiveBaseURL({ provider: request.provider ?? server.provider, baseURL: request.baseURL }) !== effectiveBaseURL(server)) ||
    (request.provider !== undefined && request.provider !== server.provider)
  ) throw new ByokKeyRequiredError();
  if (serverKeyDisabled()) return null;
  const resolved = resolveSavedByok(settings);
  if (resolved && request.model) resolved.config.model = request.model;
  return resolved;
}

/** 由 BYOK 配置构造 AI SDK LanguageModel */
export function createModel(config: ByokConfig) {
  assertCredentialDestination(config);
  const baseURL = normalizeAIBaseURL(config.baseURL ?? "") || undefined;
  const guardedFetch: typeof fetch = (input, init) => {
    assertCredentialDestination(config);
    const origin = origins.get(config);
    if (origin || config.apiKey === process.env.AI_API_KEY?.trim()) {
      const base = new URL(origin?.destination ?? normalizeAIBaseURL(process.env.AI_BASE_URL!));
      const target = new URL(input instanceof Request ? input.url : String(input));
      const prefix = base.pathname.replace(/\/$/, "");
      if (target.origin !== base.origin || !(target.pathname === prefix || target.pathname.startsWith(`${prefix}/`))) throw new ByokConfigurationError();
    }
    return aiEgressFetch(input, init);
  };
  switch (config.provider) {
    case "anthropic":
      return createAnthropic({ apiKey: config.apiKey, baseURL, fetch: guardedFetch })(config.model);
    case "google":
      return createGoogleGenerativeAI({ apiKey: config.apiKey, baseURL, fetch: guardedFetch })(config.model);
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
        baseURL: baseURL ?? preset.baseURL!,
      })(config.model);
    }
  }
}
