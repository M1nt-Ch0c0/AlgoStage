import { afterAll, beforeAll, expect, test } from "vitest";
import { APICallError, InvalidResponseDataError } from "ai";
import { createFixture, request } from "./api-fixture";
import { isTransientUpstreamError, upstreamStatusCode } from "../lib/agent/upstream-retry";
import { validateScript } from "../lib/teaching/validated-script";

let f: Awaited<ReturnType<typeof createFixture>>;
let generateLecture: typeof import("../lib/agent/lecture-generation").generateLecture;
beforeAll(async () => {
  f = await createFixture();
  ({ generateLecture } = await import("../lib/agent/lecture-generation"));
});
afterAll(async () => {
  await f?.close();
});
function prepare() {
  f.setDelay(0);
  f.setDisconnects(0);
  f.setToolsReply(() => [
    {
      name: "add_step",
      input: {
        id: "s1",
        narration: "讲解",
        target: { kind: "code-line", start: 1 },
      },
    },
    { name: "finish", input: {} },
  ]);
  return {
    config: {
      provider: "openai-compatible" as const,
      model: "retry-test",
      apiKey: "fake-key",
      baseURL: f.baseURL,
    },
    prompt: "讲解",
    referenceCode: "a",
    metadata: {
      problemSlug: "3sum",
      mode: "lecture" as const,
      language: "zh" as const,
      solutionLanguage: "typescript" as const,
    },
    validate: (value: unknown) => validateScript(value, "a"),
  };
}

test.each([429, 500, 501, 502, 503, 504, 599])(
  "首次上游 %i 自动重试后成功",
  async (status) => {
    const input = prepare(),
      before = f.calls.length;
    f.setError(status, { error: { message: "temporary" } }, 1);
    expect(await generateLecture(input)).toMatchObject({ ok: true });
    expect(f.calls.length - before).toBe(2);
  },
);

test.each([400, 401, 403, 404, 408, 422])(
  "上游 %i 不重试、不缓存",
  async (status) => {
    const input = prepare(),
      before = f.calls.length;
    f.setError(status, { error: { message: "do not retry" } });
    const { POST } = await import("../app/api/lecture/route");
    const response = await POST(request({ slug: "3sum", byok: input.config }));
    expect(response.status).toBe(status === 401 || status === 403 ? 400 : 502);
    expect(f.calls.length - before).toBe(1);
    expect(await f.prisma.lectureScriptCache.count()).toBe(0);
  },
);

test.each([401, 403])("SDK 包装的 %i 保留鉴权状态且不重试", async statusCode => {
  const { settingsConnectionError } = await import("../lib/agent/settings-connection");
  const error = new TypeError("fetch failed", { cause: new APICallError({
    statusCode, message: "untrusted-private-details", url: "https://fake.invalid",
    requestBodyValues: {}, isRetryable: true,
    cause: Object.assign(new Error("network"), { code: "ETIMEDOUT" }),
  }) });
  expect(upstreamStatusCode(error)).toBe(statusCode);
  expect(isTransientUpstreamError(error)).toBe(false);
  const response = settingsConnectionError(error);
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    code: "UPSTREAM_AUTH", error: "UPSTREAM_AUTH", retryable: false, message: "API Key 无效或没有权限",
  });
});

test("未知错误和循环 cause 不推测 HTTP 状态", () => {
  const error = new Error("internal-private-details");
  error.cause = error;
  expect(upstreamStatusCode(error)).toBeUndefined();
  expect(upstreamStatusCode({ statusCode: 401 })).toBeUndefined();
  expect(isTransientUpstreamError(error)).toBe(false);
});

test("断连可恢复，连续故障达到上限后明确失败、不缓存", async () => {
  const input = prepare(),
    before = f.calls.length;
  f.setDisconnects(1);
  expect(await generateLecture(input)).toMatchObject({ ok: true });
  expect(f.calls.length - before).toBe(2);
  f.setError(503, { error: { message: "unavailable" } });
  const { POST } = await import("../app/api/lecture/route");
  const start = f.calls.length;
  expect(
    (await POST(request({ slug: "3sum", byok: input.config }))).status,
  ).toBe(502);
  expect(f.calls.length - start).toBe(2);
  expect(await f.prisma.lectureScriptCache.count()).toBe(0);
});

