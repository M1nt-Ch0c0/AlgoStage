import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { vi } from "vitest";
import { createFixture, request } from "./api-fixture";
import { HOT100 } from "../lib/content/hot100";
import { localSeedSource } from "../lib/content/local-source";

test("Demo：请求 Key 和环境 Key 均不能绕过 AI 禁用与设置隔离", async () => {
  const runtimeSource = readFileSync(new URL("../lib/runtime.ts", import.meta.url), "utf8");
  assert.equal(runtimeSource.includes("每位访客的进度互相独立"), false);
  assert.equal(runtimeSource.includes("不记录任何"), true);
  const databasePath = `/tmp/algostage-demo-forbidden-${process.pid}.db`;
  process.env.DATABASE_URL = `file:${databasePath}`;
  process.env.NEXT_PUBLIC_ALGOSTAGE_DEMO = "1";
  process.env.AI_API_KEY = "forbidden-env-key";
  process.env.AI_MODEL = "forbidden-model";
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { calls++; throw new Error("Demo 不允许请求模型"); };
  try {
    for (const route of [await import("../app/api/lecture/route"), await import("../app/api/hint/route")]) {
      const response = await route.POST(request({ slug: "3sum", level: 1, byok: { provider: "openai-compatible", apiKey: "request-key", model: "request-model" } }));
      assert.equal(response.status, 403);
      assert.equal((await response.json()).error, "DEMO");
    }
    const settings = await import("../app/api/settings/route");
    assert.deepEqual(await (await settings.GET()).json(), { settings: {}, keySource: "none", envConfigured: false });
    assert.equal((await settings.PUT(request({ settings: { apiKey: "new-key" } }))).status, 403);
    const progress = await import("../app/api/progress/route");
    for (const body of [
      ...["AC", "WA", "RE", "TLE"].map(verdict => ({ type: "submission", problemSlug: "two-sum", code: "", language: "typescript", verdict })),
      { type: "hint", problemSlug: "two-sum", level: 1 },
      { type: "lecture-step", problemSlug: "two-sum", stepIndex: 0 },
      { type: "unknown" },
    ]) {
      const response = await progress.POST(request(body));
      assert.equal(response.status, 403);
      assert.equal((await response.json()).error, "DEMO");
      assert.equal(response.headers.get("set-cookie"), null);
    }
    const badJson = new NextRequest("http://localhost/api/progress", { method: "POST", body: "{" });
    assert.equal((await progress.POST(badJson)).status, 403);
    assert.equal(badJson.bodyUsed, false, "Demo 拦截应先于请求解析");
    const dashboard = await import("../app/api/dashboard/route");
    const response = await dashboard.GET();
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, "DEMO");
    assert.equal(response.headers.get("set-cookie"), null);
    assert.equal(calls, 0);
    assert.equal(existsSync(databasePath), false);
  } finally {
    globalThis.fetch = originalFetch;
    delete (globalThis as { prisma?: unknown }).prisma;
  }
});

test("Demo 下 /api/judge 照常判题并返回 200，但不写任何记录；非 Demo 下照常写入", async () => {
  vi.resetModules();
  const f = await createFixture({ modelServer: false });
  try {
    const problem = HOT100[0];
    await f.prisma.problem.create({
      data: {
        slug: problem.slug, title: problem.title, number: problem.number, difficulty: problem.difficulty,
        order: problem.order, patterns: JSON.stringify(problem.patterns), prereqs: JSON.stringify(problem.prereqs),
      },
    });
    const code = (await localSeedSource.detail("two-sum")).referenceSolutions!.find(item => item.language === "typescript")!.code;
    const payload = { problemSlug: "two-sum", language: "typescript", code };

    process.env.NEXT_PUBLIC_ALGOSTAGE_DEMO = "1";
    vi.resetModules();
    const demoJudge = await import("../app/api/judge/route");
    const demoRes = await demoJudge.POST(request(payload));
    assert.equal(demoRes.status, 200);
    const demoBody = await demoRes.json();
    assert.equal(demoBody.ok, true);
    assert.equal(demoBody.result.verdict, "AC");
    assert.equal(await f.prisma.submission.count(), 0);
    assert.equal(await f.prisma.problemProgress.count(), 0);
    assert.equal(await f.prisma.reviewCard.count(), 0);

    delete process.env.NEXT_PUBLIC_ALGOSTAGE_DEMO;
    vi.resetModules();
    const localJudge = await import("../app/api/judge/route");
    const localRes = await localJudge.POST(request(payload));
    assert.equal(localRes.status, 200);
    const localBody = await localRes.json();
    assert.equal(localBody.ok, true);
    assert.equal(localBody.result.verdict, "AC");
    assert.equal(await f.prisma.submission.count(), 1);
    assert.equal(await f.prisma.problemProgress.count(), 1);
    assert.equal(await f.prisma.reviewCard.count(), 1);
  } finally {
    await f.close();
    delete (globalThis as { prisma?: unknown }).prisma;
  }
});

test("Demo 下 GET /api/review 返回 403，非 Demo 下照常", async () => {
  delete (globalThis as { prisma?: unknown }).prisma;
  vi.resetModules();
  const f = await createFixture({ modelServer: false });
  try {
    await f.prisma.reviewCard.create({
      data: { userId: "local-default", problemSlug: "two-sum", dueAt: new Date(0), interval: 1, reps: 1, lapses: 0 },
    });

    process.env.NEXT_PUBLIC_ALGOSTAGE_DEMO = "1";
    vi.resetModules();
    const demoReview = await import("../app/api/review/route");
    const demoRes = await demoReview.GET();
    assert.equal(demoRes.status, 403);
    assert.equal((await demoRes.json()).error, "DEMO");
    assert.equal(demoRes.headers.get("set-cookie"), null);

    delete process.env.NEXT_PUBLIC_ALGOSTAGE_DEMO;
    vi.resetModules();
    const localReview = await import("../app/api/review/route");
    const localRes = await localReview.GET();
    assert.equal(localRes.status, 200);
    const localBody = await localRes.json();
    assert.equal(localBody.cards.length, 1);
    assert.equal(localBody.cards[0].problemSlug, "two-sum");
  } finally {
    await f.close();
    delete (globalThis as { prisma?: unknown }).prisma;
  }
});
