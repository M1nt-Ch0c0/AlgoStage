/** §9 #48–#50 · 经真实 nginx 透传 ask 路由；假上游 + 临时目录。 */
import { lookup } from "node:dns/promises";
import type { LookupAddress, LookupAllOptions } from "node:dns";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { createServer, type Server } from "node:http";
import { createServer as createProbe, connect, type Server as NetServer } from "node:net";
import { once } from "node:events";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { createFixture } from "./api-fixture";
import { validateScript } from "@/lib/teaching/validated-script";
import { scriptVersion } from "@/lib/ask/script-version";
import type { AnswerSegment } from "@/lib/ask/types";

vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));
const dns = vi.mocked(lookup as (host: string, options: LookupAllOptions) => Promise<LookupAddress[]>);

vi.mock("../lib/agent/defaults", async importOriginal => ({
  ...await importOriginal<typeof import("../lib/agent/defaults")>(),
  ASK_TIMEOUT_MS: 1800,
  askTimeoutMs: () => 1800,
}));

type GenerateInput = Parameters<typeof import("@/lib/agent/ask-generation").generateAsk>[0];

const harness = vi.hoisted(() => {
  let impl: (input: GenerateInput) => Promise<unknown> = async () => {
    throw new Error("generateAsk mock unset");
  };
  return {
    set(next: typeof impl) { impl = next; },
    run(input: GenerateInput) { return impl(input); },
  };
});

vi.mock("@/lib/agent/ask-generation", async () => {
  const actual = await vi.importActual<typeof import("@/lib/agent/ask-generation")>("@/lib/agent/ask-generation");
  return {
    ...actual,
    generateAsk: (input: GenerateInput) => harness.run(input),
  };
});

const binary = process.env.NGINX_BINARY ?? "nginx";
const available = spawnSync(binary, ["-v"], { stdio: "ignore" }).status === 0;
if (process.env.NGINX_BINARY && !available) throw new Error("指定的 NGINX_BINARY 无法运行。");

const KEY = "sk-nginx-ask-key";
const SLUG = "3sum";
const BYOK = {
  provider: "openai-compatible" as const,
  model: "nginx-ask",
  apiKey: KEY,
  baseURL: "https://ai.example/v1",
};

function cacheKeyOf(slug: string, config: typeof BYOK, solutionLanguage: string, language: string) {
  return createHash("sha1").update(JSON.stringify([
    slug, config.provider, config.baseURL ?? "", config.model, solutionLanguage, language, "lecture",
  ])).digest("hex");
}

function rawScript(stepIds = ["s1", "s2"]) {
  return {
    problemSlug: SLUG,
    language: "zh",
    solutionLanguage: "typescript",
    mode: "lecture",
    steps: stepIds.map((id, index) => ({
      id,
      narration: `步骤${index + 1}`,
      targets: [{ kind: "code-line", start: 1 }],
    })),
  };
}

function segment(id = "a1", narration = "这一段解释当前问题。"): AnswerSegment {
  return { id, narration };
}

async function listenInRange(server: Server | NetServer, lo = 4500, hi = 4599): Promise<number> {
  for (let port = lo; port <= hi; port++) {
    try {
      await new Promise<void>((resolveOk, reject) => {
        const onErr = (error: Error) => { server.off("listening", onListen); reject(error); };
        const onListen = () => { server.off("error", onErr); resolveOk(); };
        server.once("error", onErr);
        server.once("listening", onListen);
        server.listen(port, "127.0.0.1");
      });
      return port;
    } catch {
      await new Promise<void>(done => server.close(() => done())).catch(() => {});
    }
  }
  throw new Error("no free port in 4500-4599");
}

