import { describe, expect, test } from "vitest";
import {
  ASK_BAD_REQUEST_MESSAGE,
  ASK_CANCELLED_MESSAGE,
  ASK_CONFIGURATION_ERROR_MESSAGE,
  ASK_EMPTY_BODY_MESSAGE,
  ASK_ERROR_SPECS,
  ASK_INVALID_ANSWER_MESSAGE,
  ASK_NO_BYOK_MESSAGE,
  ASK_NOT_FOUND_MESSAGE,
  ASK_RATE_LIMITED_MESSAGE,
  ASK_STEP_NOT_FOUND_MESSAGE,
  ASK_TIMEOUT_MESSAGE,
  resolveAskError,
} from "@/lib/ask/ask-errors";
import { ASK_BUSY_MESSAGE } from "@/lib/ask/ask-response";
import {
  BASE_URL_INVALID_LECTURE_MESSAGE,
  BASE_URL_NOT_ALLOWED_LECTURE_MESSAGE,
  BYOK_KEY_REQUIRED_MESSAGE,
  ByokError,
  SETTINGS_LOCKED_MESSAGE,
  UPSTREAM_AUTH_LECTURE_MESSAGE,
  UPSTREAM_ERROR_MESSAGE,
} from "@/lib/byok/client";

const CONFIG = [
  ["NO_BYOK", ASK_NO_BYOK_MESSAGE],
  ["BASE_URL_INVALID", BASE_URL_INVALID_LECTURE_MESSAGE],
  ["BASE_URL_NOT_ALLOWED", BASE_URL_NOT_ALLOWED_LECTURE_MESSAGE],
  ["BYOK_KEY_REQUIRED", BYOK_KEY_REQUIRED_MESSAGE],
  ["SETTINGS_LOCKED", SETTINGS_LOCKED_MESSAGE],
  ["UPSTREAM_AUTH", UPSTREAM_AUTH_LECTURE_MESSAGE],
  ["CONFIGURATION_ERROR", ASK_CONFIGURATION_ERROR_MESSAGE],
] as const;

