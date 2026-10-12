import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync } from "node:fs";
import { request } from "./api-fixture";

test("Demo：请求 Key 和环境 Key 均不能绕过 AI 禁用与设置隔离", async () => {
  const databasePath = `/tmp/algostage-demo-forbidden-${process.pid}.db`;
  process.env.DATABASE_URL = `file:${databasePath}`;
  process.env.NEXT_PUBLIC_ALGOSTAGE_DEMO = "1";
  process.env.AI_API_KEY = "forbidden-env-key";
  process.env.AI_MODEL = "forbidden-model";
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { calls++; throw new Error("Demo 不允许请求模型"); };
  try {
    for (const route of [await import("../app/api/lecture/route"), await import("../app/api/hint/route")]) {
      const response = await route.POST(request({ slug: "3sum", level: 1, byok: { provider: "openai-compatible", apiKey: "request-key", model: "request-model" } }));
      assert.equal(response.status, 403);
      assert.equal((await response.json()).error, "DEMO");
    }
    const settings = await import("../app/api/settings/route");
    assert.deepEqual(await (await settings.GET()).json(), { settings: {}, keySource: "none", envConfigured: false });
    assert.equal((await settings.PUT(request({ settings: { apiKey: "new-key" } }))).status, 403);
    const progress = await import("../app/api/progress/route");
    assert.equal((await progress.POST(request({ type: "submission", problemSlug: "two-sum", code: "", language: "typescript", verdict: "AC" }))).status, 400);
    assert.equal(calls, 0);
    assert.equal(existsSync(databasePath), false);
  } finally { globalThis.fetch = originalFetch; }
});
