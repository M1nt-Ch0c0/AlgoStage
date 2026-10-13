import { lookup } from "node:dns/promises";
import type { LookupAddress, LookupAllOptions } from "node:dns";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { POST as hint } from "../app/api/hint/route";
import { POST as lecture } from "../app/api/lecture/route";
import { POST as judge } from "../app/api/judge/route";
import { GET, PUT } from "../app/api/settings/route";
import { POST as testConnection } from "../app/api/settings/test-connection/route";
import { AI_CONNECTION_ERROR, INVALID_AI_BASE_URL } from "../lib/ai/egress-guard";
import { mockAIResponse } from "./support/mock-ai-response";

const db = vi.hoisted(() => {
  const settings = new Map<string, string>();
  const setting = {
    findMany: vi.fn(async () => Array.from(settings, ([key, value]) => ({ key, value }))),
    upsert: vi.fn(async ({ create }: { create: { key: string; value: string } }) => { settings.set(create.key, create.value); }),
  };
  const lectureScriptCache = { findUnique: vi.fn(async () => null), upsert: vi.fn(), delete: vi.fn() };
  const transaction = { setting, lectureScriptCache };
  return { settings, prisma: { ...transaction, $transaction: vi.fn(async (run: (tx: typeof transaction) => Promise<unknown>) => run(transaction)) } };
});
vi.mock("@/lib/db/prisma", () => ({ prisma: db.prisma }));
vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));

const dns = vi.mocked(lookup as (host: string, options: LookupAllOptions) => Promise<LookupAddress[]>);
const fetchMock = vi.fn<typeof fetch>();
const byok = { provider: "openai-compatible", model: "test-model", apiKey: "test-only-credential", baseURL: "https://ai.example/v1" };
const invalidURLs = ["invalid-url", "//example.com/v1", "ftp://example.com/v1", "file:///tmp/model", "data:text/plain,model", "javascript:alert(1)", "https://", "http:/example.com", "http://[:::]"];

