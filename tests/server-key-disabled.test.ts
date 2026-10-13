import { lookup } from "node:dns/promises";
import type { LookupAddress, LookupAllOptions } from "node:dns";
import { inspect } from "node:util";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { GET, PUT } from "../app/api/settings/route";
import { POST as hint } from "../app/api/hint/route";
import { POST as lecture } from "../app/api/lecture/route";
import { POST as testConnection } from "../app/api/settings/test-connection/route";
import { AI_CONNECTION_ERROR } from "../lib/ai/egress-guard";
import { createModel, resolveSavedByok, ByokConfigurationError } from "../lib/agent/provider";
import { mockAIResponse } from "./support/mock-ai-response";

const db = vi.hoisted(() => {
  const settings = new Map<string, string>();
  const writeMethods = () => ({
    create: vi.fn(), createMany: vi.fn(), update: vi.fn(), updateMany: vi.fn(),
    upsert: vi.fn(), delete: vi.fn(), deleteMany: vi.fn(),
  });
  const setting = {
    ...writeMethods(),
    findMany: vi.fn(async () => Array.from(settings, ([key, value]) => ({ key, value }))),
    upsert: vi.fn(async ({ create }: { create: { key: string; value: string } }) => { settings.set(create.key, create.value); }),
  };
  const models = {
    setting,
    lectureScriptCache: { ...writeMethods(), findUnique: vi.fn(async (): Promise<{ script: string } | null> => null) },
    lectureAnswer: { ...writeMethods(), findMany: vi.fn(async () => []), deleteMany: vi.fn(async () => ({ count: 0 })) },
    hintUsage: writeMethods(), user: writeMethods(), problemProgress: writeMethods(),
    submission: writeMethods(), reviewCard: writeMethods(),
  };
  const writes = Object.values(models).flatMap(model => Object.entries(model)
    .filter(([method]) => !method.startsWith("find")).map(([, spy]) => spy));
  const rawWrites = { $executeRaw: vi.fn(), $executeRawUnsafe: vi.fn() };
  return {
    settings, writes: [...writes, ...Object.values(rawWrites)],
    prisma: { ...models, ...rawWrites, $transaction: vi.fn(async (run: (tx: typeof models) => Promise<unknown>) => run(models)) },
  };
});
vi.mock("@/lib/db/prisma", () => ({ prisma: db.prisma }));
vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));

const dns = vi.mocked(lookup as (host: string, options: LookupAllOptions) => Promise<LookupAddress[]>);
const fetchMock = vi.fn<typeof fetch>();
const serverURL = "https://server.example/v1";
const customURL = "https://request.example/v1";
const sentinel = "SENTINEL-REQUEST-KEY-never-store-or-log-8b94";
const serverKeys = { env: "SERVER-ENV-KEY-1234", db: "SERVER-DB-KEY-5678" };
const consoleMethods = [
  "log", "info", "debug", "warn", "error", "trace", "dir", "dirxml", "table", "assert",
  "count", "countReset", "time", "timeEnd", "timeLog", "group", "groupCollapsed", "groupEnd", "clear",
] as const;

function request(body: unknown, accept = "application/json") {
  return new NextRequest("http://localhost/api/test", {
    method: "POST", headers: { "Content-Type": "application/json", accept }, body: JSON.stringify(body),
  });
}
function configureServer(source: keyof typeof serverKeys) {
  if (source === "env") {
    vi.stubEnv("AI_API_KEY", serverKeys.env);
    vi.stubEnv("AI_BASE_URL", serverURL);
    vi.stubEnv("AI_MODEL", "server-model");
  } else {
    for (const [key, value] of Object.entries({
      apiKey: serverKeys.db, baseURL: serverURL, model: "server-model",
      provider: "openai-compatible", baseURLProvider: "openai-compatible",
    })) db.settings.set(key, value);
  }
}
function assertNoPersistenceOrLogs() {
  // inspect includes Error.message, cause and stack (JSON.stringify(Error) does not).
  expect(inspect(db.writes.map(spy => spy.mock.calls), { depth: null })).not.toContain(sentinel);
  expect(inspect([...db.settings], { depth: null })).not.toContain(sentinel);
  expect(inspect(consoleMethods.map(method => vi.mocked(console[method]).mock.calls), { depth: null })).not.toContain(sentinel);
  expect(inspect(vi.mocked(process.stdout.write).mock.calls, { depth: null })).not.toContain(sentinel);
  expect(inspect(vi.mocked(process.stderr.write).mock.calls, { depth: null })).not.toContain(sentinel);
  for (const [input, init] of fetchMock.mock.calls) {
    const url = input instanceof Request ? input.url : String(input);
    expect(url).not.toContain(sentinel);
    expect(url).not.toContain(serverKeys.env);
    expect(url).not.toContain(serverKeys.db);
    expect(String(init?.body)).not.toContain(sentinel);
  }
}

