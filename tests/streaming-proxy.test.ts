import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { NextRequest } from "next/server";
import { createFixture } from "./api-fixture";
import { LECTURE_TIMEOUT_MS } from "../lib/agent/defaults";

test("流响应明确禁止代理缓冲，完整教案完成前可收到首步并取消", async () => {
  const f = await createFixture();
  try {
    const { POST } = await import("../app/api/lecture/route");
    await f.save({ provider: "openai-compatible", model: "stream-test", apiKey: "fake-stream-key", baseURL: f.baseURL });
    let round = 0;
    f.setDelay(150);
    f.setToolsReply(() => ++round === 1
      ? [{ name: "add_step", input: { id: "s1", narration: "首步立即播放", target: { kind: "code-line", start: 1 } } }]
      : [{ name: "finish", input: {} }]);
    const response = await POST(new NextRequest("http://localhost/api/lecture", {
      method: "POST", headers: { Accept: "application/x-ndjson", "Content-Type": "application/json" },
      body: JSON.stringify({ slug: "3sum" }),
    }));
    expect(response.headers.get("X-Accel-Buffering")).toBe("no");
    expect(response.headers.get("Cache-Control")).toBe("no-store, no-transform");
    const reader = response.body!.getReader();
    let text = "";
    while (!text.includes('"type":"step"')) {
      const part = await reader.read();
      expect(part.done).toBe(false);
      text += new TextDecoder().decode(part.value);
    }
    expect(text).toContain("首步立即播放");
    expect(text).not.toContain('"type":"result"');
    expect(await f.prisma.lectureScriptCache.count()).toBe(0);
    await reader.cancel();
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(await f.prisma.lectureScriptCache.count()).toBe(0);
  } finally { await f.close(); }
});

test("部署路径关闭缓存与压缩，代理超时覆盖整次生成上限", () => {
  const nginx = readFileSync("deploy/nginx.conf", "utf8");
  const location = nginx.match(/location = \/algostage\/api\/lecture \{([\s\S]*?)\n {4}\}/)?.[1];
  expect(location).toContain("include /etc/nginx/snippets/algostage-proxy.conf;");
  expect(location).toContain("proxy_cache off;");
  expect(location).toContain("gzip off;");
  expect(location).toContain('proxy_set_header Accept-Encoding "";');
  const proxy = readFileSync("deploy/algostage-proxy.conf", "utf8");
  expect(proxy).toContain("proxy_buffering off;");
  const timeout = Number(proxy.match(/proxy_read_timeout (\d+)s;/)?.[1]);
  expect(timeout * 1000).toBeGreaterThan(LECTURE_TIMEOUT_MS);
});
