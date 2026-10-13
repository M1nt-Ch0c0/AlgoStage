import { APICallError, generateText } from "ai";
import { AIBaseURLNotAllowedError, InvalidAIBaseURLError, validateAIBaseURL } from "@/lib/ai/egress-guard";
import { createModel, ByokConfigurationError, type ByokConfig } from "./provider";
import { baseURLNotAllowed, configurationError, upstreamError } from "./request";

/** SDK wrappers can retain a cause; never expose that cause to the client. */
export function settingsConnectionError(error: unknown): Response {
  const seen = new Set<unknown>();
  let current = error;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    if (current instanceof AIBaseURLNotAllowedError || current instanceof InvalidAIBaseURLError) return baseURLNotAllowed();
    if (current instanceof ByokConfigurationError) return configurationError();
    current = current.cause;
  }
  return upstreamError(APICallError.isInstance(error) ? error.statusCode : undefined);
}

export async function validateSettingsBaseURL(baseURL: string, signal: AbortSignal): Promise<Response | null> {
  try {
    await validateAIBaseURL(baseURL, signal);
    return null;
  } catch (error) {
    return settingsConnectionError(error);
  }
}

/** A small probe uses the same SDK, credential checks and pinned fetch as runtime. */
export async function checkAIConnection(config: ByokConfig, signal: AbortSignal): Promise<Response | null> {
  try {
    await generateText({
      model: createModel(config),
      prompt: "Reply OK.",
      maxOutputTokens: 8,
      maxRetries: 0,
      abortSignal: signal,
    });
    return null;
  } catch (error) {
    return settingsConnectionError(error);
  }
}