function request(body: unknown, accept = "application/json") {
  return new NextRequest("http://localhost/api/test", {
    method: "POST", headers: { "Content-Type": "application/json", accept }, body: JSON.stringify(body),
  });
}
const entries = [
  { name: "hint", POST: hint, accept: "application/json" },
  { name: "lecture JSON", POST: lecture, accept: "application/json" },
  { name: "lecture NDJSON", POST: lecture, accept: "application/x-ndjson" },
];
beforeEach(() => {
  vi.clearAllMocks();
  db.settings.clear();
  dns.mockReset().mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
  fetchMock.mockReset().mockImplementation(async (_input, init) => mockAIResponse(init));
  vi.stubGlobal("fetch", fetchMock);
  for (const name of ["AI_API_KEY", "AI_BASE_URL", "AI_PROVIDER", "AI_MODEL"]) vi.stubEnv(name, "");
  vi.stubEnv("ALGOSTAGE_ALLOW_PRIVATE_BASE_URL", "false");
  vi.stubEnv("ALGOSTAGE_EGRESS_ALLOW_HOSTS", "");
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("settings PUT", () => {
  test.each(invalidURLs)("拒绝 %s，400 中文错误且零写入", async baseURL => {
    const response = await PUT(request({ settings: { model: "changed", baseURL } }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "BASE_URL_NOT_ALLOWED", message: INVALID_AI_BASE_URL });
    expect(db.prisma.$transaction).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(dns).not.toHaveBeenCalled();
  });
  test.each([
    [" https://ai.example/v1/v1/v1/// ", "https://ai.example/v1"], ["", ""], ["  ", ""],
  ])("保存规范化地址 %s，空地址使用默认服务商", async (baseURL, normalized) => {
    expect((await PUT(request({ settings: { ...byok, baseURL } }))).status).toBe(200);
    expect(db.settings.get("baseURL")).toBe(normalized);
    expect(dns).toHaveBeenCalledTimes(baseURL.trim() ? 2 : 0);
    expect(fetchMock).toHaveBeenCalledTimes(baseURL.trim() ? 1 : 0);
  });
});

describe.each(entries)("$name", ({ POST, accept }) => {
  test.each(invalidURLs)("请求 byok 拒绝 %s，固定 502", async baseURL => {
    const response = await POST(request({ slug: "two-sum", level: 1, byok: { ...byok, baseURL } }, accept));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "UPSTREAM_ERROR", message: AI_CONNECTION_ERROR });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(dns).not.toHaveBeenCalled();
  });

  test("不完整 byok 的坏地址也不能被已保存配置掩盖", async () => {
    for (const [key, value] of Object.entries(byok)) db.settings.set(key, value);
    const response = await POST(request({ slug: "two-sum", level: 1, byok: { baseURL: "file:///tmp/model" } }, accept));
    expect(response.status).toBe(502);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test.each(["http://127.1/v1", "http://2130706433/v1", "http://[::ffff:7f00:1]/v1", "http://a.localhost/v1"])("私网地址 %s 返回固定 502", async baseURL => {
    const response = await POST(request({ slug: "two-sum", level: 1, byok: { ...byok, baseURL } }, accept));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "UPSTREAM_ERROR", message: AI_CONNECTION_ERROR });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.prisma.lectureScriptCache.upsert).not.toHaveBeenCalled();
  });

  test("DNS 混合公网和私网时拒绝且不调用 fetch", async () => {
    dns.mockResolvedValue([{ address: "8.8.8.8", family: 4 }, { address: "fd00::1", family: 6 }]);
    const response = await POST(request({ slug: "two-sum", level: 1, byok }, accept));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "UPSTREAM_ERROR", message: AI_CONNECTION_ERROR });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test.each([301, 302, 303, 307, 308])("重定向 %i 返回固定 502 且不跟随", async status => {
    fetchMock.mockImplementation(async () => new Response("upstream-private-details", { status, headers: { location: "http://127.0.0.1/private" } }));
    const response = await POST(request({ slug: "two-sum", level: 1, byok }, accept));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "UPSTREAM_ERROR", message: AI_CONNECTION_ERROR });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.lastCall![1]?.redirect).toBe("manual");
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain("upstream-private-details");
  });

  test.each(["DNS", "fetch"])("%s 故障不透出内部异常", async source => {
    const error = new Error("internal-private-details");
    if (source === "DNS") dns.mockRejectedValue(error);
    else fetchMock.mockRejectedValue(error);
    const response = await POST(request({ slug: "two-sum", level: 1, byok }, accept));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "UPSTREAM_ERROR", message: AI_CONNECTION_ERROR });
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain("internal-private-details");
  });

  test.each([400, 401, 403, 500])("上游 %i 仅按状态分类，不透出正文", async status => {
    fetchMock.mockImplementation(async () => Response.json({ error: { message: "untrusted-private-details" } }, { status }));
    const response = await POST(request({ slug: "two-sum", level: 1, byok }, accept));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "UPSTREAM_ERROR", message: [401, 403].includes(status) ? "Key 无效或没有权限，请检查设置。" : AI_CONNECTION_ERROR });
    expect(fetchMock).toHaveBeenCalledTimes(status === 500 ? 2 : 1);
  });

  test("规范化路径后仍可完成提示或讲课", async () => {
    const response = await POST(request({ slug: "two-sum", level: 1, byok: { ...byok, baseURL: " https://ai.example/v1/v1/v1/// " } }, accept));
    expect(response.status).toBe(200);
    await response.text();
    expect(fetchMock).toHaveBeenCalled();
    for (const [input, init] of fetchMock.mock.calls) {
      expect(String(input)).toBe("https://ai.example/v1/chat/completions");
      expect(init).toMatchObject({ redirect: "manual", dispatcher: expect.anything() });
    }
  });
});

test.each(["settings", "env"])("%s 中的接口同样必须经过 DNS 和地址校验", async source => {
  if (source === "settings") {
    for (const [key, value] of Object.entries({ ...byok, baseURL: "http://127.1/v1" })) db.settings.set(key, value);
  } else {
    vi.stubEnv("AI_API_KEY", "env-fixture-only");
    vi.stubEnv("AI_BASE_URL", "http://127.1/v1");
  }
  for (const POST of [hint, lecture]) {
    const response = await POST(request({ slug: "two-sum", level: 1 }));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "UPSTREAM_ERROR", message: AI_CONNECTION_ERROR });
  }
  expect(fetchMock).not.toHaveBeenCalled();
});

