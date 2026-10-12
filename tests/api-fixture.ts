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
  for (const key of ["AI_API_KEY", "AI_MODEL", "AI_PROVIDER", "AI_BASE_URL"])
    delete process.env[key];
  execFileSync(
    process.execPath,
    ["node_modules/prisma/build/index.js", "db", "push"],
    { stdio: "pipe" },
  );
  const { prisma } = await import("../lib/db/prisma");
  await prisma.user.create({ data: { id: "local-default" } });
  const requests: Record<string, unknown>[] = [];
  let rejectStructured = false,
    requireNonThinkingTools = false,
    delayMs = 0;
  let streamFailures = 0;
  let disconnects = 0;
  const calls: { model: string; key: string | undefined }[] = [];
  let errorResponse: { status: number; body: unknown; remaining: number } | undefined;
  let toolsReply:
    | ((body: Record<string, unknown>) => { name: string; input: unknown }[])
    | undefined;
  let reply: (body: Record<string, unknown>) => unknown = () =>
    "请注意题目中的条件。";
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw) as Record<string, unknown>;
    requests.push(body);
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    if (res.destroyed) return;
    calls.push({ model: body.model as string, key: req.headers.authorization });
    if (disconnects > 0) { disconnects--; res.destroy(); return; }
    if (rejectStructured && body.response_format) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          error: { message: "response_format json_schema is not supported" },
        }),
      );
      return;
    }
    if (
      requireNonThinkingTools &&
      body.tools &&
      (body.thinking as { type?: string })?.type !== "disabled"
    ) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          error: { message: "tool_choice is not supported in thinking mode" },
        }),
      );
      return;
    }
    if (errorResponse) {
      const failure = errorResponse;
      if (--failure.remaining <= 0) errorResponse = undefined;
      res.statusCode = failure.status;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(failure.body));
      return;
    }
    const content = toolsReply && body.tools ? undefined : reply(body);
    if (body.tools && body.stream) {
      let toolCalls = toolsReply?.(body);
      if (!toolCalls) {
        const script = (
          typeof content === "string" ? JSON.parse(content) : content
        ) as {
          steps?: {
            id: string;
            narration: string;
            targets?: unknown[];
            effects?: Record<string, unknown>[];
            viz?: unknown;
          }[];
        };
        toolCalls = [];
        for (const [i, step] of (script.steps ?? []).entries()) {
          const stepId = `s${i + 1}`;
          toolCalls.push({
            name: "add_step",
            input: {
              id: stepId,
              narration: step.narration,
              target: step.targets?.[0],
            },
          });
          for (const effect of step.effects ?? [])
            toolCalls.push({
              name: "set_effect",
              input: { stepId, ...effect },
            });
          if (step.viz !== undefined)
            toolCalls.push({
              name: "set_viz",
              input: { stepId, viz: step.viz },
            });
        }
        toolCalls.push({ name: "finish", input: {} });
        const chosen = (body.tool_choice as { function?: { name?: string } })
          ?.function?.name;
        if (chosen)
          toolCalls = [
            toolCalls.find((call) => call.name === chosen) ?? {
              name: chosen,
              input: {},
            },
          ];
        else {
          const completed = new Set<string>();
          for (const message of (body.messages ?? []) as {
            role: string;
            content?: string;
          }[]) {
            if (message.role !== "tool" || !message.content) continue;
            const result = JSON.parse(message.content);
            if (result.ok && result.stepId) completed.add(result.stepId);
          }
          toolCalls = toolCalls.filter(
            (call) =>
              call.name !== "add_step" ||
              !completed.has((call.input as { id: string }).id),
          );
        }
      }
      res.setHeader("Content-Type", "text/event-stream");
      const send = (delta: unknown, finish_reason: string | null = null) =>
        res.write(
          `data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", created: 0, model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
        );
      for (const [index, call] of toolCalls.entries()) {
        send({
          tool_calls: [
            {
              index,
              id: `call-${requests.length}-${index}`,
              type: "function",
              function: { name: call.name, arguments: "" },
            },
          ],
        });
        send({
          tool_calls: [
            { index, function: { arguments: JSON.stringify(call.input) } },
          ],
        });
      }
      if (streamFailures > 0) {
        streamFailures--;
        // 工具参数完整，但连接在 finish_reason 前关闭。
        res.end("data: [DONE]\n\n");
        return;
      }
      send({}, "tool_calls");
      res.end("data: [DONE]\n\n");
      return;
    }
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        id: "mock",
        object: "chat.completion",
        created: 0,
        model: body.model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content:
                typeof content === "string" ? content : JSON.stringify(content),
            },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  return {
    prisma,
    calls,
    requests,
    baseURL,
    setStreamFailures(count: number) {
      streamFailures = count;
    },
    setRequireNonThinkingTools(value: boolean) {
      requireNonThinkingTools = value;
    },
    setRejectStructured(value: boolean) {
      rejectStructured = value;
    },
    setDelay(ms: number) {
      delayMs = ms;
    },
    setToolsReply(next: NonNullable<typeof toolsReply>) {
      toolsReply = next;
      errorResponse = undefined;
    },
    setReply(next: typeof reply) {
      reply = next;
      toolsReply = undefined;
      errorResponse = undefined;
    },
    setError(status: number, body: unknown, remaining = Infinity) {
      errorResponse = { status, body, remaining };
    },
    setDisconnects(count: number) {
      disconnects = count;
    },
    async save(settings: Record<string, string>) {
      for (const [key, value] of Object.entries(settings)) {
        await prisma.setting.upsert({
          where: { key_userId: { key, userId: "local-default" } },
          update: { value },
          create: { key, value, userId: "local-default" },
        });
      }
    },
    async close() {
      await prisma.$disconnect();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

export function request(body: unknown) {
  return new NextRequest("http://localhost/api/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
