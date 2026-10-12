/** 设置中的地址必须属于当前服务商；旧兼容接口地址不能继承给原生 SDK。 */
export function savedEndpoint(settings: Record<string, string>): string | undefined {
  const provider = settings.provider?.trim() || "openai-compatible";
  const boundProvider = settings.baseURLProvider?.trim();
  if (boundProvider ? boundProvider !== provider : provider !== "openai-compatible") return undefined;
  return settings.baseURL?.trim() || undefined;
}
