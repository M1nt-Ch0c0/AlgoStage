import { lookup } from "node:dns/promises";
import type { LookupAddress, LookupAllOptions } from "node:dns";
import type { LookupFunction } from "node:net";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AI_CONNECTION_ERROR, AIEgressError, INVALID_AI_BASE_URL, aiEgressFetch, normalizeAIBaseURL } from "../lib/ai/egress-guard";

const agents = vi.hoisted(() => ({ create: vi.fn(), close: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));
vi.mock("undici", () => ({ Agent: class {
  constructor(readonly options: unknown) { agents.create(options); }
  close() { return agents.close(); }
} }));

const dns = vi.mocked(lookup as (host: string, options: LookupAllOptions) => Promise<LookupAddress[]>);
const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("ALGOSTAGE_ALLOW_PRIVATE_BASE_URL", "false");
  vi.stubEnv("ALGOSTAGE_EGRESS_ALLOW_HOSTS", "");
  vi.stubGlobal("fetch", fetchMock);
  dns.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
  fetchMock.mockResolvedValue(Response.json({ ok: true }));
  agents.close.mockResolvedValue(undefined);
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

export const blockedHosts = [
  "127.0.0.1", "127.255.255.254", "0.0.0.0", "0.1.2.3",
  "10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.1",
  "100.64.0.1", "100.127.255.255", "169.254.169.254",
  "224.0.0.1", "239.255.255.255", "240.0.0.1", "255.255.255.255",
  "192.0.0.1", "192.0.2.1", "192.88.99.1", "198.18.0.1", "198.19.255.255", "198.51.100.1", "203.0.113.1",
  "2130706433", "0x7f.1", "127.1", "0177.0.0.1", "0x7f000001", "017700000001",
  "127.0.0.1.", "%31%32%37.0.0.1", "0", "0x0", "0300.0250.1.1",
  "[::1]", "[::]", "[fc00::1]", "[fdff:ffff::1]", "[fe80::1]", "[febf::1]", "[fec0::1]", "[ff02::1]",
  "[::ffff:127.0.0.1]", "[::ffff:7f00:1]", "[0:0:0:0:0:ffff:7f00:1]",
  "[::ffff:0.0.0.0]", "[::ffff:10.0.0.1]", "[::ffff:100.64.0.1]", "[::ffff:169.254.1.1]",
  "[::ffff:172.16.0.1]", "[::ffff:192.168.0.1]", "[::ffff:224.0.0.1]", "[::ffff:240.0.0.1]", "[::ffff:255.255.255.255]",
  "[::127.0.0.1]", "[64:ff9b::7f00:1]", "[2002:7f00:1::]", "[2001::1]", "[2001:2::1]", "[2001:db8::1]", "[3fff::1]",
  "localhost", "localhost.", "LOCALHOST", "nested.localhost", "a.b.localhost.",
];

describe("地址策略", () => {
  test.each(blockedHosts)("false 阻止 %s，且不调用 fetch", async host => {
    await expect(aiEgressFetch(`http://${host}/v1`)).rejects.toThrow(AI_CONNECTION_ERROR);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(dns).not.toHaveBeenCalled();
  });

  test.each(blockedHosts)("true 允许自托管地址 %s", async host => {
    vi.stubEnv("ALGOSTAGE_ALLOW_PRIVATE_BASE_URL", "true");
    dns.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    expect((await aiEgressFetch(`http://${host}/v1`)).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  test.each([undefined, "", "true", "TRUE"])("开关 %s 默认允许本地模型", async value => {
    vi.stubEnv("ALGOSTAGE_ALLOW_PRIVATE_BASE_URL", value);
    expect((await aiEgressFetch("http://127.1:11434/v1")).ok).toBe(true);
  });

  test.each(["1.1.1.1", "8.8.8.8", "100.63.255.255", "100.128.0.0", "172.15.255.255", "172.32.0.0", "223.255.255.254", "[2606:4700:4700::1111]", "[2001:4860:4860::8888]", "[::ffff:8.8.8.8]"])("false 允许公网地址 %s", async host => {
    expect((await aiEgressFetch(`https://${host}/v1`)).ok).toBe(true);
  });
});

test.each(["invalid-url", "example.com/v1", "//example.com", "ftp://example.com", "file:///etc/passwd", "data:text/plain,hello", "javascript:alert(1)", "https://", "https:///", "https:///example.com", "https:/example.com", "http://[:::]"])("URL 语法拒绝 %s", value => {
  expect(() => normalizeAIBaseURL(value)).toThrow(INVALID_AI_BASE_URL);
});

test.each([
  ["", ""], ["   ", ""], [" https://EXAMPLE.com/v1/v1/v1///  ", "https://example.com/v1"],
  ["https://example.com/", "https://example.com"], ["http://0x7f.1/v1/", "http://127.0.0.1/v1"],
  ["https://example.com/proxy/v1/v1/other/v1/v1", "https://example.com/proxy/v1/other/v1"],
  ["https://example.com/v1/v10", "https://example.com/v1/v10"],
  ["https://user:pass@example.com/v1/v1/", "https://example.com/v1"],
  ["http://example.com@127.0.0.1:3396/v1/v1/", "http://127.0.0.1:3396/v1"],
])("URL 规范化 %s", (input, expected) => { expect(normalizeAIBaseURL(input)).toBe(expected); });

function pinnedLookup(options: { all?: boolean } = {}) {
  const { dispatcher } = fetchMock.mock.lastCall![1] as RequestInit & {
    dispatcher: { options: { connect: { lookup: LookupFunction; servername: string } } };
  };
  const connect = dispatcher.options.connect;
  const callback = vi.fn();
  connect.lookup("ai.example", options, callback);
  return { connect, callback };
}

test("DNS 重绑定：校验公网后固定 IP，连接重试不解析第二次；新请求看到私网即拒绝", async () => {
  dns.mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }])
    .mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);
  await aiEgressFetch("https://ai.example:8443/v1");
  expect(dns).toHaveBeenCalledExactlyOnceWith("ai.example", { all: true });
  expect(pinnedLookup().callback).toHaveBeenCalledWith(null, "8.8.8.8", 4);
  expect(pinnedLookup({ all: true }).callback).toHaveBeenCalledWith(null, [{ address: "8.8.8.8", family: 4 }]);
  expect(pinnedLookup().callback).toHaveBeenCalledWith(null, "8.8.8.8", 4);
  expect(pinnedLookup().connect.servername).toBe("ai.example");
  expect(dns).toHaveBeenCalledTimes(1);
  expect(fetchMock).toHaveBeenCalledWith("https://ai.example:8443/v1", expect.objectContaining({ redirect: "manual", dispatcher: expect.anything() }));
  await expect(aiEgressFetch("https://ai.example:8443/v1")).rejects.toThrow(AIEgressError);
  expect(dns).toHaveBeenCalledTimes(2);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  // Even after DNS has returned the private answer, the dispatched connection
  // and its retries can only receive the first validated public address.
  for (const all of [false, true]) {
    const calls = pinnedLookup({ all }).callback.mock.calls;
    expect(JSON.stringify(calls)).toContain("8.8.8.8");
    expect(JSON.stringify(calls)).not.toContain("127.0.0.1");
  }
});