test.each(["settings", "env"])("%s 中遗留的非法 URL 也返回固定 502", async source => {
  if (source === "settings") {
    for (const [key, value] of Object.entries({ ...byok, baseURL: "ftp://ai.example" })) db.settings.set(key, value);
  } else {
    vi.stubEnv("AI_API_KEY", "env-fixture-only");
    vi.stubEnv("AI_BASE_URL", "ftp://ai.example");
  }
  for (const { POST, accept } of entries) {
    const response = await POST(request({ slug: "two-sum", level: 1 }, accept));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "UPSTREAM_ERROR", message: AI_CONNECTION_ERROR });
  }
  expect(fetchMock).not.toHaveBeenCalled();
  expect(dns).not.toHaveBeenCalled();
});

test("环境地址规范化后仍通过凭据来源校验", async () => {
  vi.stubEnv("AI_API_KEY", "env-fixture-only");
  vi.stubEnv("AI_BASE_URL", " https://ai.example/v1/v1/// ");
  expect((await hint(request({ slug: "two-sum", level: 1 }))).status).toBe(200);
  expect(fetchMock.mock.lastCall![0]).toBe("https://ai.example/v1/chat/completions");
});

test.each([
  ["openai-compatible", "api.openai.com"], ["anthropic", "api.anthropic.com"], ["google", "generativelanguage.googleapis.com"],
])("%s SDK 默认/自定义地址全部注入防护 fetch", async (provider, defaultHost) => {
  fetchMock.mockImplementation(async () => new Response(null, { status: 401 }));
  for (const baseURL of ["", "   ", "https://ai.example/v1/v1///"]) {
    const response = await hint(request({ slug: "two-sum", level: 1, byok: { ...byok, provider, baseURL } }));
    expect(response.status).toBe(502);
    expect((await response.json()).message).toBe("Key 无效或没有权限，请检查设置。");
    const [input, init] = fetchMock.mock.lastCall!;
    expect(new URL(String(input)).hostname).toBe(baseURL.trim() ? "ai.example" : defaultHost);
    expect(String(input)).not.toContain("/v1/v1");
    expect(init).toMatchObject({ redirect: "manual", dispatcher: expect.anything() });
  }
  expect(dns).toHaveBeenCalledTimes(3);
  fetchMock.mockClear();
  const blocked = await hint(request({ slug: "two-sum", level: 1, byok: { ...byok, provider, baseURL: "http://[::1]/v1" } }));
  expect(blocked.status).toBe(502);
  expect((await blocked.json()).message).toBe(AI_CONNECTION_ERROR);
  expect(fetchMock).not.toHaveBeenCalled();
});

test("允许私网时本地模型正常工作，仍禁止重定向", async () => {
  vi.stubEnv("ALGOSTAGE_ALLOW_PRIVATE_BASE_URL", "true");
  const input = { slug: "two-sum", level: 1, byok: { ...byok, baseURL: "http://127.1/v1" } };
  expect((await hint(request(input))).status).toBe(200);
  fetchMock.mockImplementation(async () => new Response(null, { status: 302, headers: { location: "http://localhost/private" } }));
  expect((await hint(request(input))).status).toBe(502);
});

test("讲课流已经输出步骤后遇到重定向，通过固定 502 错误事件终止且不缓存", async () => {
  fetchMock.mockImplementationOnce(async (_input, init) => mockAIResponse(init, [
    { name: "add_step", input: { id: "s1", narration: "讲解", target: { kind: "code-line", start: 1 } } },
  ])).mockImplementation(async () => new Response("untrusted-private-details", { status: 302, headers: { location: "http://127.0.0.1/private" } }));
  const response = await lecture(request({ slug: "two-sum", byok }, "application/x-ndjson"));
  expect(response.status).toBe(200); // Headers are committed after the first step.
  const events = (await response.text()).trim().split("\n").map(line => JSON.parse(line));
  expect(events.some(event => event.type === "step")).toBe(true);
  expect(events.at(-1)).toEqual({ type: "error", error: "UPSTREAM_ERROR", status: 502, message: AI_CONNECTION_ERROR });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(db.prisma.lectureScriptCache.upsert).not.toHaveBeenCalled();
});

test("judge 无 AI 出站，严格拒绝额外的 byok/endpoint 字段", async () => {
  for (const extra of [{ byok: { ...byok, baseURL: "file:///tmp/model" } }, { baseURL: "http://127.1" }, { endpoint: "http://127.1" }]) {
    const response = await judge(request({ problemSlug: "two-sum", language: "typescript", code: "", ...extra }));
    expect(response.status).toBe(400);
  }
  expect(fetchMock).not.toHaveBeenCalled();
});

