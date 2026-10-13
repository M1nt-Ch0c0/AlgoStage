import { generateText } from "ai";
import { AIBaseURLNotAllowedError, InvalidAIBaseURLError, ServerAIBaseURLError, validateAIBaseURL } from "@/lib/ai/egress-guard";
import { createModel, ByokConfigurationError, ByokKeyRequiredError, type ByokConfig } from "./provider";
import { baseURLInvalid, baseURLNotAllowed, byokKeyRequired, configurationError, upstreamError } from "./request";
import { upstreamStatusCode } from "./upstream-retry";

/** SDK wrappers can retain a cause; never expose that cause to the client. */
export function settingsConnectionError(error: unknown): Response {
  const seen = new Set<unknown>();
  let current = error;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    if (current instanceof ServerAIBaseURLError) return upstreamError();
    if (current instanceof InvalidAIBaseURLError) return baseURLInvalid();
    if (current instanceof AIBaseURLNotAllowedError) return baseURLNotAllowed();
    if (current instanceof ByokKeyRequiredError) return byokKeyRequired();
    if (current instanceof ByokConfigurationError) return configurationError();
    current = current.cause;
  }
  return upstreamError(upstreamStatusCode(error));
}

/** Syntax/literal/DNS checks only; actual connections are checked and pinned again. */
export async function validateBaseURL(baseURL: string, signal: AbortSignal): Promise<Response | null> {
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