describe("精确主机白名单", () => {
  test.each([
    ["cpa-direct.m1ntch0c0.com", "cpa-direct.m1ntch0c0.com"],
    ["  unused.example,CPA-DIRECT.M1NTCH0C0.COM. , ", "CpA-DiReCt.m1ntch0c0.com"],
    ["cpa-direct.m1ntch0c0.com", "CPA-DIRECT.M1NTCH0C0.COM."],
  ])("%s 精确匹配 %s，false 仍可连接且固定私网 DNS", async (allowlist, hostname) => {
    vi.stubEnv("ALGOSTAGE_EGRESS_ALLOW_HOSTS", allowlist);
    dns.mockResolvedValueOnce([{ address: "10.0.0.7", family: 4 }])
      .mockResolvedValueOnce([{ address: "10.0.0.9", family: 4 }]);
    expect((await aiEgressFetch(`https://${hostname}/v1`)).ok).toBe(true);
    expect(pinnedLookup().callback).toHaveBeenCalledWith(null, "10.0.0.7", 4);
    expect(pinnedLookup({ all: true }).callback).toHaveBeenCalledWith(null, [{ address: "10.0.0.7", family: 4 }]);
    expect(dns).toHaveBeenCalledTimes(1);
  });

  test.each(["other.example", "sub.cpa-direct.m1ntch0c0.com", "cpa-direct.m1ntch0c0.com.evil.example"])("相同私网 IP 的非白名单主机 %s 仍拒绝", async hostname => {
    vi.stubEnv("ALGOSTAGE_EGRESS_ALLOW_HOSTS", "cpa-direct.m1ntch0c0.com");
    dns.mockResolvedValue([{ address: "10.0.0.7", family: 4 }]);
    await expect(aiEgressFetch(`https://${hostname}/v1`)).rejects.toThrow(AIEgressError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("userinfo 中的白名单不能绕过 WHATWG hostname 校验", async () => {
    vi.stubEnv("ALGOSTAGE_EGRESS_ALLOW_HOSTS", "cpa-direct.m1ntch0c0.com");
    await expect(aiEgressFetch("https://cpa-direct.m1ntch0c0.com@10.0.0.1/v1")).rejects.toThrow(AIEgressError);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(dns).not.toHaveBeenCalled();
  });

  test.each(["*", "*.m1ntch0c0.com", "cpa-direct.m1ntch0c0.com*", "https://cpa-direct.m1ntch0c0.com", "cpa-direct.m1ntch0c0.com:443"])("通配符或非主机条目 %s 不匹配", async allowlist => {
    vi.stubEnv("ALGOSTAGE_EGRESS_ALLOW_HOSTS", allowlist);
    dns.mockResolvedValue([{ address: "10.0.0.7", family: 4 }]);
    await expect(aiEgressFetch("https://cpa-direct.m1ntch0c0.com/v1")).rejects.toThrow(AIEgressError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("白名单只豁免地址策略，协议与重定向限制不变", async () => {
    vi.stubEnv("ALGOSTAGE_EGRESS_ALLOW_HOSTS", "cpa-direct.m1ntch0c0.com");
    dns.mockResolvedValue([{ address: "10.0.0.7", family: 4 }]);
    await expect(aiEgressFetch("ftp://cpa-direct.m1ntch0c0.com/v1")).rejects.toThrow(AI_CONNECTION_ERROR);
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "http://169.254.169.254/metadata" } }));
    await expect(aiEgressFetch("https://cpa-direct.m1ntch0c0.com/v1")).rejects.toThrow(AI_CONNECTION_ERROR);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.lastCall![1]?.redirect).toBe("manual");
  });
});

test.each([
  [{ address: "8.8.8.8", family: 4 }, { address: "10.0.0.1", family: 4 }],
  [{ address: "8.8.8.8", family: 4 }, { address: "::1", family: 6 }],
  [{ address: "2606:4700:4700::1111", family: 6 }, { address: "::ffff:7f00:1", family: 6 }],
  [{ address: "127.0.0.1", family: 4 }, { address: "8.8.8.8", family: 4 }],
])("任何 A/AAAA 为禁用地址则整体拒绝：%j", async (...addresses) => {
  dns.mockResolvedValue(addresses);
  await expect(aiEgressFetch("https://ai.example")).rejects.toThrow(AIEgressError);
  expect(fetchMock).not.toHaveBeenCalled();
});

test("IPv6 DNS 固定到校验后的 AAAA 地址，true 模式仍固定私网 DNS", async () => {
  for (const [allow, address] of [["false", "2606:4700:4700::1111"], ["true", "fd00::1"]]) {
    vi.stubEnv("ALGOSTAGE_ALLOW_PRIVATE_BASE_URL", allow);
    dns.mockResolvedValue([{ address, family: 6 }]);
    await aiEgressFetch("https://ai.example/v1");
    expect(pinnedLookup().callback).toHaveBeenCalledWith(null, address, 6);
  }
});

test("空/非法 DNS 回答及解析错误安全失败", async () => {
  for (const records of [[], [{ address: "not-an-ip", family: 4 }], [{ address: "8.8.8.8", family: 6 }]]) {
    dns.mockResolvedValueOnce(records);
    await expect(aiEgressFetch("https://ai.example")).rejects.toThrow(AI_CONNECTION_ERROR);
  }
  dns.mockRejectedValueOnce(new Error("internal resolver details"));
  await expect(aiEgressFetch("https://ai.example")).rejects.toThrow(AI_CONNECTION_ERROR);
  expect(fetchMock).not.toHaveBeenCalled();
});

test.each([300, 301, 302, 303, 304, 305, 307, 308, 399])("%i 重定向从不跟随", async status => {
  fetchMock.mockResolvedValueOnce(new Response(null, { status, headers: { location: "http://127.0.0.1/private" } }));
  await expect(aiEgressFetch("https://ai.example", { redirect: "follow" })).rejects.toThrow(AI_CONNECTION_ERROR);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.lastCall![1]?.redirect).toBe("manual");
  expect(agents.close).toHaveBeenCalledOnce();
});