const settingsEntries = [
  { name: "settings save", run: (settings: Record<string, unknown>) => PUT(request({ settings })) },
  { name: "settings test-connection", run: (byok: Record<string, unknown>) => testConnection(request({ byok })) },
];
const leakPattern = /MOCK_UPSTREAM_SECRET_BODY|CANARY_SECRET|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT|EAI_AGAIN|\bat .+:\d+:\d+\)?|\b(?:\d{1,3}\.){3}\d{1,3}\b|\[?::1\]?|fe80:|fc00:|fd00:|169\.254|metadata/i;
const upstreamSecret = "MOCK_UPSTREAM_SECRET_BODY CANARY_SECRET ECONNREFUSED 10.0.0.1 169.254.169.254/metadata [::1]\n at connect (/internal/server.js:42:1)";

describe.each(settingsEntries)("$name: 校验与原子性", ({ run }) => {
  test.each([...invalidURLs, "http://127.0.0.1/v1", "http://169.254.169.254", "http://[::1]/v1", "https://private.example/v1"])("拒绝 %s 且已有设置完全不变", async baseURL => {
    db.settings.set("model", "original");
    db.settings.set("baseURL", "https://previous.example/v1");
    const previous = await (await GET()).json();
    dns.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    const response = await run({ ...byok, baseURL });
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ error: "BASE_URL_NOT_ALLOWED", message: INVALID_AI_BASE_URL });
    expect(text).toContain("只支持公网 http(s) 地址");
    expect(text).not.toMatch(leakPattern);
    expect(await (await GET()).json()).toEqual(previous);
    expect(db.prisma.$transaction).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("多记录域名任一 A/AAAA 为私网则拒绝", async () => {
    dns.mockResolvedValue([{ address: "8.8.8.8", family: 4 }, { address: "fd00::1", family: 6 }]);
    expect((await run(byok)).status).toBe(400);
    expect(db.prisma.$transaction).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("预校验后 DNS 重绑定为私网，连接前再次校验并拒绝", async () => {
    dns.mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }])
      .mockResolvedValueOnce([{ address: "10.0.0.1", family: 4 }]);
    const response = await run(byok);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "BASE_URL_NOT_ALLOWED", message: INVALID_AI_BASE_URL });
    expect(dns).toHaveBeenCalledTimes(2);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.prisma.$transaction).not.toHaveBeenCalled();
  });

  test.each(["DNS", "connection", "500", "redirect"])("%s 失败只返回固定 502 且不保存", async kind => {
    if (kind === "DNS") dns.mockRejectedValue(new Error(upstreamSecret));
    else if (kind === "connection") fetchMock.mockRejectedValue(new Error(upstreamSecret));
    else fetchMock.mockImplementation(async () => new Response(upstreamSecret, {
      status: kind === "500" ? 500 : 302,
      headers: { location: "http://169.254.169.254/metadata" },
    }));
    const response = await run(byok);
    expect(response.status).toBe(502);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ error: "UPSTREAM_ERROR", message: AI_CONNECTION_ERROR });
    expect(text).not.toMatch(leakPattern);
    expect(db.prisma.$transaction).not.toHaveBeenCalled();
    expect(db.settings.size).toBe(0);
    if (kind !== "DNS") expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("精确白名单可用，但 userinfo/非白名单同 IP 不可用", async () => {
    vi.stubEnv("ALGOSTAGE_EGRESS_ALLOW_HOSTS", "CPA-DIRECT.M1NTCH0C0.COM.,*.example");
    dns.mockResolvedValue([{ address: "10.0.0.1", family: 4 }]);
    expect((await run({ ...byok, baseURL: "https://cpa-direct.m1ntch0c0.com/v1" })).status).toBe(200);
    fetchMock.mockClear();
    for (const baseURL of ["https://other.example/v1", "https://sub.cpa-direct.m1ntch0c0.com/v1", "https://cpa-direct.m1ntch0c0.com@10.0.0.1/v1"]) {
      const response = await run({ ...byok, baseURL });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "BASE_URL_NOT_ALLOWED", message: INVALID_AI_BASE_URL });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

test("settings 测试校验未带新 Key 的编辑地址，且不向不同目标发送保存/环境 Key", async () => {
  for (const [key, value] of Object.entries(byok)) db.settings.set(key, value);
  for (const baseURL of ["http://127.1/v1", "file:///tmp/model"]) {
    expect((await testConnection(request({ byok: { baseURL } }))).status).toBe(400);
  }
  const response = await testConnection(request({ byok: { baseURL: "https://another.example/v1" } }));
  expect(response.status).toBe(400);
  expect((await response.json()).error).toBe("BYOK_KEY_REQUIRED");
  expect(fetchMock).not.toHaveBeenCalled();
  expect((await testConnection(request({}))).status).toBe(200);
  expect(fetchMock.mock.lastCall![0]).toBe("https://ai.example/v1/chat/completions");
});

test("settings 拒绝后不落库，不带 byok 的 hint 不能使用被拒地址", async () => {
  expect((await PUT(request({ settings: { ...byok, baseURL: "http://127.1/v1" } }))).status).toBe(400);
  expect((await (await GET()).json()).settings.baseURL).toBeUndefined();
  expect((await hint(request({ slug: "group-anagrams", level: 1 }))).status).toBe(400);
  expect(fetchMock).not.toHaveBeenCalled();
});

test("保存后 DNS 从公网变私网，已保存设置路径仍返回固定 502", async () => {
  expect((await PUT(request({ settings: byok }))).status).toBe(200);
  fetchMock.mockClear();
  dns.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
  for (const POST of [hint, lecture]) {
    const response = await POST(request({ slug: "group-anagrams", level: 1, regenerate: true }));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "UPSTREAM_ERROR", message: AI_CONNECTION_ERROR });
  }
  expect(fetchMock).not.toHaveBeenCalled();
});

