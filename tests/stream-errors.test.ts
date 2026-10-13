import { expect, test } from "vitest";
import {
  badRequest,
  baseURLInvalid,
  baseURLNotAllowed,
  byokKeyRequired,
  configurationError,
  settingsLocked,
  streamErrorEvent,
  upstreamAuthError,
  upstreamError,
} from "../lib/agent/request";

test.each([
  ["TIMEOUT", true],
  ["INVALID_SCRIPT", true],
  ["UPSTREAM_AUTH", false],
  ["UPSTREAM_ERROR", true],
  ["CANCELLED", false],
  ["BASE_URL_NOT_ALLOWED", false],
  ["BASE_URL_INVALID", false],
  ["BYOK_KEY_REQUIRED", false],
  ["CONFIGURATION_ERROR", false],
  ["NO_BYOK", false],
  ["BAD_REQUEST", false],
  ["BAD_JSON", false],
  ["NOT_FOUND", false],
  ["SETTINGS_LOCKED", false],
  ["INVALID_ANSWER", true],
  ["STEP_NOT_FOUND", false],
  ["ASK_BUSY", true],
  ["RATE_LIMITED", true],
  ["PAYLOAD_TOO_LARGE", false],
])("流式错误 %s 仅保留 type、code、retryable", (code, retryable) => {
  expect(streamErrorEvent(code)).toEqual({ type: "error", code, retryable });
});

test.each([
  "untrusted-private-details",
  "BASE_URL_unknown-private-details",
  "constructor",
  "__proto__",
  undefined,
  null,
  401,
  new Error("internal-private-details"),
  { code: "UPSTREAM_AUTH", message: "untrusted-private-details", status: 401 },
])("未知错误码 %s 不透传内容", value => {
  expect(streamErrorEvent(value)).toEqual({ type: "error", code: "UPSTREAM_ERROR", retryable: true });
});

test("既有 HTTP 错误助手保持原状态与字段", async () => {
  expect((await (await badRequest()).json()).error).toBe("BAD_REQUEST");
  expect((await baseURLNotAllowed()).status).toBe(400);
  expect((await (await baseURLInvalid()).json()).code).toBe("BASE_URL_INVALID");
  expect((await (await byokKeyRequired()).json()).code).toBe("BYOK_KEY_REQUIRED");
  expect((await settingsLocked()).status).toBe(403);
  expect((await (await upstreamAuthError()).json()).retryable).toBe(false);
  expect((await upstreamError(401)).status).toBe(400);
  expect((await upstreamError(403)).status).toBe(400);
  expect((await upstreamError()).status).toBe(502);
  expect((await upstreamError(500)).status).toBe(502);
  expect((await (await configurationError()).json()).error).toBe("CONFIGURATION_ERROR");
});
