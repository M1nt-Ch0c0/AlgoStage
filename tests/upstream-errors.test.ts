import assert from "node:assert/strict";
import { test } from "node:test";
import { createFixture, request } from "./api-fixture";

/** 捕获实际 stdout/stderr，覆盖 console 和 SDK 的警告输出。 */
async function captureLogs<T>(run: () => Promise<T>) {
  const logs: string[] = [];
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  const capture = ((chunk: unknown) => { logs.push(String(chunk)); return true; }) as typeof stdout;
  process.stdout.write = capture;
  process.stderr.write = capture;
  try {
    const result = await run();
    // SDK 的 process.emitWarning 可能在下个事件循环才写 stderr。
    await new Promise<void>(resolve => setImmediate(resolve));
    return { result, logs: logs.join("") };
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
}

test("上游 401/403 返回 400 UPSTREAM_AUTH，其他故障为 502，响应与全部日志不泄露 Key", async () => {
  const f = await createFixture();
  try {
    const routes = [await import("../app/api/hint/route"), await import("../app/api/lecture/route")];
    const testConnection = await import("../app/api/settings/test-connection/route");
    const apiKey = "fake-secret-key-M1-review-401";
    const byok = { provider: "openai-compatible", model: "review-model", apiKey, baseURL: f.baseURL };
    for (const status of [401, 403, 503]) {
      // 故意模拟供应商把完整 Key 放进错误体的情况。
      f.setError(status, { error: { message: `Incorrect API key provided: ${apiKey}`, type: "authentication_error" } });
      for (const route of [...routes, testConnection]) {
        const before = f.calls.length;
        const { result: response, logs } = await captureLogs(() => route.POST(request({ slug: "3sum", level: 1, byok })));
        const auth = status === 401 || status === 403;
        assert.equal(response.status, auth ? 400 : 502);
        const raw = await response.text();
        if (auth) assert.deepEqual(JSON.parse(raw), {
          code: "UPSTREAM_AUTH", error: "UPSTREAM_AUTH", retryable: false, message: "Key 无效或没有权限",
        });
        else assert.equal(JSON.parse(raw).error, "UPSTREAM_ERROR");
        assert.ok(!raw.includes(apiKey));
        assert.ok(!logs.includes(apiKey));
        assert.ok(!logs.includes("Incorrect API key provided"));
        assert.equal(f.calls.length - before, status >= 500 && route !== testConnection ? 2 : 1, "401/403 不重试且错误不泄露 Key");
      }
    }
    assert.equal(await f.prisma.lectureScriptCache.count(), 0);
    const beforeBadRequest = f.calls.length;
    for (const route of routes) {
      for (const value of [42, true, {}, [], null]) {
        const response = await route.POST(request({ slug: "3sum", level: 1, byok: { ...byok, apiKey: value } }));
        assert.equal(response.status, 400);
        assert.equal((await response.json()).error, "BAD_REQUEST");
      }
      for (const body of [null, [], "bad parameters", { level: 1 }, { slug: 123, level: 1 }]) {
        const response = await route.POST(request(body));
        assert.equal(response.status, 400);
        assert.equal((await response.json()).error, "BAD_REQUEST");
      }
    }
    const [hint, lecture] = routes;
    for (const changes of [{ language: "fr" }, { solutionLanguage: "java" }, { byok: { ...byok, model: 22 } }, { byok: { ...byok, provider: "unknown" } }]) {
      const response = await lecture.POST(request({ slug: "3sum", byok, ...changes }));
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error, "BAD_REQUEST");
    }
    for (const level of [0, 6, 1.5, "1"]) {
      const response = await hint.POST(request({ slug: "3sum", level, byok }));
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error, "BAD_REQUEST");
    }
    assert.equal(f.calls.length, beforeBadRequest, "坏参数不能请求模型");
  } finally { await f.close(); }
});