const entries = [
  { name: "hint", POST: hint, accept: "application/json" },
  { name: "lecture JSON", POST: lecture, accept: "application/json" },
  { name: "lecture NDJSON", POST: lecture, accept: "application/x-ndjson" },
];
beforeEach(() => {
  vi.clearAllMocks();
  db.settings.clear();
  db.prisma.lectureScriptCache.findUnique.mockReset().mockResolvedValue(null);
  dns.mockReset().mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
  fetchMock.mockReset().mockImplementation(async (_input, init) => mockAIResponse(init));
  vi.stubGlobal("fetch", fetchMock);
  for (const name of ["AI_API_KEY", "AI_BASE_URL", "AI_MODEL", "AI_PROVIDER", "ALGOSTAGE_EGRESS_ALLOW_HOSTS", "ALGOSTAGE_DISABLE_SERVER_KEY"]) vi.stubEnv(name, "");
  vi.stubEnv("ALGOSTAGE_ALLOW_PRIVATE_BASE_URL", "false");
  for (const method of consoleMethods) vi.spyOn(console, method).mockImplementation(() => {});
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

test("GET 默认关闭；打开后无 Key/掩码，PUT 连坏 JSON 也一律锁定且后续 GET 不变", async () => {
  configureServer("env");
  configureServer("db");
  db.settings.set("theme", "dark");
  const initial = await (await GET()).json();
  expect(initial).toMatchObject({ serverKeyDisabled: false, keySource: "settings", envConfigured: true });
  expect(initial.settings.apiKeyMasked).toBe("••••5678");
  vi.stubEnv("ALGOSTAGE_DISABLE_SERVER_KEY", "true");
  db.settings.set("apiKeyMasked", "stale-mask");
  const before = await (await GET()).json();
  expect(before).toMatchObject({ serverKeyDisabled: true, keySource: "none" });
  expect(before.settings).not.toHaveProperty("apiKey");
  expect(before.settings).not.toHaveProperty("apiKeyMasked");
  for (const req of [
    request({ settings: { apiKey: sentinel, model: "changed", baseURL: customURL } }),
    request({ settings: { theme: "light" } }), request(null),
    new NextRequest("http://localhost/api/settings", { method: "PUT", body: "{bad" }),
  ]) {
    const response = await PUT(req);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ code: "SETTINGS_LOCKED", error: "SETTINGS_LOCKED", message: "公共实例不支持修改服务器设置" });
    expect(await (await GET()).json()).toEqual(before);
    expect(req.url).not.toContain(sentinel);
  }
  const getBodies = JSON.stringify([initial, before, await (await GET()).json()]);
  for (const key of [sentinel, serverKeys.env, serverKeys.db, "stale-mask"]) expect(getBodies).not.toContain(key);
  for (const spy of db.writes) expect(spy).not.toHaveBeenCalled();
  expect(db.prisma.$transaction).not.toHaveBeenCalled();
  expect(dns).not.toHaveBeenCalled();
  expect(fetchMock).not.toHaveBeenCalled();
  assertNoPersistenceOrLogs();
});

