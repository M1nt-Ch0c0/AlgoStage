import { expect, test, vi } from "vitest";
import { createFixture, request } from "./api-fixture";

test("切换原生 provider 不继承旧代理，只有专门绑定的地址才传给原生 SDK", async () => {
  const f = await createFixture();
  const destinations: URL[] = [];
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
    destinations.push(new URL(input instanceof Request ? input.url : String(input)));
    return Response.json({ error: { type: "authentication_error", message: "mock unauthorized" } }, { status: 401 });
  });
  try {
    const { PUT, GET } = await import("../app/api/settings/route");
    const { POST } = await import("../app/api/hint/route");
    const { resolveByok } = await import("../lib/agent/provider");
    for (const [provider, host] of [["anthropic", "api.anthropic.com"], ["google", "generativelanguage.googleapis.com"]]) {
      await f.save({ provider: "openai-compatible", model: "old", apiKey: "fake-old-key", baseURL: f.baseURL, baseURLProvider: "openai-compatible" });
      expect((await PUT(request({ settings: { provider, model: "native-model", apiKey: "fake-native-key" } }))).status).toBe(200);
      expect((await resolveByok())?.config.baseURL).toBeUndefined();
      expect((await (await GET()).json()).settings.baseURL).toBe("");
      await POST(request({ slug: "two-sum", level: 1 }));
      expect(destinations.at(-1)?.hostname).toBe(host);

      // 升级前留下的无归属地址，或属于别家 provider 的地址，也不能用于原生请求。
      for (const baseURLProvider of ["", "openai-compatible"]) {
        await f.save({ baseURL: f.baseURL, baseURLProvider });
        expect((await resolveByok())?.config.baseURL).toBeUndefined();
        await POST(request({ slug: "two-sum", level: 1 }));
        expect(destinations.at(-1)?.hostname).toBe(host);
      }
      expect(destinations.filter(url => url.origin === new URL(f.baseURL).origin)).toHaveLength(0);
      // 当前 provider 明确保存过专用代理后才能使用它。
      expect((await PUT(request({ settings: { provider, baseURL: f.baseURL } }))).status).toBe(200);
      expect((await resolveByok())?.config.baseURL).toBe(f.baseURL);
      await POST(request({ slug: "two-sum", level: 1 }));
      expect(destinations.at(-1)?.origin).toBe(new URL(f.baseURL).origin);
      destinations.length = 0;
    }
  } finally { fetchMock.mockRestore(); await f.close(); }
});