test("重试退避计入总耗时上限，超时和 abort 均不发送下一次请求", async () => {
  const input = prepare(),
    before = f.calls.length;
  f.setError(503, { error: { message: "temporary" } });
  const start = performance.now();
  expect(await generateLecture({ ...input, timeoutMs: 100 })).toMatchObject({
    error: "TIMEOUT",
    status: 504,
  });
  expect(performance.now() - start).toBeLessThan(500);
  expect(f.calls.length - before).toBe(1);
  const abort = new AbortController(),
    next = f.calls.length;
  expect(
    await generateLecture({
      ...input,
      signal: abort.signal,
      onEvent: (event) => {
        if (event.type === "progress" && event.phase === "retry") abort.abort();
      },
    }),
  ).toMatchObject({ error: "CANCELLED" });
  await new Promise((resolve) => setTimeout(resolve, 250));
  expect(f.calls.length - next).toBe(1);
  expect(await f.prisma.lectureScriptCache.count()).toBe(0);
});

test("提示链路同样只对瞬时错误重试并尊重请求取消", async () => {
  const input = prepare();
  f.setReply(() => "观察哈希表");
  f.setError(502, { error: { message: "temporary" } }, 1);
  const { POST } = await import("../app/api/hint/route");
  const before = f.calls.length;
  expect(
    (await POST(request({ slug: "3sum", level: 1, byok: input.config })))
      .status,
  ).toBe(200);
  expect(f.calls.length - before).toBe(2);
  const abort = new AbortController();
  abort.abort();
  const { NextRequest } = await import("next/server");
  const cancelled = new NextRequest(
    request({ slug: "3sum", level: 1, byok: input.config }),
    { signal: abort.signal },
  );
  expect((await POST(cancelled)).status).toBe(499);
  expect(f.calls.length - before).toBe(2);
});

test.each([undefined, 0, 200, 204, 299, 301, 600])("未知或非重试 HTTP 状态 %s 不重试", statusCode => {
  expect(isTransientUpstreamError(new APICallError({
    statusCode, message: "unknown response", url: "https://fake.invalid",
    requestBodyValues: {}, isRetryable: true,
  }))).toBe(false);
});

test("错误分类：网络超时/断连可重试，参数/协议错误、普通异常、非 429 的 4xx 不可重试", () => {
  for (const code of [
    "ETIMEDOUT",
    "ECONNRESET",
    "UND_ERR_BODY_TIMEOUT",
    "UND_ERR_SOCKET",
  ]) {
    expect(
      isTransientUpstreamError(
        new Error("wrapped", {
          cause: Object.assign(new Error("network"), { code }),
        }),
      ),
    ).toBe(true);
  }
  expect(
    isTransientUpstreamError(new DOMException("timeout", "TimeoutError")),
  ).toBe(true);
  expect(isTransientUpstreamError(new TypeError("fetch failed"))).toBe(true);
  expect(
    isTransientUpstreamError(
      new InvalidResponseDataError({
        data: undefined,
        message: "Response stream ended without a finish reason.",
      }),
    ),
  ).toBe(true);
  for (const error of [
    new Error("unknown"),
    new TypeError("invalid options"),
    new DOMException("cancel", "AbortError"),
    new InvalidResponseDataError({ data: {}, message: "bad json" }),
  ]) {
    expect(isTransientUpstreamError(error)).toBe(false);
  }
  expect(
    isTransientUpstreamError(
      new APICallError({
        statusCode: 401,
        message: "rate limited",
        url: "https://fake.invalid",
        requestBodyValues: {},
        cause: Object.assign(new Error("network"), { code: "ETIMEDOUT" }),
      }),
    ),
  ).toBe(false);
});