test("连接失败只抛固定文本，清理 Agent，并保留可重试标记", async () => {
  fetchMock.mockRejectedValueOnce(new Error("private connection details"));
  const result = aiEgressFetch("https://ai.example");
  await expect(result).rejects.toMatchObject({ message: AI_CONNECTION_ERROR, retryable: true });
  await expect(result).rejects.not.toHaveProperty("cause");
  expect(agents.close).toHaveBeenCalledOnce();
});

test("非 2xx 只向 SDK 提供状态码，错误体不传入 SDK", async () => {
  fetchMock.mockResolvedValueOnce(new Response("untrusted upstream details", { status: 401 }));
  const response = await aiEgressFetch("https://ai.example");
  expect(response.status).toBe(401);
  expect(await response.text()).toBe("");
});

test("Request 输入转成 URL + init，Next 不会丢弃 dispatcher，保留请求体和响应流", async () => {
  const request = new Request("https://ai.example/v1", { method: "POST", body: "payload", redirect: "follow" });
  let push!: ReadableStreamDefaultController<Uint8Array>;
  fetchMock.mockResolvedValueOnce(new Response(new ReadableStream({ start(controller) { push = controller; } })));
  const response = await aiEgressFetch(request);
  expect(fetchMock).toHaveBeenCalledWith(request.url, expect.objectContaining({ method: "POST", redirect: "manual", cache: "no-store", dispatcher: expect.anything(), duplex: "half" }));
  expect(await new Response(fetchMock.mock.lastCall![1]?.body).text()).toBe("payload");
  push.enqueue(new TextEncoder().encode("first step"));
  push.close();
  expect(await response.text()).toBe("first step");
  expect(agents.close).toHaveBeenCalledOnce();
});