describe.each(entries)("$name", ({ POST, accept }) => {
  describe.each(["env", "db"] as const)("server key=%s", source => {
    test.each(["false", "true"])("switch=%s：不同地址不带 Key 返回 BYOK_KEY_REQUIRED，零出站", async mode => {
      configureServer(source);
      vi.stubEnv("ALGOSTAGE_DISABLE_SERVER_KEY", mode);
      for (const baseURL of [customURL, "https://server.example/other/v1"]) {
        for (const apiKey of [undefined, "", "  "]) {
          const response = await POST(request({ slug: "two-sum", level: 1, byok: { baseURL, apiKey } }, accept));
          expect(response.status).toBe(400);
          expect(await response.json()).toEqual({ code: "BYOK_KEY_REQUIRED", error: "BYOK_KEY_REQUIRED", message: "用自定义接口地址时，需要同时填你自己的 API Key" });
        }
      }
      expect(fetchMock).not.toHaveBeenCalled();
      expect(dns).not.toHaveBeenCalled();
      expect(db.prisma.lectureScriptCache.findUnique).not.toHaveBeenCalled();
      for (const spy of db.writes) expect(spy).not.toHaveBeenCalled();
    });

    test.each(["false", "true"])("switch=%s：新地址仅发送请求 Key，model 可省略", async mode => {
      configureServer(source);
      vi.stubEnv("ALGOSTAGE_DISABLE_SERVER_KEY", mode);
      const response = await POST(request({ slug: "two-sum", level: 1, byok: { apiKey: sentinel, baseURL: customURL } }, accept));
      expect(response.status).toBe(200);
      expect(await response.text()).not.toContain(sentinel);
      expect(fetchMock).toHaveBeenCalled();
      for (const [url, init] of fetchMock.mock.calls) {
        expect(String(url)).toBe(`${customURL}/chat/completions`);
        expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${sentinel}`);
        expect(JSON.parse(String(init?.body)).model).toBe("server-model");
      }
      assertNoPersistenceOrLogs();
    });

    test("开关关闭：规范化后相同地址不带 Key 仍使用原服务端 Key", async () => {
      configureServer(source);
      const response = await POST(request({ slug: "two-sum", level: 1, byok: { baseURL: " HTTPS://SERVER.EXAMPLE:443/v1/v1/// ", model: "request-model" } }, accept));
      expect(response.status).toBe(200);
      await response.text();
      expect(fetchMock).toHaveBeenCalled();
      for (const [url, init] of fetchMock.mock.calls) {
        expect(String(url)).toBe(`${serverURL}/chat/completions`);
        expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${serverKeys[source]}`);
        expect(JSON.parse(String(init?.body)).model).toBe("request-model");
      }
    });

    test("开关打开：缺少请求 Key 返回 NO_BYOK，不回退也不读讲课缓存", async () => {
      configureServer(source);
      vi.stubEnv("ALGOSTAGE_DISABLE_SERVER_KEY", "true");
      db.prisma.lectureScriptCache.findUnique.mockResolvedValue({ script: "{}" });
      for (const byok of [undefined, null, {}, { model: "override" }, { apiKey: "  " }, { baseURL: serverURL }]) {
        const response = await POST(request({ slug: "two-sum", level: 1, byok }, accept));
        expect(response.status).toBe(400);
        expect((await response.json()).error).toBe("NO_BYOK");
      }
      expect(resolveSavedByok(Object.fromEntries(db.settings))).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(dns).not.toHaveBeenCalled();
      expect(db.prisma.lectureScriptCache.findUnique).not.toHaveBeenCalled();
    });
  });

  test("开关打开：仅请求 Key 使用服务器地址和默认模型，不写设置", async () => {
    configureServer("env");
    vi.stubEnv("ALGOSTAGE_DISABLE_SERVER_KEY", "true");
    const response = await POST(request({ slug: "two-sum", level: 1, byok: { apiKey: sentinel } }, accept));
    expect(response.status).toBe(200);
    await response.text();
    expect(fetchMock.mock.lastCall![0]).toBe(`${serverURL}/chat/completions`);
    expect(new Headers(fetchMock.mock.lastCall![1]?.headers).get("authorization")).toBe(`Bearer ${sentinel}`);
    expect(db.prisma.setting.upsert).not.toHaveBeenCalled();
    assertNoPersistenceOrLogs();
  });

  test.each(["false", "true"])("switch=%s：非法和私网 byok 地址返回 400（包括 DNS），不读缓存", async mode => {
    configureServer("db");
    vi.stubEnv("ALGOSTAGE_DISABLE_SERVER_KEY", mode);
    dns.mockResolvedValue([{ address: "10.0.0.1", family: 4 }]);
    for (const baseURL of ["invalid", "file:///etc/passwd", "http://127.1/v1", "http://[::1]/v1", customURL, 42, null]) {
      const response = await POST(request({ slug: "two-sum", level: 1, byok: { apiKey: sentinel, baseURL } }, accept));
      expect(response.status).toBe(400);
      const malformed = typeof baseURL !== "string" || !/^https?:\/\//.test(baseURL);
      expect(await response.json()).toMatchObject(malformed
        ? { code: "BASE_URL_INVALID", error: "BASE_URL_INVALID", message: "接口地址格式不对，要以 http:// 或 https:// 开头" }
        : { code: "BASE_URL_NOT_ALLOWED", error: "BASE_URL_NOT_ALLOWED", message: expect.stringContaining("只支持公网 http(s) 地址") });
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.prisma.lectureScriptCache.findUnique).not.toHaveBeenCalled();
  });

  test.each(["success", "401", "403", "500", "exception", "malformed body"])("A5：%s 时请求 Key 不进入任何 DB 写入、缓存、日志、URL 或错误响应", async scenario => {
    configureServer("env");
    configureServer("db");
    vi.stubEnv("ALGOSTAGE_DISABLE_SERVER_KEY", "true");
    const previous = [...db.settings];
    if (scenario === "exception") fetchMock.mockRejectedValue(new Error(`connect failed: ${sentinel}`, { cause: new Error(sentinel) }));
    else if (scenario === "malformed body") fetchMock.mockImplementation(async () => new Response(`malformed ${sentinel}`));
    else if (scenario !== "success") fetchMock.mockImplementation(async () => Response.json({ error: { message: `upstream echoed ${sentinel}`, stack: `Error: ${sentinel}\n at internal:1:1` } }, { status: Number(scenario) }));
    const req = request({ slug: "two-sum", level: 1, byok: { apiKey: sentinel, baseURL: customURL, model: "request-model" } }, accept);
    const response = await POST(req);
    const auth = scenario === "401" || scenario === "403";
    expect(response.status).toBe(scenario === "success" ? 200 : auth ? 400 : 502);
    const responseBody = await response.text();
    expect(responseBody).not.toContain(sentinel);
    if (scenario !== "success") expect(JSON.parse(responseBody)).toEqual(auth
      ? { code: "UPSTREAM_AUTH", error: "UPSTREAM_AUTH", retryable: false, message: "API Key 无效或没有权限" }
      : { code: "UPSTREAM_ERROR", error: "UPSTREAM_ERROR", retryable: true, message: AI_CONNECTION_ERROR });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(fetchMock).toHaveBeenCalled();
    expect(req.url).not.toContain(sentinel);
    for (const [, init] of fetchMock.mock.calls) expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${sentinel}`);
    expect(db.prisma.lectureScriptCache.upsert).toHaveBeenCalledTimes(POST === lecture && scenario === "success" ? 1 : 0);
    for (const spy of db.writes.filter(spy => spy !== db.prisma.lectureScriptCache.upsert)) expect(spy).not.toHaveBeenCalled();
    expect([...db.settings]).toEqual(previous);
    const getBody = await (await GET()).text();
    for (const key of [sentinel, ...Object.values(serverKeys)]) expect(getBody).not.toContain(key);
    assertNoPersistenceOrLogs();
  });

  test("A5：200 响应回显 Key 也不写讲课缓存、不流式透传、不打印", async () => {
    vi.stubEnv("ALGOSTAGE_DISABLE_SERVER_KEY", "true");
    fetchMock.mockImplementation(async (_input, init) => {
      if (POST === lecture) return mockAIResponse(init, [
        { name: "add_step", input: { id: "s1", narration: sentinel, target: { kind: "code-line", start: 1 } } },
        { name: "finish", input: {} },
      ]);
      const payload = await mockAIResponse(init).json();
      payload.choices[0].message.content = sentinel;
      return Response.json(payload);
    });
    const response = await POST(request({ slug: "two-sum", level: 1, byok: { apiKey: sentinel, baseURL: customURL } }, accept));
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await response.text()).not.toContain(sentinel);
    for (const spy of db.writes) expect(spy).not.toHaveBeenCalled();
    assertNoPersistenceOrLogs();
  });
});

test("保存完整凭据仅做 DNS 检查；仅显式测试连接调用模型，开关打开也绝不借用服务器 Key", async () => {
  const byok = { apiKey: sentinel, baseURL: customURL, model: "test-model", provider: "openai-compatible" };
  fetchMock.mockRejectedValue(new Error("must not probe on save"));
  expect((await PUT(request({ settings: byok }))).status).toBe(200);
  expect(dns).toHaveBeenCalledTimes(1);
  expect(fetchMock).not.toHaveBeenCalled();
  expect(db.settings.get("apiKey")).toBe(sentinel); // Explicit settings save is allowed only with switch off.
  db.settings.clear();
  configureServer("db");
  vi.clearAllMocks();
  fetchMock.mockImplementation(async (_input, init) => mockAIResponse(init));
  vi.stubEnv("ALGOSTAGE_DISABLE_SERVER_KEY", "true");
  expect((await testConnection(request({}))).status).toBe(400);
  expect(fetchMock).not.toHaveBeenCalled();
  const required = await testConnection(request({ byok: { baseURL: customURL } }));
  expect((await required.json()).code).toBe("BYOK_KEY_REQUIRED");
  expect(fetchMock).not.toHaveBeenCalled();
  expect((await testConnection(request({ byok }))).status).toBe(200);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(new Headers(fetchMock.mock.lastCall![1]?.headers).get("authorization")).toBe(`Bearer ${sentinel}`);
  for (const spy of db.writes) expect(spy).not.toHaveBeenCalled();
  assertNoPersistenceOrLogs();
});

test("数据库 Key 解析后修改目的地址也会在创建模型前拒绝", () => {
  configureServer("db");
  const resolved = resolveSavedByok(Object.fromEntries(db.settings))!;
  resolved.config.baseURL = customURL;
  expect(() => createModel(resolved.config)).toThrow(ByokConfigurationError);
  expect(fetchMock).not.toHaveBeenCalled();
});
