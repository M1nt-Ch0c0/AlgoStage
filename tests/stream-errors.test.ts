import { expect, test } from "vitest";
import { streamErrorEvent } from "../lib/agent/request";

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
