/** 真实验收：测试 Key 只读环境变量，独立临时数据库；只打印状态与耗时。 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { NextRequest } from "next/server";

process.env.AI_API_KEY =
  process.env.ALGOSTAGE_TEST_API_KEY ?? process.env.AI_API_KEY;
process.env.AI_BASE_URL =
  process.env.ALGOSTAGE_TEST_BASE_URL ?? process.env.AI_BASE_URL;
process.env.AI_PROVIDER = "openai-compatible";
const flashFailure = process.argv.includes("--flash-failure");
const flash = flashFailure || process.argv.includes("--flash");
process.env.AI_MODEL = flash ? "deepseek-flash" : "gpt-6.1-sol";
const smoke = process.argv.includes("--smoke");
const checkLatency = process.argv.includes("--latency");
const firstStepTimes: number[] = [];
const directory = mkdtempSync(join(tmpdir(), "algostage-live-"));
process.env.DATABASE_URL = `file:${join(directory, "test.db")}`;
execFileSync(
  process.execPath,
  ["node_modules/prisma/build/index.js", "db", "push"],
  { stdio: "ignore" },
);
const { prisma } = await import("../lib/db/prisma");
const { POST } = await import("../app/api/lecture/route");
const { teachingScriptSchema } = await import("../lib/teaching/schema");
const { readLectureResponse } = await import("../lib/player/lecture-response");
const { usePlayerStore } = await import("../lib/player/store");
const { localSeedSource } = await import("../lib/content/local-source");
// 可复现的真实上游流中断：收到响应后断开，只验证错误提示及零缓存。
// 请求仍使用环境变量中的 Key；不读取、输出或保存模型响应正文。
const originalFetch = globalThis.fetch;
if (flashFailure)
  globalThis.fetch = async (input, init) => {
    const response = await originalFetch(input, init);
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (!url.startsWith(process.env.AI_BASE_URL!) || !response.body)
      return response;
    const reader = response.body.getReader();
    return new Response(
      new ReadableStream({
        async start(controller) {
          try {
            await reader.read();
          } finally {
            await reader.cancel().catch(() => {});
          }
          controller.error(new Error("验收模拟上游流中断"));
        },
      }),
      { status: response.status, headers: response.headers },
    );
  };
let successes = 0;
try {
  await prisma.user.create({ data: { id: "local-default" } });
  const slugs =
    smoke || flash ? ["3sum"] : ["3sum", "two-sum", "valid-parentheses"];
  const repetitions = smoke || flash ? 1 : 3;
  for (const slug of slugs) {
    const reference = (
      await localSeedSource.detail(slug)
    ).referenceSolutions!.find((s) => s.language === "typescript")!.code;
    const lines = reference.split("\n").length;
    for (let attempt = 1; attempt <= repetitions; attempt++) {
      // 每次生成前清空教案缓存，绝不把 Key 写入 Setting。
      await prisma.lectureScriptCache.deleteMany();
      usePlayerStore.getState().reset();
      usePlayerStore.getState().beginStream({
        problemSlug: slug,
        mode: "lecture",
        language: "zh",
        solutionLanguage: "typescript",
      });
      console.log(
        `${process.env.AI_MODEL} ${slug} ${attempt}/${repetitions}: 开始生成（已清缓存）`,
      );
      const start = performance.now();
      let firstMs: number | null = null,
        success = false,
        error = "UNKNOWN",
        recommended = false;
      const abort = new AbortController();
      const guard = setTimeout(() => abort.abort(), 250000);
      try {
        const response = await POST(
          new NextRequest("http://localhost/api/lecture", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/x-ndjson",
            },
            body: JSON.stringify({ slug }),
            signal: abort.signal,
          }),
        );
        const data = await readLectureResponse(
          response,
          (message) => {
            if (smoke) console.log(message);
          },
          (step, update) => {
            if (update) usePlayerStore.getState().updateStep(step);
            else {
              usePlayerStore.getState().appendStep(step);
              if (
                firstMs === null &&
                usePlayerStore.getState().status === "playing"
              ) {
                firstMs = performance.now() - start;
                console.log(
                  `${slug} ${attempt}: 首步可播放 ${(firstMs / 1000).toFixed(1)}s`,
                );
              }
            }
          },
        );
        const script = teachingScriptSchema.parse(data);
        success =
          response.status === 200 &&
          firstMs !== null &&
          script.problemSlug === slug &&
          script.steps.length >= 6 &&
          script.steps.every((step) =>
            step.targets.every(
              (target) =>
                target.kind !== "code-line" ||
                (target.start <= lines &&
                  (target.end ?? target.start) <= lines),
            ),
          ) &&
          (await prisma.lectureScriptCache.count()) === 1;
        error = success ? "NONE" : "INVALID_RESULT";
      } catch (cause) {
        // 不输出异常本身，只识别固定错误类别和推荐模型提示。
        const message = cause instanceof Error ? cause.message : "";
        error = message.includes("超时")
          ? "TIMEOUT"
          : message.includes("校验")
            ? "INVALID_SCRIPT"
            : message.includes("连不上模型")
              ? "UPSTREAM_ERROR"
              : "FAILED";
        recommended = message.includes("gpt-6.1-sol");
      } finally {
        clearTimeout(guard);
      }
      const totalMs = performance.now() - start;
      const cacheCount = await prisma.lectureScriptCache.count();
      if (success) successes++;
      if (success && firstMs !== null) firstStepTimes.push(firstMs);
      console.log(
        JSON.stringify({
          model: process.env.AI_MODEL,
          slug,
          attempt,
          success,
          error,
          firstPlayableSeconds:
            firstMs === null ? null : Math.round(firstMs / 100) / 10,
          totalSeconds: Math.round(totalMs / 100) / 10,
          cacheCount,
          recommended,
        }),
      );
      if (
        flash &&
        !success &&
        cacheCount === 0 &&
        recommended &&
        totalMs < 30000
      )
        console.log(
          "deepseek-flash 真实流中断故障注入：明确失败、30 秒内返回、未缓存 PASS",
        );
      else if (flashFailure) process.exitCode = 1;
    }
  }
  if (!flash) {
    console.log(`gpt-6.1-sol 成功 ${successes}/${slugs.length * repetitions}`);
    if (successes !== slugs.length * repetitions) process.exitCode = 1;
    if (checkLatency) {
      const times = firstStepTimes.sort((a, b) => a - b);
      const median = times.length ? (times[Math.floor((times.length - 1) / 2)] + times[Math.floor(times.length / 2)]) / 2 : Infinity;
      const passed = successes === slugs.length * repetitions && median <= 15000;
      console.log(JSON.stringify({ metric: "首步中位数", seconds: Number.isFinite(median) ? Math.round(median / 100) / 10 : null, limitSeconds: 15, passed }));
      if (!passed) process.exitCode = 1;
    }
  }
} catch {
  console.log("验收执行失败（未输出原始错误）");
  process.exitCode = 1;
} finally {
  globalThis.fetch = originalFetch;
  await prisma.$disconnect();
  rmSync(directory, { recursive: true, force: true });
}
