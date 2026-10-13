/** P2：所有入口在流内/200 正文中识别鉴权失败（Uma、Riley、Quinn 的上游格式）。 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createFixture, request } from "./api-fixture";

const KEY = "fake-midstream-key-xyz";
const chunk = (delta: unknown, finish: string | null = null) =>
  `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const roleOnly = chunk({ role: "assistant", content: "" });
const step1 = chunk({ tool_calls: [{ index: 0, id: "c0", type: "function", function: { name: "add_step", arguments: "" } }] }) +
  chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ id: "s1", narration: "第1步 题意", target: { kind: "statement", blockId: "intro" } }) } }] });
const textChunk = chunk({ content: "提示：" });
const partialStep = chunk({ tool_calls: [{ index: 0, id: "c0", type: "function", function: { name: "add_step", arguments: '{"id":"s1","narr' } }] });

/** 鉴权错误体格式：Uma（数字 code + type）、单独数字 code、单独 type、Riley/Quinn（invalid_api_key）。 */
const bodies: Record<string, unknown> = {
  "uma-type+num401": { error: { message: `invalid key ${KEY}`, type: "authentication_error", code: 401 } },
  "num401-only": { error: { message: `bad ${KEY}`, code: 401 } },
  "type-only": { error: { message: `bad ${KEY}`, type: "authentication_error" } },
  "riley-invalid_api_key": { error: { message: `Incorrect API key provided: ${KEY}`, type: "invalid_request_error", code: "invalid_api_key" } },
};
type Phase = "direct" | "before" | "after";
type Prelude = "role-only" | "partial" | "none";
let mode: { body: unknown; phase: Phase; prelude: Prelude; sseEvent: boolean; disconnect: boolean } | undefined;
let calls = 0;

function handle(req: IncomingMessage, res: ServerResponse, raw: string) {
  calls++;
  const body = JSON.parse(raw) as { tools?: unknown; messages?: { role: string }[] };
  const m = mode!;
  if (m.phase === "direct") {
    res.writeHead(401, { "content-type": "application/json" });
    return res.end(JSON.stringify(m.body));
  }
  // 与 Uma 的 mock 一样：无论 stream 标志，都返回 200 SSE。
  res.writeHead(200, { "content-type": "text/event-stream" });
  const firstTurn = !body.messages?.some(msg => msg.role === "tool");
  if (m.phase === "after" && body.tools && firstTurn) {
    // 与 Riley 的 step1then401 一样：第 1 步完整结束，下一轮才在流中鉴权失败。
    return res.end(step1 + chunk({}, "tool_calls") + "data: [DONE]\n\n");
  }
  if (m.prelude === "role-only") res.write(roleOnly);
  if (m.prelude === "partial") res.write(body.tools ? partialStep : textChunk);
  if (m.phase === "after" && !body.tools) res.write(textChunk);
  setTimeout(() => {
    res.write(`${m.sseEvent ? "event: error\n" : ""}data: ${JSON.stringify(m.body)}\n\n`);
    if (m.disconnect) setTimeout(() => req.socket.destroy(), 20); else res.end();
  }, 20);
}

const AUTH = { code: "UPSTREAM_AUTH", error: "UPSTREAM_AUTH", retryable: false, message: "API Key 无效或没有权限" };
let f: Awaited<ReturnType<typeof createFixture>>;
let baseURL = "";
const server = createServer((req, res) => { let raw = ""; req.on("data", d => raw += d); req.on("end", () => handle(req, res, raw)); });

beforeAll(async () => {
  f = await createFixture({ modelServer: false });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
afterAll(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); await f.close(); });

const entries = ["hint", "lecture JSON", "lecture NDJSON", "test-connection"] as const;
async function call(entry: (typeof entries)[number]) {
  const byok = { provider: "openai-compatible", model: "m", apiKey: KEY, baseURL };
  if (entry === "hint") return (await import("../app/api/hint/route")).POST(request({ slug: "group-anagrams", level: 1, byok }));
  if (entry === "test-connection") return (await import("../app/api/settings/test-connection/route")).POST(request({ byok, ...byok }));
  const req = request({ slug: "group-anagrams", regenerate: true, byok });
  if (entry === "lecture NDJSON") req.headers.set("accept", "application/x-ndjson");
  return (await import("../app/api/lecture/route")).POST(req);
}

const variants: { name: string; prelude: Prelude; sseEvent: boolean; disconnect: boolean }[] = [
  { name: "Uma: role-only chunk + data error, close", prelude: "role-only", sseEvent: false, disconnect: false },
  { name: "Riley mid401sse: partial + event:error, disconnect", prelude: "partial", sseEvent: true, disconnect: true },
  { name: "Riley midkey200: partial + data error, disconnect", prelude: "partial", sseEvent: false, disconnect: true },
  { name: "bare: error as first event", prelude: "none", sseEvent: false, disconnect: false },
];

describe.each(entries)("%s", entry => {
  for (const [bodyName, errBody] of Object.entries(bodies)) {
    test(`direct 401 · ${bodyName}`, async () => {
      mode = { body: errBody, phase: "direct", prelude: "none", sseEvent: false, disconnect: false };
      const before = calls;
      const res = await call(entry);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual(AUTH);
      expect(calls - before).toBe(1);
    });
    const usable = (v: (typeof variants)[number]) => !v.disconnect || entry.startsWith("lecture");
    test.each(variants.filter(usable))(`before step 1 · ${bodyName} · $name`, async v => {
      mode = { body: errBody, phase: "before", ...v };
      const before = calls;
      const res = await call(entry);
      const text = await res.text();
      expect(res.status).toBe(400);
      expect(JSON.parse(text)).toEqual(AUTH);
      expect(text).not.toContain(KEY);
      expect(calls - before).toBe(1);
    });
    test.each(variants.filter(usable))(`after step 1 · ${bodyName} · $name`, async v => {
      mode = { body: errBody, phase: "after", ...v };
      const res = await call(entry);
      const text = await res.text();
      expect(text).not.toContain(KEY);
      if (entry === "lecture NDJSON") {
        expect(res.status).toBe(200);
        const lines = text.trim().split("\n").map(l => JSON.parse(l));
        expect(lines.some(l => l.type === "step")).toBe(true);
        expect(lines.at(-1)).toStrictEqual({ type: "error", code: "UPSTREAM_AUTH", retryable: false });
      } else {
        // 非流式入口没有已发出的步骤，仍是 HTTP 400。
        expect(res.status).toBe(400);
        expect(JSON.parse(text)).toEqual(AUTH);
      }
    });
  }
});
