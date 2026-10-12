/** 只调用本机假模型，使用独立 SQLite 库，不接触用户 Key 或学习记录。 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { NextRequest } from "next/server";

export async function createFixture() {
  const directory = mkdtempSync(join(tmpdir(), "algostage-m1-"));
  process.env.DATABASE_URL = `file:${join(directory, "test.db")}`;
  delete process.env.NEXT_PUBLIC_ALGOSTAGE_DEMO;
  for (const key of ["AI_API_KEY", "AI_MODEL", "AI_PROVIDER", "AI_BASE_URL"]) delete process.env[key];
  execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "db", "push"], { stdio: "pipe" });
  const { prisma } = await import("../lib/db/prisma");
  await prisma.user.create({ data: { id: "local-default" } });
  const calls: { model: string; key: string | undefined }[] = [];
  let errorResponse: { status: number; body: unknown } | undefined;
  let reply: (body: Record<string, unknown>) => unknown = () => "请注意题目中的条件。";
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw) as Record<string, unknown>;
    calls.push({ model: body.model as string, key: req.headers.authorization });
    if (errorResponse) {
      res.statusCode = errorResponse.status;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(errorResponse.body));
      return;
    }
    const content = reply(body);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({
      id: "mock", object: "chat.completion", created: 0, model: body.model,
      choices: [{ index: 0, message: { role: "assistant", content: typeof content === "string" ? content : JSON.stringify(content) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  return {
    prisma, calls, baseURL,
    setReply(next: typeof reply) { reply = next; errorResponse = undefined; },
    setError(status: number, body: unknown) { errorResponse = { status, body }; },
    async save(settings: Record<string, string>) {
      for (const [key, value] of Object.entries(settings)) {
        await prisma.setting.upsert({ where: { key_userId: { key, userId: "local-default" } }, update: { value }, create: { key, value, userId: "local-default" } });
      }
    },
    async close() {
      await prisma.$disconnect();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

export function request(body: unknown) {
  return new NextRequest("http://localhost/api/test", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
}
