/** 真实 nginx 透传真实讲解路由；只连接本地假模型和临时数据库。 */
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { createServer, type Server } from "node:http";
import { createServer as createProbe, connect, type AddressInfo } from "node:net";
import { once } from "node:events";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { NextRequest } from "next/server";
import { createFixture } from "./api-fixture";
import { readLectureResponse } from "../lib/player/lecture-response";

// 缩短同一服务端总时限以验证错误送达，不改变部署的 240 秒上限。
vi.mock("../lib/agent/defaults", async importOriginal => ({
  ...await importOriginal<typeof import("../lib/agent/defaults")>(), LECTURE_TIMEOUT_MS: 1800,
}));
const binary = process.env.NGINX_BINARY ?? "nginx";
const available = spawnSync(binary, ["-v"], { stdio: "ignore" }).status === 0;
if (process.env.NGINX_BINARY && !available) throw new Error("指定的 NGINX_BINARY 无法运行。");

describe.skipIf(!available)("S8 经 nginx 的首段、增量、取消和超时", () => {
  let fixture: Awaited<ReturnType<typeof createFixture>>;
  let bridge: Server, nginx: ChildProcess, exited: Promise<unknown>;
  let directory: string, endpoint: string;
  let abortedResponses = 0;
  const encodings: (string | undefined)[] = [];

  beforeAll(async () => {
    fixture = await createFixture();
    const { POST } = await import("../app/api/lecture/route");
    await fixture.save({ provider: "openai-compatible", model: "nginx-test", apiKey: "fake-nginx-key", baseURL: fixture.baseURL });
    bridge = createServer(async (req, res) => {
      const abort = new AbortController();
      req.on("aborted", () => abort.abort());
      res.on("close", () => {
        if (!res.writableFinished) { abortedResponses++; abort.abort(); }
      });
      try {
        let body = "";
        for await (const chunk of req) body += chunk;
        encodings.push(req.headers["accept-encoding"]);
        const response = await POST(new NextRequest(`http://localhost${req.url}`, {
          method: "POST", signal: abort.signal,
          headers: { Accept: req.headers.accept ?? "", "Content-Type": "application/json" }, body,
        }));
        response.headers.forEach((value, key) => res.setHeader(key, value));
        res.writeHead(response.status);
        if (response.body) await pipeline(Readable.fromWeb(response.body as NodeReadableStream), res);
        else res.end();
      } catch { abort.abort(); res.destroy(); }
    });
    bridge.listen(0, "127.0.0.1"); await once(bridge, "listening");
    const upstreamPort = (bridge.address() as AddressInfo).port;
    const probe = createProbe(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
    const proxyPort = (probe.address() as AddressInfo).port;
    await new Promise<void>(done => probe.close(() => done()));
    endpoint = `http://127.0.0.1:${proxyPort}/algostage/api/lecture`;
    directory = mkdtempSync(join(tmpdir(), "algostage-nginx-"));
    const source = readFileSync("deploy/nginx.conf", "utf8");
    const location = source.match(/location = \/algostage\/api\/lecture \{[\s\S]*?\n {4}\}/)?.[0];
    expect(location).toBeTruthy();
    const actual = location!
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
  });
  beforeEach(async () => {
    await fixture.prisma.lectureScriptCache.deleteMany();
    fixture.setDelay(150);
    encodings.length = 0;
    let round = 0;
    fixture.setToolsReply(() => ++round === 1
      ? [{ name: "add_step", input: { id: "s1", narration: "找出和为零的三个数", target: { kind: "statement", blockId: "intro" } } }]
      : round === 2
        ? [{ name: "add_step", input: { id: "s2", narration: "先排序", target: { kind: "code-line", start: 4 } } }]
        : [{ name: "finish", input: {} }]);
  });
  afterAll(async () => {
    if (nginx && nginx.exitCode === null && nginx.signalCode === null) nginx.kill("SIGTERM");
    if (exited) await exited;
    if (bridge) { bridge.closeAllConnections(); await new Promise<void>(done => bridge.close(() => done())); }
    await fixture?.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });
  function request() {
    return fetch(endpoint, {
      method: "POST", headers: { Accept: "application/x-ndjson", "Accept-Encoding": "gzip", "Content-Type": "application/json" },
      body: JSON.stringify({ slug: "3sum" }), signal: AbortSignal.timeout(6000),
    });
  }

  test("首段在完整生成前送达，后续步骤分段到达且不压缩", async () => {
    const started = performance.now(), times: number[] = [], ids: string[] = [], progress: string[] = [];
    const response = await request();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store, no-transform");
    expect(response.headers.get("Content-Encoding")).toBeNull();
    const script = await readLectureResponse(response, message => progress.push(message), step => {
      ids.push(step.id); times.push(performance.now() - started);
    });
    const totalMs = performance.now() - started;
    expect(script).toMatchObject({ problemSlug: "3sum" });
    expect(ids).toEqual(["s1", "s2"]);
    expect(times[0]).toBeLessThan(1500);
    expect(times[1] - times[0]).toBeGreaterThan(80);
    expect(totalMs - times[1]).toBeGreaterThan(80);
    expect(progress.length).toBeGreaterThan(1);
    expect(encodings.every(encoding => encoding === undefined)).toBe(true);
    expect(await fixture.prisma.lectureScriptCache.count()).toBe(1);
    console.info("nginx_stream", JSON.stringify({ firstStepMs: Math.round(times[0]), secondStepMs: Math.round(times[1]), totalMs: Math.round(totalMs) }));
  });

  test("客户端收到首段后断开，nginx 取消上游请求且不写缓存", async () => {
    const before = abortedResponses;
    fixture.setDelay(250);
    const response = await request(), reader = response.body!.getReader();
    let text = "";
    while (!text.includes('"type":"step"')) {
      const next = await reader.read();
      expect(next.done).toBe(false);
      text += new TextDecoder().decode(next.value);
    }
    expect(text).not.toContain('"type":"result"');
    await reader.cancel();
    await expect.poll(() => abortedResponses, { timeout: 2000 }).toBeGreaterThan(before);
    // 等过剩余两轮的正常生成时间，排除只是写缓存尚未完成的假通过。
    await new Promise(done => setTimeout(done, 650));
    expect(await fixture.prisma.lectureScriptCache.count()).toBe(0);
  });

  test("上游挂起时，服务端超时提示经 nginx 到达且不缓存半份教案", async () => {
    fixture.setDelay(3000);
    const started = performance.now();
    const response = await request();
    const events = (await response.text()).trim().split("\n").map(line => JSON.parse(line));
    expect(events.some(event => event.type === "progress")).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "error", error: "TIMEOUT", status: 504 });
    expect(events.at(-1).message).toMatch(/超时.*重试.*gpt-6.1-sol/);
    expect(performance.now() - started).toBeLessThan(4000);
    expect(await fixture.prisma.lectureScriptCache.count()).toBe(0);
  });
});
