/**
 * Ask-path error whitelist. Messages come from §5.2 plus Paige overrides
 * (NO_BYOK / ASK_BUSY / RATE_LIMITED). Raw server or browser text is never shown.
 */
import {
  BASE_URL_INVALID_LECTURE_MESSAGE,
  BASE_URL_NOT_ALLOWED_LECTURE_MESSAGE,
  BYOK_KEY_REQUIRED_MESSAGE,
  ByokError,
  SETTINGS_LOCKED_MESSAGE,
  UPSTREAM_AUTH_LECTURE_MESSAGE,
  UPSTREAM_ERROR_MESSAGE,
} from "@/lib/byok/client";
import { ASK_BUSY_MESSAGE } from "@/lib/ask/ask-response";

export type AskErrorAction = "settings" | "retry" | "refresh" | "edit" | "home" | "none";

export interface AskErrorView {
  code: string;
  message: string;
  retryable: boolean;
  action: AskErrorAction;
}

export const ASK_NO_BYOK_MESSAGE = "老师还没接上 AI，先去设置里填自己的 Key。";
export const ASK_RATE_LIMITED_MESSAGE = "问得有点快，请稍后再问。";
export const ASK_TIMEOUT_MESSAGE = "老师回答超时，请重新问一次。";
export const ASK_INVALID_ANSWER_MESSAGE = "这次回答没能完整生成，请重新问一次。";
export const ASK_EMPTY_BODY_MESSAGE = "回答中断，未收到完整回答，请重新问一次。";
export const ASK_STEP_NOT_FOUND_MESSAGE = "这一步的教案已更新，请刷新后再提问。";
export const ASK_BAD_REQUEST_MESSAGE = "提问内容有误，请检查选区和问题后再问。";
export const ASK_NOT_FOUND_MESSAGE = "没找到这节课，请重新打开题目。";
export const ASK_CANCELLED_MESSAGE = "这次提问已取消，可以重新编辑后提问。";
export const ASK_CONFIGURATION_ERROR_MESSAGE = "API Key 与接口地址配置不一致，请检查设置。";

interface AskErrorSpec {
  code: string;
  message: string;
  retryable: boolean;
  action: AskErrorAction;
}

/** Fixed UI copy. Config codes ignore any incoming retryable flag. */
export const ASK_ERROR_SPECS: Record<string, AskErrorSpec> = {
  NO_BYOK: { code: "NO_BYOK", message: ASK_NO_BYOK_MESSAGE, retryable: false, action: "settings" },
  BASE_URL_INVALID: { code: "BASE_URL_INVALID", message: BASE_URL_INVALID_LECTURE_MESSAGE, retryable: false, action: "settings" },
  BASE_URL_NOT_ALLOWED: { code: "BASE_URL_NOT_ALLOWED", message: BASE_URL_NOT_ALLOWED_LECTURE_MESSAGE, retryable: false, action: "settings" },
  BYOK_KEY_REQUIRED: { code: "BYOK_KEY_REQUIRED", message: BYOK_KEY_REQUIRED_MESSAGE, retryable: false, action: "settings" },
  SETTINGS_LOCKED: { code: "SETTINGS_LOCKED", message: SETTINGS_LOCKED_MESSAGE, retryable: false, action: "settings" },
  UPSTREAM_AUTH: { code: "UPSTREAM_AUTH", message: UPSTREAM_AUTH_LECTURE_MESSAGE, retryable: false, action: "settings" },
  CONFIGURATION_ERROR: { code: "CONFIGURATION_ERROR", message: ASK_CONFIGURATION_ERROR_MESSAGE, retryable: false, action: "settings" },
  TIMEOUT: { code: "TIMEOUT", message: ASK_TIMEOUT_MESSAGE, retryable: true, action: "retry" },
  UPSTREAM_ERROR: { code: "UPSTREAM_ERROR", message: UPSTREAM_ERROR_MESSAGE, retryable: true, action: "retry" },
  INVALID_ANSWER: { code: "INVALID_ANSWER", message: ASK_INVALID_ANSWER_MESSAGE, retryable: true, action: "retry" },
  EMPTY_BODY: { code: "EMPTY_BODY", message: ASK_EMPTY_BODY_MESSAGE, retryable: true, action: "retry" },
  INCOMPLETE_STREAM: { code: "INCOMPLETE_STREAM", message: ASK_EMPTY_BODY_MESSAGE, retryable: true, action: "retry" },
  STEP_NOT_FOUND: { code: "STEP_NOT_FOUND", message: ASK_STEP_NOT_FOUND_MESSAGE, retryable: false, action: "refresh" },
  BAD_REQUEST: { code: "BAD_REQUEST", message: ASK_BAD_REQUEST_MESSAGE, retryable: false, action: "edit" },
  BAD_JSON: { code: "BAD_JSON", message: ASK_BAD_REQUEST_MESSAGE, retryable: false, action: "edit" },
  NOT_FOUND: { code: "NOT_FOUND", message: ASK_NOT_FOUND_MESSAGE, retryable: false, action: "home" },
  CANCELLED: { code: "CANCELLED", message: ASK_CANCELLED_MESSAGE, retryable: false, action: "edit" },
  ASK_BUSY: { code: "ASK_BUSY", message: ASK_BUSY_MESSAGE, retryable: true, action: "none" },
  RATE_LIMITED: { code: "RATE_LIMITED", message: ASK_RATE_LIMITED_MESSAGE, retryable: true, action: "retry" },
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function readCode(value: unknown): string {
  if (typeof value !== "string") return "";
  const code = value.trim();
  if (code === "AUTH_ERROR") return "UPSTREAM_AUTH";
  return code;
}

function specFor(code: string): AskErrorView {
  const spec = ASK_ERROR_SPECS[code];
  if (spec) return { ...spec };
  return {
    code: "UPSTREAM_ERROR",
    message: UPSTREAM_ERROR_MESSAGE,
    retryable: true,
    action: "retry",
  };
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  return (error as { name?: unknown }).name === "AbortError";
}

/**
 * Map an HTTP failure, stream error, ByokError, or thrown value to a fixed UI view.
 * A local AbortError (user cancel) returns code CANCELLED with an empty message and action none.
 * Known codes use the whitelist retryable flag. Config codes stay non-retryable.
 */
export function resolveAskError(input: unknown): AskErrorView {
  if (isAbortError(input)) {
    return { code: "CANCELLED", message: "", retryable: false, action: "none" };
  }

  if (input instanceof TypeError) return specFor("UPSTREAM_ERROR");

  if (input instanceof ByokError) return specFor(readCode(input.code));

  if (input instanceof Response) return statusHeuristic(input.status);

  const record = asRecord(input);
  if (record) {
    if (typeof record.status === "number" && record.code === undefined && record.error === undefined) {
      return statusHeuristic(record.status);
    }
    const code = readCode(record.code ?? record.error);
    if (code) return specFor(code);
    if (typeof record.status === "number") return statusHeuristic(record.status);
  }

  return specFor("UPSTREAM_ERROR");
}

function statusHeuristic(status: number): AskErrorView {
  if (status === 401 || status === 403) return specFor("UPSTREAM_AUTH");
  if (status === 404) return specFor("NOT_FOUND");
  if (status === 408 || status === 504) return specFor("TIMEOUT");
  if (status === 429) return specFor("RATE_LIMITED");
  if (status === 400) return specFor("BAD_REQUEST");
  if (status === 409) return specFor("ASK_BUSY");
  return specFor("UPSTREAM_ERROR");
}