describe("resolveAskError", () => {
  test.each(CONFIG)("44. config code %s is settings-only and ignores incoming retryable", (code, message) => {
    for (const input of [
      { code, message: "upstream leak sk-secret", retryable: true },
      { error: code, retryable: true },
      new ByokError(code, "raw browser text"),
    ]) {
      const view = resolveAskError(input);
      expect(view).toEqual({ code, message, retryable: false, action: "settings" });
      expect(view.message).not.toMatch(/sk-secret|raw browser/);
    }
  });

  test("44. AUTH_ERROR normalizes to UPSTREAM_AUTH", () => {
    expect(resolveAskError({ code: "AUTH_ERROR", message: "bad token", retryable: true })).toEqual({
      code: "UPSTREAM_AUTH",
      message: UPSTREAM_AUTH_LECTURE_MESSAGE,
      retryable: false,
      action: "settings",
    });
  });

  test("44. unknown HTTP and stream codes use UPSTREAM_ERROR and stay retryable", () => {
    expect(resolveAskError({ code: "WEIRD_UPSTREAM", message: "socket hang up body", retryable: false })).toEqual({
      code: "UPSTREAM_ERROR",
      message: UPSTREAM_ERROR_MESSAGE,
      retryable: true,
      action: "retry",
    });
    expect(resolveAskError(new Response("secret html", { status: 502 }))).toEqual({
      code: "UPSTREAM_ERROR",
      message: UPSTREAM_ERROR_MESSAGE,
      retryable: true,
      action: "retry",
    });
  });

  test("45. TIMEOUT, INVALID_ANSWER, STEP_NOT_FOUND, EMPTY_BODY, INCOMPLETE_STREAM", () => {
    expect(resolveAskError({ code: "TIMEOUT", message: "model timed out after 90s" })).toEqual({
      code: "TIMEOUT",
      message: ASK_TIMEOUT_MESSAGE,
      retryable: true,
      action: "retry",
    });
    expect(resolveAskError({ code: "INVALID_ANSWER", message: "{not json" })).toEqual({
      code: "INVALID_ANSWER",
      message: ASK_INVALID_ANSWER_MESSAGE,
      retryable: true,
      action: "retry",
    });
    expect(resolveAskError({ code: "STEP_NOT_FOUND", retryable: true })).toEqual({
      code: "STEP_NOT_FOUND",
      message: ASK_STEP_NOT_FOUND_MESSAGE,
      retryable: false,
      action: "refresh",
    });
    for (const code of ["EMPTY_BODY", "INCOMPLETE_STREAM"] as const) {
      expect(resolveAskError({ code, message: "EOF without result" })).toEqual({
        code,
        message: ASK_EMPTY_BODY_MESSAGE,
        retryable: true,
        action: "retry",
      });
    }
  });

  test("45. TypeError network maps to UPSTREAM_ERROR without the browser message", () => {
    expect(resolveAskError(new TypeError("Failed to fetch https://evil"))).toEqual({
      code: "UPSTREAM_ERROR",
      message: UPSTREAM_ERROR_MESSAGE,
      retryable: true,
      action: "retry",
    });
  });

  test("ASK_BUSY and RATE_LIMITED use Paige copy", () => {
    expect(resolveAskError({ code: "ASK_BUSY", message: "busy raw", retryable: false })).toEqual({
      code: "ASK_BUSY",
      message: ASK_BUSY_MESSAGE,
      retryable: true,
      action: "none",
    });
    expect(ASK_BUSY_MESSAGE).toBe("上一个问题还在回答，答完再问");
    expect(resolveAskError({ code: "RATE_LIMITED", message: "slow down" })).toEqual({
      code: "RATE_LIMITED",
      message: ASK_RATE_LIMITED_MESSAGE,
      retryable: true,
      action: "retry",
    });
  });

  test("NO_BYOK uses the ask-path Paige message, not the lecture NO_BYOK_MESSAGE", () => {
    expect(resolveAskError(new ByokError("NO_BYOK", "还没填 API Key。先去设置页填入你自己的 API Key 就能开讲。"))).toEqual({
      code: "NO_BYOK",
      message: ASK_NO_BYOK_MESSAGE,
      retryable: false,
      action: "settings",
    });
    expect(ASK_NO_BYOK_MESSAGE).toBe("老师还没接上 AI，先去设置里填自己的 Key。");
  });

  test("local AbortError is CANCELLED with no error UI", () => {
    const abort = new DOMException("The operation was aborted.", "AbortError");
    expect(resolveAskError(abort)).toEqual({
      code: "CANCELLED",
      message: "",
      retryable: false,
      action: "none",
    });
  });

  test("server CANCELLED keeps the edit message and does not pass raw text", () => {
    expect(resolveAskError({ code: "CANCELLED", message: "user clicked elsewhere", retryable: true })).toEqual({
      code: "CANCELLED",
      message: ASK_CANCELLED_MESSAGE,
      retryable: false,
      action: "edit",
    });
  });

  test("BAD_REQUEST / BAD_JSON / NOT_FOUND actions", () => {
    expect(resolveAskError({ code: "BAD_REQUEST", message: "bad" })).toMatchObject({
      message: ASK_BAD_REQUEST_MESSAGE, action: "edit", retryable: false,
    });
    expect(resolveAskError({ code: "BAD_JSON" })).toMatchObject({
      code: "BAD_JSON", message: ASK_BAD_REQUEST_MESSAGE, action: "edit", retryable: false,
    });
    expect(resolveAskError({ code: "NOT_FOUND" })).toMatchObject({
      message: ASK_NOT_FOUND_MESSAGE, action: "home", retryable: false,
    });
  });

  test("HTTP status heuristics when the body has no code", () => {
    expect(resolveAskError(new Response(null, { status: 401 })).code).toBe("UPSTREAM_AUTH");
    expect(resolveAskError(new Response(null, { status: 404 })).code).toBe("NOT_FOUND");
    expect(resolveAskError(new Response(null, { status: 429 })).code).toBe("RATE_LIMITED");
    expect(resolveAskError(new Response(null, { status: 504 })).code).toBe("TIMEOUT");
    expect(resolveAskError(new Response(null, { status: 400 })).code).toBe("BAD_REQUEST");
    expect(resolveAskError(new Response(null, { status: 409 })).code).toBe("ASK_BUSY");
    expect(resolveAskError({ status: 502 }).code).toBe("UPSTREAM_ERROR");
  });

  test("known codes ignore an incoming retryable flag", () => {
    expect(resolveAskError({ code: "TIMEOUT", retryable: false }).retryable).toBe(true);
    expect(resolveAskError({ code: "STEP_NOT_FOUND", retryable: true }).retryable).toBe(false);
    expect(resolveAskError({ code: "CANCELLED", retryable: true }).retryable).toBe(false);
    expect(resolveAskError({ code: "UPSTREAM_ERROR", retryable: false }).retryable).toBe(true);
  });

  test("whitelist covers every §5.2 code", () => {
    for (const code of [
      "NO_BYOK", "BASE_URL_INVALID", "BASE_URL_NOT_ALLOWED", "BYOK_KEY_REQUIRED", "SETTINGS_LOCKED",
      "UPSTREAM_AUTH", "CONFIGURATION_ERROR", "TIMEOUT", "UPSTREAM_ERROR", "INVALID_ANSWER",
      "EMPTY_BODY", "INCOMPLETE_STREAM", "STEP_NOT_FOUND", "BAD_REQUEST", "BAD_JSON", "NOT_FOUND",
      "CANCELLED", "ASK_BUSY", "RATE_LIMITED",
    ]) {
      expect(ASK_ERROR_SPECS[code]?.message.length).toBeGreaterThan(0);
    }
  });
});
