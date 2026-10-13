import { expect, test, vi } from "vitest";
import { createFixture, request } from "./api-fixture";
import { mockAIResponse } from "./support/mock-ai-response";

vi.mock("node:dns/promises", () => ({ lookup: vi.fn(async () => [{ address: "8.8.8.8", family: 4 }]) }));

test("环境 Key 只到环境接口：仅保存模型、旧默认地址、来源不一致均不访问 OpenAI", async () => {
  const f = await createFixture({ modelServer: false });
  const destinations: string[] = [];
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    destinations.push(url.hostname);
    expect(init?.redirect).toBe("manual");
    expect(init).toHaveProperty("dispatcher");
    if (url.origin !== new URL(f.baseURL).origin) throw new Error("拦截非 mock 上游请求");
    const body = JSON.parse(String(init?.body));
    f.calls.push({ model: body.model, key: new Headers(init?.headers).get("authorization") ?? undefined });
    return Promise.resolve(mockAIResponse(init));
  });
  try {
    const { POST: hint } = await import("../app/api/hint/route");
    const { POST: lecture } = await import("../app/api/lecture/route");
    const { resolveSavedByok, createModel, ByokConfigurationError } = await import("../lib/agent/provider");
    process.env.AI_API_KEY = "fake-env-origin-key";
    process.env.AI_BASE_URL = f.baseURL;
    process.env.AI_PROVIDER = "openai-compatible";
    const scenarios: Record<string, string>[] = [
      { model: "saved-model" },
      { model: "saved-model-2", provider: "google", baseURL: "https://api.openai.com/v1", apiKey: "" },
    ];
    for (const settings of scenarios) {
      await f.save(settings);
      f.setReply(() => "正确的环境接口");
      expect((await hint(request({ slug: "3sum", level: 1 }))).status).toBe(200);
      expect(f.calls.at(-1)).toMatchObject({ key: "Bearer fake-env-origin-key", model: settings.model });
      f.setToolsReply(() => [
        { name: "add_step", input: { id: "s1", narration: "讲解", target: { kind: "code-line", start: 1 } } },
        { name: "finish", input: {} },
      ]);
      expect((await lecture(request({ slug: "3sum" }))).status).toBe(200);
    }
    expect(destinations).toHaveLength(4);
    expect(destinations.filter(host => host === "api.openai.com")).toHaveLength(0);

    // 修改合并后的配置，以及携带环境 Key 的请求体，都会在创建模型前被拦截。
    const resolved = resolveSavedByok({ model: "saved" })!;
    resolved.config.baseURL = "https://api.openai.com/v1";
    expect(() => createModel(resolved.config)).toThrow(ByokConfigurationError);
    const byok = { provider: "openai-compatible", model: "model", apiKey: process.env.AI_API_KEY, baseURL: "https://api.openai.com/v1" };
    for (const POST of [hint, lecture]) {
      expect((await POST(request({ slug: "3sum", level: 1, byok }))).status).toBe(400);
    }
    await f.save({ apiKey: "saved-other-key", provider: "openai-compatible", baseURL: "" });
    expect(() => resolveSavedByok({ apiKey: "saved-other-key", provider: "openai-compatible" })).toThrow(ByokConfigurationError);
    for (const POST of [hint, lecture]) {
      const response = await POST(request({ slug: "3sum", level: 1 }));
      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe("CONFIGURATION_ERROR");
    }
    await f.save({ apiKey: "" });
    delete process.env.AI_BASE_URL;
    expect((await hint(request({ slug: "3sum", level: 1 }))).status).toBe(400);
    expect(destinations).toHaveLength(4);
    expect(destinations.filter(host => host === "api.openai.com")).toHaveLength(0);
  } finally { fetchMock.mockRestore(); await f.close(); }
});