describe.skipIf(!available)("§9 经 nginx 的 ask 首段、504 与流内 TIMEOUT", () => {
  let fixture: Awaited<ReturnType<typeof createFixture>>;
  let bridge: Server, nginx: ChildProcess, exited: Promise<unknown>;
  let directory: string, endpoint: string, proxyPort: number;
  let seeded: { key: string; version: string };
  const encodings: (string | undefined)[] = [];

  beforeAll(async () => {
    fixture = await createFixture({ modelServer: false });
    const { POST } = await import("../app/api/lecture/ask/route");
    dns.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
    vi.stubEnv("ALGOSTAGE_ALLOW_PRIVATE_BASE_URL", "false");

    bridge = createServer(async (req, res) => {
      const abort = new AbortController();
      req.on("aborted", () => abort.abort());
      res.on("close", () => {
        if (!res.writableFinished) abort.abort();
      });
      try {
        let body = "";
        for await (const chunk of req) body += chunk;
        encodings.push(req.headers["accept-encoding"]);
        const response = await POST(new NextRequest(`http://localhost${req.url}`, {
          method: "POST", signal: abort.signal,
          headers: {
            Accept: req.headers.accept ?? "",
            "Content-Type": "application/json",
            ...(req.headers["x-real-ip"] ? { "x-real-ip": String(req.headers["x-real-ip"]) } : {}),
          },
          body,
        }));
        response.headers.forEach((value, key) => res.setHeader(key, value));
        res.writeHead(response.status);
        if (response.body) await pipeline(Readable.fromWeb(response.body as NodeReadableStream), res);
        else res.end();
      } catch { abort.abort(); res.destroy(); }
    });
    const upstreamPort = await listenInRange(bridge);

    const probe = createProbe();
    proxyPort = await listenInRange(probe);
    await new Promise<void>(done => probe.close(() => done()));

    endpoint = `http://127.0.0.1:${proxyPort}/algostage/api/lecture/ask`;
    directory = mkdtempSync(join(tmpdir(), "algostage-nginx-ask-"));
    const source = readFileSync("deploy/nginx.conf", "utf8");
    const location = source.match(/location = \/algostage\/api\/lecture \{[\s\S]*?\n {4}\}/)?.[0];
    expect(location).toBeTruthy();
    const actual = location!
      .replace("location = /algostage/api/lecture", "location = /algostage/api/lecture/ask")
      .replace("http://127.0.0.1:3100", `http://127.0.0.1:${upstreamPort}`)
      .replace("/etc/nginx/snippets/algostage-proxy.conf", resolve("deploy/algostage-proxy.conf"));
    const config = join(directory, "nginx.conf");
    writeFileSync(config, `worker_processes 1;
pid ${directory}/nginx.pid;
error_log stderr;
events { worker_connections 64; }
http {
  access_log off;
  client_body_temp_path ${directory}/client;
  proxy_temp_path ${directory}/proxy;
  fastcgi_temp_path ${directory}/fastcgi;
  scgi_temp_path ${directory}/scgi;
  uwsgi_temp_path ${directory}/uwsgi;
  gzip on;
  gzip_types application/x-ndjson;
  proxy_buffering on;
  server { listen 127.0.0.1:${proxyPort}; ${actual} }
}`);
    const syntax = spawnSync(binary, ["-p", directory, "-c", config, "-e", "stderr", "-t"], { encoding: "utf8" });
    expect(syntax.status, syntax.stderr).toBe(0);
    nginx = spawn(binary, ["-p", directory, "-c", config, "-e", "stderr", "-g", "daemon off;"], { stdio: "ignore" });
    exited = once(nginx, "exit");
    let ready = false;
    for (let attempt = 0; attempt < 100 && nginx.exitCode === null; attempt++) {
      ready = await new Promise<boolean>(done => {
        const connection = connect(proxyPort, "127.0.0.1");
        connection.once("connect", () => { connection.destroy(); done(true); });
        connection.once("error", () => { connection.destroy(); done(false); });
      });
      if (ready) break;
      await new Promise(done => setTimeout(done, 25));
    }
    expect(ready, "独立 nginx 必须成功监听测试端口").toBe(true);
    expect(proxyPort).toBeGreaterThanOrEqual(4500);
    expect(proxyPort).toBeLessThanOrEqual(4599);
  });

  beforeEach(async () => {
    await fixture.prisma.lectureScriptCache.deleteMany();
    await fixture.prisma.lectureAnswer.deleteMany();
    encodings.length = 0;
    const raw = rawScript();
    const script = validateScript(raw, "function solve() {}", { stepIds: "lenient" });
    const key = cacheKeyOf(SLUG, BYOK, script.solutionLanguage, script.language);
    const version = scriptVersion(script);
    await fixture.prisma.lectureScriptCache.create({
      data: { key, script: JSON.stringify(raw) },
    });
    seeded = { key, version };
    harness.set(async (input) => {
      const segs = [segment("a1"), segment("a2", "再换一个例子说明。")];
      for (const item of segs) {
        await new Promise(done => setTimeout(done, 120));
        if (input.signal.aborted) return { ok: false, status: 499, error: "CANCELLED" };
        input.onSegment(item);
      }
      return { ok: true, segments: segs };
    });
  });

  afterAll(async () => {
    if (nginx && nginx.exitCode === null && nginx.signalCode === null) nginx.kill("SIGTERM");
    if (exited) await exited;
    if (bridge) { bridge.closeAllConnections(); await new Promise<void>(done => bridge.close(() => done())); }
    await fixture?.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  function request(extra: Record<string, unknown> = {}) {
    return fetch(endpoint, {
      method: "POST",
      headers: { Accept: "application/x-ndjson", "Accept-Encoding": "gzip", "Content-Type": "application/json" },
      body: JSON.stringify({
        problemSlug: SLUG,
        cacheKey: seeded.key,
        scriptVersion: seeded.version,
        stepId: "s1",
        question: "为什么这样写？",
        selection: {
          mode: "single",
          bbox: { x: 0, y: 0, width: 44, height: 44 },
          targets: [{ kind: "subtitle", id: "subtitle-s1", stepId: "s1", text: "当前字幕" }],
          question: "为什么这样写？",
          stepId: "s1",
        },
        byok: BYOK,
        ...extra,
      }),
      signal: AbortSignal.timeout(8000),
    });
  }

  test("#48 首段在完整结果前送达，后续段有间隔，不压缩", async () => {
    const started = performance.now();
    const times: number[] = [];
    const response = await request();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store, no-transform");
    expect(response.headers.get("Content-Encoding")).toBeNull();
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let segments = 0;
    let sawResult = false;
    while (true) {
      const { value, done } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: !done });
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        const event = JSON.parse(line) as { type: string };
        if (event.type === "segment") {
          segments += 1;
          times.push(performance.now() - started);
        }
        if (event.type === "result") sawResult = true;
      }
      if (done) break;
    }
    expect(segments).toBe(2);
    expect(sawResult).toBe(true);
    expect(times[0]!).toBeLessThan(1500);
    expect(times[1]! - times[0]!).toBeGreaterThan(80);
    expect(encodings.every(encoding => encoding === undefined)).toBe(true);
    expect(await fixture.prisma.lectureAnswer.count()).toBe(1);
    console.info("nginx_ask_stream", JSON.stringify({
      firstSegmentMs: Math.round(times[0]!),
      secondSegmentMs: Math.round(times[1]!),
      totalMs: Math.round(performance.now() - started),
    }));
  });

  const SERVER_TIMEOUT_MS = 1800, HANG_MS = SERVER_TIMEOUT_MS + 1200, MARGIN_MS = 2000;

  test("#49 首段前上游挂起 → 504 TIMEOUT JSON，无 start", async () => {
    harness.set(async (input) => {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, HANG_MS);
        input.signal.addEventListener("abort", () => { clearTimeout(timer); reject(Object.assign(new Error("aborted"), { name: "AbortError" })); }, { once: true });
      }).catch(() => {});
      return { ok: false, status: 504, error: "TIMEOUT" };
    });
    const started = performance.now();
    const response = await request();
    expect(response.status).toBe(504);
    const body = await response.json();
    expect(body).toMatchObject({ code: "TIMEOUT", error: "TIMEOUT", retryable: true });
    expect(JSON.stringify(body)).not.toContain("start");
    expect(performance.now() - started).toBeLessThan(SERVER_TIMEOUT_MS + MARGIN_MS);
    expect(await fixture.prisma.lectureAnswer.count()).toBe(0);
  }, 15000);

  test("#50 首段后挂起 → 200 + 流内 TIMEOUT，无 result、不落库", async () => {
    harness.set(async (input) => {
      input.onSegment(segment("a1"));
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, HANG_MS);
        input.signal.addEventListener("abort", () => { clearTimeout(timer); reject(Object.assign(new Error("aborted"), { name: "AbortError" })); }, { once: true });
      }).catch(() => {});
      return { ok: false, status: 504, error: "TIMEOUT" };
    });
    const started = performance.now();
    const response = await request();
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/x-ndjson");
    const events = (await response.text()).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
    expect(events[0]).toMatchObject({ type: "start", stepId: "s1" });
    expect(events.some(event => event.type === "segment")).toBe(true);
    expect(events.some(event => event.type === "result")).toBe(false);
    expect(events.at(-1)).toEqual({ type: "error", code: "TIMEOUT", retryable: true });
    expect(performance.now() - started).toBeLessThan(SERVER_TIMEOUT_MS + MARGIN_MS);
    expect(await fixture.prisma.lectureAnswer.count()).toBe(0);
    console.info("nginx_ask_timeout_after", JSON.stringify({ elapsedMs: Math.round(performance.now() - started) }));
  }, 15000);
});
