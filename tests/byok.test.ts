import assert from "node:assert/strict";
import { test } from "node:test";
import { vi } from "vitest";
import { createFixture, request } from "./api-fixture";
import { mockAIResponse } from "./support/mock-ai-response";

vi.mock("node:dns/promises", () => ({ lookup: vi.fn(async () => [{ address: "8.8.8.8", family: 4 }]) }));

test("S1：请求 > 设置 > 环境变量；已保存 Key 可直接要提示且不会泄露", async () => {
  const f = await createFixture({ modelServer: false });
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    f.calls.push({ model: body.model, key: new Headers(init?.headers).get("authorization") ?? undefined });
    return mockAIResponse(init);
  });
  try {
    const { resolveByok } = await import("../lib/agent/provider");
    const { GET } = await import("../app/api/settings/route");
    const { POST } = await import("../app/api/hint/route");
    assert.equal(await resolveByok(), null);
    assert.equal((await (await GET()).json()).keySource, "none");
    process.env.AI_API_KEY = "env-test-key";
    process.env.AI_MODEL = "env-model";
    process.env.AI_BASE_URL = f.baseURL;
    assert.equal((await resolveByok())?.source, "env");
    assert.equal((await (await GET()).json()).keySource, "env");
    await f.save({ apiKey: "saved-test-key", model: "saved-model", provider: "openai-compatible", baseURL: f.baseURL });
    const saved = await resolveByok();
    assert.equal(saved?.source, "settings");
    assert.equal(saved?.config.apiKey, "saved-test-key");
    const settings = await (await GET()).json();
    assert.equal(settings.keySource, "settings");
    assert.equal(settings.envConfigured, true);
    assert.equal(settings.settings.apiKey, undefined);
    assert.equal(settings.settings.apiKeyMasked, "••••-key");
    assert.ok(!JSON.stringify(settings).includes("saved-test-key"));
    // 模型可独立回退；密钥和接口不能跨来源混用。
    await f.save({ model: "  " });
    assert.deepEqual(await resolveByok(), { source: "settings", config: {
      provider: "openai-compatible", apiKey: "saved-test-key", model: "env-model", baseURL: f.baseURL,
    } });
    assert.equal((await (await GET()).json()).keySource, "settings");
    let response = await POST(request({ slug: "3sum", level: 1 }));
    assert.equal(response.status, 200);
    assert.deepEqual(f.calls.at(-1), { model: "env-model", key: "Bearer saved-test-key" });
    delete process.env.AI_MODEL;
    assert.equal((await resolveByok())?.config.model,"gpt-6.1-sol");
    delete process.env.AI_API_KEY;
    assert.equal((await resolveByok())?.source, "settings");
    assert.equal((await (await GET()).json()).keySource, "settings");
    // 设置页只指定模型与地址时，用环境 Key，来源仍为环境变量。
    process.env.AI_API_KEY = "env-test-key";
    process.env.AI_BASE_URL = f.baseURL;
    await f.save({ apiKey: "  ", model: "saved-model", baseURL: "https://api.openai.com/v1" });
    assert.equal((await resolveByok())?.source, "env");
    assert.equal((await (await GET()).json()).keySource, "env");
    response = await POST(request({ slug: "3sum", level: 1 }));
    assert.equal(response.status, 200);
    assert.deepEqual(f.calls.at(-1), { model: "saved-model", key: "Bearer env-test-key" });
    delete process.env.AI_API_KEY;
    assert.equal(await resolveByok(), null);
    assert.equal((await (await GET()).json()).keySource, "none");
    await f.save({ apiKey: "saved-test-key", baseURL: f.baseURL });
    const incomplete = { provider: "google" as const, apiKey: "new-key", model: "" };
    assert.equal((await resolveByok(incomplete))?.source, "request");
    assert.equal((await resolveByok(incomplete))?.config.model, "saved-model");
    const complete = { ...incomplete, model: "new-model" };
    assert.equal((await resolveByok(complete))?.source, "request");
    response = await POST(request({ slug: "3sum", level: 1 }));
    assert.equal(response.status, 200);
    assert.ok((await response.json()).hint);
    assert.deepEqual(f.calls.at(-1), { model: "saved-model", key: "Bearer saved-test-key" });
  } finally { fetchMock.mockRestore(); await f.close(); }
});
