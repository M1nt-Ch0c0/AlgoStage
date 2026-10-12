import { expect, test, vi } from "vitest";
import { createFixture, request } from "./api-fixture";

test("新 Key 保存前测试、保存后测试和实际讲课使用同组 provider、地址、模型", async () => {
  const f = await createFixture();
  const destinations: string[] = [];
  const keys: string[] = [];
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    destinations.push(url.origin);
    const headers = new Headers(init?.headers);
    keys.push(headers.get("authorization") ?? headers.get("x-api-key") ?? headers.get("x-goog-api-key") ?? "");
    return Response.json({ error: { message: "mock unauthorized" } }, { status: 401 });
  });
  try {
    const { PUT } = await import("../app/api/settings/route");
    const { POST: hint } = await import("../app/api/hint/route");
    const { POST: lecture } = await import("../app/api/lecture/route");
    const { resolveByok } = await import("../lib/agent/provider");
    process.env.AI_API_KEY = "fake-env-key";
    process.env.AI_BASE_URL = "https://environment.invalid/v1";
    for (const provider of ["openai-compatible", "anthropic", "google"] as const) {
      for (const baseURL of [f.baseURL, ""]) {
        destinations.length = 0; keys.length = 0;
        await f.save({ provider: "openai-compatible", apiKey: "fake-old-key", model: "old-model", baseURL: "https://old-proxy.invalid/v1", baseURLProvider: "openai-compatible" });
        const fields = { provider, model: "new-model", baseURL, apiKey: "fake-new-key" };
        const byok = { ...fields, baseURL: fields.baseURL || undefined };
        const tested = await resolveByok(byok);
        await hint(request({ slug: "two-sum", level: 1, byok }));
        expect((await PUT(request({ settings: fields }))).status).toBe(200);
        const saved = await resolveByok();
        expect(saved?.config).toEqual(tested?.config);
        await hint(request({ slug: "two-sum", level: 1 }));
        await lecture(request({ slug: "3sum" }));
        expect(destinations).toHaveLength(3);
        expect(new Set(destinations).size).toBe(1);
        expect(destinations[0]).not.toMatch(/old-proxy|environment/);
        expect(keys.every(key => key.includes("fake-new-key"))).toBe(true);
      }
    }
  } finally { fetchMock.mockRestore(); await f.close(); }
});