describe.each([undefined, "true"])("Riley 矩阵：switch=%s（全内存 DNS/HTTP）", mode => {
  test.each([
    "http://127.0.0.1:3396/v1", "http://example.com@127.0.0.1:3396/v1",
    "http://127.0.0.1.nip.io:3396/v1", "http://localtest.me:3396/v1", "http://127.0.0.1:3396/v1/v1/",
  ])("%s 在 hint、lecture regenerate、保存再使用路径可用", async baseURL => {
    vi.stubEnv("ALGOSTAGE_ALLOW_PRIVATE_BASE_URL", mode);
    dns.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    const config = { ...byok, baseURL };
    for (const POST of [hint, lecture]) {
      const response = await POST(request({ slug: "group-anagrams", level: 1, regenerate: true, byok: config }));
      expect(response.status).toBe(200);
      expect(await response.text()).not.toMatch(leakPattern);
    }
    expect(db.prisma.lectureScriptCache.findUnique).not.toHaveBeenCalled();
    expect((await PUT(request({ settings: config }))).status).toBe(200);
    expect((await hint(request({ slug: "group-anagrams", level: 1 }))).status).toBe(200);
    for (const [input, init] of fetchMock.mock.calls) {
      const target = new URL(String(input));
      expect(target.pathname).toBe("/v1/chat/completions");
      expect(target.username).toBe("");
      expect(init).toMatchObject({ redirect: "manual", dispatcher: expect.anything() });
    }
  });

  test.each(["500", "redirect"])("%s 三个入口固定 502，绝不透传上游正文或跟随跳转", async kind => {
    vi.stubEnv("ALGOSTAGE_ALLOW_PRIVATE_BASE_URL", mode);
    fetchMock.mockImplementation(async () => new Response(upstreamSecret, {
      status: kind === "500" ? 500 : 302, headers: { location: "http://169.254.169.254/metadata" },
    }));
    const config = { ...byok, baseURL: "http://127.0.0.1:3396/err/v1" };
    const responses = [
      await hint(request({ slug: "group-anagrams", level: 1, byok: config })),
      await lecture(request({ slug: "group-anagrams", regenerate: true, byok: config })),
      await PUT(request({ settings: config })),
    ];
    for (const response of responses) {
      expect(response.status).toBe(502);
      const text = await response.text();
      expect(JSON.parse(text)).toEqual({ error: "UPSTREAM_ERROR", message: AI_CONNECTION_ERROR });
      expect(text).not.toMatch(leakPattern);
    }
    expect(fetchMock).toHaveBeenCalledTimes(kind === "500" ? 5 : 3);
    expect(fetchMock.mock.calls.every(([input, init]) => String(input) === "http://127.0.0.1:3396/err/v1/chat/completions" && init?.redirect === "manual")).toBe(true);
    expect(db.settings.size).toBe(0);
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toMatch(leakPattern);
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toMatch(leakPattern);
  });
});