test("DNS 等待时修改调用者 URL 对象，不能换掉已验证的目标", async () => {
  const target = new URL("https://ai.example/v1");
  dns.mockImplementationOnce(async () => {
    target.hostname = "127.0.0.1";
    return [{ address: "8.8.8.8", family: 4 }];
  });
  await aiEgressFetch(target);
  expect(fetchMock.mock.lastCall![0]).toBe("https://ai.example/v1");
  expect(pinnedLookup().connect.servername).toBe("ai.example");
});

test("DNS 等待期间取消后不会发送请求", async () => {
  const abort = new AbortController();
  dns.mockImplementationOnce(async () => {
    abort.abort();
    return [{ address: "8.8.8.8", family: 4 }];
  });
  await expect(aiEgressFetch("https://ai.example", { signal: abort.signal })).rejects.toMatchObject({ name: "AbortError" });
  expect(fetchMock).not.toHaveBeenCalled();
  expect(agents.create).not.toHaveBeenCalled();
});

test("DNS 一直未返回时也能立即取消，迟到的 DNS 结果不会打开连接", async () => {
  const abort = new AbortController();
  let finishDNS!: (addresses: LookupAddress[]) => void;
  dns.mockReturnValueOnce(new Promise(resolve => { finishDNS = resolve; }));
  const pending = aiEgressFetch("https://ai.example", { signal: abort.signal });
  abort.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  finishDNS([{ address: "8.8.8.8", family: 4 }]);
  await Promise.resolve();
  expect(fetchMock).not.toHaveBeenCalled();
  expect(agents.create).not.toHaveBeenCalled();
});
