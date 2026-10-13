import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { NextRequest } from "next/server";
import { scriptVersion } from "@/lib/ask/script-version";
import { createFixture, request } from "./api-fixture";

/** 捕获 stdout/stderr，覆盖 console 与 SDK 写到标准流的内容。 */
async function captureLogs<T>(run: () => Promise<T>) {
  const logs: string[] = [];
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  const capture = ((chunk: unknown) => {
    logs.push(String(chunk));
    return true;
  }) as typeof stdout;
  process.stdout.write = capture;
  process.stderr.write = capture;
  try {
    const result = await run();
    await new Promise<void>((resolve) => setImmediate(resolve));
    return { result, logs: logs.join("") };
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
}

const add = (id: string, narration = `步骤 ${id}`) => ({
  name: "add_step",
  input: {
    id,
    narration,
    target: { kind: "statement", blockId: "intro" },
  },
});
const finish = { name: "finish", input: {} };

function answerPayload(id: string, stepId: string, createdAt = "2026-10-13T08:00:00.000Z") {
  return JSON.stringify({
    v: 1,
    id,
    stepId,
    question: "为什么？",
    selection: { mode: "single", bbox: { x: 0, y: 0, width: 8, height: 8 }, targets: [] },
    segments: [{ id: "seg", narration: "因为查找。" }],
    createdAt,
  });
}

describe("lecture answers route", () => {
  let f: Awaited<ReturnType<typeof createFixture>>;
  let POST: typeof import("../app/api/lecture/route").POST;

  beforeAll(async () => {
    f = await createFixture();
    ({ POST } = await import("../app/api/lecture/route"));
    await f.save({
      apiKey: "saved-test-key",
      model: "test-model",
      provider: "openai-compatible",
      baseURL: f.baseURL,
    });
  });

  beforeEach(async () => {
    f.setDelay(0);
    f.setReply(() => "placeholder");
    await f.prisma.lectureAnswer.deleteMany();
    await f.prisma.lectureScriptCache.deleteMany();
  });

  afterAll(async () => {
    await f?.close();
  });

  test("9. 第一次工具返回重复 step id，重试合法教案后写入缓存", async () => {
    let round = 0;
    f.setToolsReply(() => {
      round += 1;
      if (round === 1) return [add("s1", "先看题意"), add("s1", "重复编号"), finish];
      return [add("s2", "合法的第二步"), finish];
    });

    const response = await POST(request({ slug: "3sum" }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.cached).toBe(false);
    expect(body.script.steps.map((step: { id: string }) => step.id)).toEqual(["s1", "s2"]);
    expect(round).toBeGreaterThan(1);
    expect(await f.prisma.lectureScriptCache.count()).toBe(1);

    const before = f.calls.length;
    const cached = await POST(request({ slug: "3sum" }));
    expect((await cached.json()).cached).toBe(true);
    expect(f.calls.length).toBe(before);
  });

  test("10. 旧缓存含重复 step id：200、不删缓存、禁用 id 正确、只 warn 一次", async () => {
    f.setToolsReply(() => [add("s1", "占位教案"), finish]);
    const seeded = await (await POST(request({ slug: "3sum" }))).json();
    const duplicate = {
      problemSlug: "3sum",
      mode: "lecture",
      language: "zh",
      solutionLanguage: "typescript",
      steps: [
        { id: "a", narration: "题意介绍", targets: [{ kind: "statement", blockId: "intro" }], effects: [] },
        { id: "b", narration: "核心洞察", targets: [{ kind: "statement", blockId: "insight" }], effects: [] },
        { id: "a", narration: "再讲一次", targets: [{ kind: "statement", blockId: "summary" }], effects: [] },
        { id: "", narration: "空编号", targets: [{ kind: "statement", blockId: "summary" }], effects: [] },
      ],
    };
    await f.prisma.lectureScriptCache.update({
      where: { key: seeded.cacheKey },
      data: { script: JSON.stringify(duplicate) },
    });
    const before = f.calls.length;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const response = await POST(request({ slug: "3sum" }));
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.cached).toBe(true);
      expect(body.cacheKey).toBe(seeded.cacheKey);
      expect(body.askDisabledStepIds).toEqual(["a", ""]);
      expect(body.scriptVersion).toMatch(/^[0-9a-f]{40}$/);
      expect(f.calls.length).toBe(before);
      const row = await f.prisma.lectureScriptCache.findUnique({ where: { key: seeded.cacheKey } });
      expect(row?.script).toBe(JSON.stringify(duplicate));
      const duplicateWarns = warn.mock.calls.filter((call) => call[0] === "[lecture] cached script has duplicate step ids");
      expect(duplicateWarns).toHaveLength(1);
      expect(duplicateWarns[0]?.[1]).toEqual({ key: seeded.cacheKey, count: 2 });
    } finally {
      warn.mockRestore();
    }
  });

  test("13. 缓存命中只返回当前 scriptVersion 的回答", async () => {
    f.setToolsReply(() => [add("s1", "只讲一步"), finish]);
    const created = await (await POST(request({ slug: "3sum" }))).json();
    await f.prisma.lectureAnswer.create({
      data: {
        id: "current",
        cacheKey: created.cacheKey,
        scriptVersion: created.scriptVersion,
        stepId: "s1",
        payload: answerPayload("current", "s1", "2026-10-13T09:00:00.000Z"),
      },
    });
    await f.prisma.lectureAnswer.create({
      data: {
        id: "old-version",
        cacheKey: created.cacheKey,
        scriptVersion: "a".repeat(40),
        stepId: "s1",
        payload: answerPayload("old-version", "s1", "2026-10-13T08:00:00.000Z"),
      },
    });

    const response = await POST(request({ slug: "3sum" }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.cached).toBe(true);
    expect(body.scriptVersion).toBe(created.scriptVersion);
    expect(body.answers.s1?.map((answer: { id: string }) => answer.id)).toEqual(["current"]);
    expect(JSON.stringify(body.answers)).not.toContain("old-version");
    expect(await f.prisma.lectureAnswer.count()).toBe(2);
  });

  test("14. 缓存命中时 listAnswers 抛错：200、cached、answers 为空、不删缓存", async () => {
    f.setToolsReply(() => [add("s1", "只讲一步"), finish]);
    const created = await (await POST(request({ slug: "3sum" }))).json();
    const findMany = vi.spyOn(f.prisma.lectureAnswer, "findMany").mockRejectedValue(new Error("db down"));
    const deleteCache = vi.spyOn(f.prisma.lectureScriptCache, "delete");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const response = await POST(request({ slug: "3sum" }));
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.cached).toBe(true);
      expect(body.answers).toEqual({});
      expect(body.scriptVersion).toBe(created.scriptVersion);
      expect(deleteCache).not.toHaveBeenCalled();
      expect(await f.prisma.lectureScriptCache.count()).toBe(1);
      const listWarns = warn.mock.calls.filter((call) => call[0] === "[lecture] listAnswers failed");
      expect(listWarns).toHaveLength(1);
      expect(listWarns[0]?.[1]).toEqual({ key: created.cacheKey });
    } finally {
      findMany.mockRestore();
      deleteCache.mockRestore();
      warn.mockRestore();
    }
  });

  test("16. 公开实例不查询 LectureAnswer，answers 为空，scriptVersion 仍下发", async () => {
    vi.stubEnv("ALGOSTAGE_DISABLE_SERVER_KEY", "1");
    const findMany = vi.spyOn(f.prisma.lectureAnswer, "findMany");
    const deleteMany = vi.spyOn(f.prisma.lectureAnswer, "deleteMany");
    const byok = {
      provider: "openai-compatible" as const,
      model: "test-model",
      apiKey: "public-instance-request-key",
      baseURL: f.baseURL,
    };
    try {
      f.setToolsReply(() => [add("s1", "公开实例"), finish]);
      const createdResponse = await POST(request({ slug: "3sum", byok }));
      expect(createdResponse.status).toBe(200);
      const created = await createdResponse.json();
      expect(created.answers).toEqual({});
      expect(created.scriptVersion).toMatch(/^[0-9a-f]{40}$/);
      await f.prisma.lectureAnswer.create({
        data: {
          id: "hidden",
          cacheKey: created.cacheKey,
          scriptVersion: created.scriptVersion,
          stepId: "s1",
          payload: answerPayload("hidden", "s1"),
        },
      });
      const cachedResponse = await POST(request({ slug: "3sum", byok }));
      const cached = await cachedResponse.json();
      expect(cached.cached).toBe(true);
      expect(cached.answers).toEqual({});
      expect(cached.scriptVersion).toMatch(/^[0-9a-f]{40}$/);
      expect(cached.scriptVersion).toBe(scriptVersion(cached.script));
      expect(findMany).not.toHaveBeenCalled();

      f.setToolsReply(() => [add("s1", "公开实例重讲"), finish]);
      const regeneratedResponse = await POST(request({ slug: "3sum", byok, regenerate: true }));
      expect(regeneratedResponse.status).toBe(200);
      const regenerated = await regeneratedResponse.json();
      expect(regenerated.cached).toBe(false);
      expect(regenerated.answers).toEqual({});
      expect(regenerated.script.steps[0].narration).toBe("公开实例重讲");
      expect(deleteMany).not.toHaveBeenCalled();
      expect(findMany).not.toHaveBeenCalled();
      expect(await f.prisma.lectureAnswer.count()).toBe(1);
    } finally {
      deleteMany.mockRestore();
      findMany.mockRestore();
      vi.stubEnv("ALGOSTAGE_DISABLE_SERVER_KEY", "");
    }
  });

  test("17. 新生成的 JSON 与 NDJSON result 都带 scriptVersion、answers 和 askDisabledStepIds", async () => {
    f.setToolsReply(() => [add("s1", "先讲题意"), finish]);
    const jsonResponse = await POST(request({ slug: "3sum" }));
    expect(jsonResponse.status).toBe(200);
    const json = await jsonResponse.json();
    expect(json.cached).toBe(false);
    expect(json.answers).toEqual({});
    expect(json.askDisabledStepIds).toEqual([]);
    expect(json.cacheKey).toMatch(/^[0-9a-f]{40}$/);
    expect(json.scriptVersion).toMatch(/^[0-9a-f]{40}$/);
    expect(json.scriptVersion).toBe(scriptVersion(json.script));

    await f.prisma.lectureScriptCache.deleteMany();
    const streamed = await POST(new NextRequest("http://localhost/api/lecture", {
      method: "POST",
      headers: { Accept: "application/x-ndjson", "Content-Type": "application/json" },
      body: JSON.stringify({ slug: "3sum" }),
    }));
    expect(streamed.headers.get("content-type")).toContain("application/x-ndjson");
    const events = (await streamed.text()).trim().split("\n").map((line) => JSON.parse(line));
    const result = events.find((event) => event.type === "result");
    expect(result.cached).toBe(false);
    expect(result.answers).toEqual({});
    expect(result.askDisabledStepIds).toEqual([]);
    expect(result.cacheKey).toMatch(/^[0-9a-f]{40}$/);
    expect(result.scriptVersion).toMatch(/^[0-9a-f]{40}$/);
    expect(result.scriptVersion).toBe(scriptVersion(result.script));
  });

  test("18. 重新生成成功清空回答；失败或取消保留回答", async () => {
    f.setToolsReply(() => [add("s1", "旧教案"), finish]);
    const first = await (await POST(request({ slug: "3sum" }))).json();
    await f.prisma.lectureAnswer.create({
      data: {
        id: "stale",
        cacheKey: first.cacheKey,
        scriptVersion: first.scriptVersion,
        stepId: "s1",
        payload: answerPayload("stale", "s1"),
      },
    });

    f.setToolsReply(() => [add("s1", "新教案"), finish]);
    const regenerated = await POST(request({ slug: "3sum", regenerate: true }));
    expect(regenerated.status).toBe(200);
    expect((await regenerated.json()).script.steps[0].narration).toBe("新教案");
    expect(await f.prisma.lectureAnswer.count()).toBe(0);

    await f.prisma.lectureAnswer.create({
      data: {
        id: "kept-on-failure",
        cacheKey: first.cacheKey,
        scriptVersion: first.scriptVersion,
        stepId: "s1",
        payload: answerPayload("kept-on-failure", "s1"),
      },
    });
    f.setToolsReply(() => [{
      name: "add_step",
      input: { id: "s1", narration: "坏脚本", target: { type: "code-line", line: 3 } },
    }]);
    expect((await POST(request({ slug: "3sum", regenerate: true }))).status).toBe(422);
    expect(await f.prisma.lectureAnswer.count()).toBe(1);

    f.setToolsReply(() => [add("s1", "不应写入的新教案"), finish]);
    f.setDelay(300);
    const abort = new AbortController();
    const pending = POST(new NextRequest("http://localhost/api/lecture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug: "3sum", regenerate: true }),
      signal: abort.signal,
    }));
    setTimeout(() => abort.abort(), 50);
    expect((await pending).status).not.toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await f.prisma.lectureAnswer.count()).toBe(1);
    const row = await f.prisma.lectureScriptCache.findUnique({ where: { key: first.cacheKey } });
    expect(row?.script).toContain("新教案");
  });

  test("19. 删除缓存行时回答级联删除", async () => {
    f.setToolsReply(() => [add("s1", "级联"), finish]);
    const body = await (await POST(request({ slug: "3sum" }))).json();
    await f.prisma.lectureAnswer.createMany({
      data: [
        {
          id: "cascade-1",
          cacheKey: body.cacheKey,
          scriptVersion: body.scriptVersion,
          stepId: "s1",
          payload: answerPayload("cascade-1", "s1"),
        },
        {
          id: "cascade-2",
          cacheKey: body.cacheKey,
          scriptVersion: "b".repeat(40),
          stepId: "s1",
          payload: answerPayload("cascade-2", "s1", "2026-10-13T07:00:00.000Z"),
        },
      ],
    });
    expect(await f.prisma.lectureAnswer.count()).toBe(2);
    await f.prisma.lectureScriptCache.delete({ where: { key: body.cacheKey } });
    expect(await f.prisma.lectureAnswer.count()).toBe(0);
  });

  test("20. 新生成的 scriptVersion 与把 upsert 脚本当作缓存再读时一致", async () => {
    f.setToolsReply(() => [add("s1", "版本稳定"), finish]);
    const createdResponse = await POST(request({ slug: "3sum" }));
    expect(createdResponse.status).toBe(200);
    const created = await createdResponse.json();
    const stored = await f.prisma.lectureScriptCache.findUnique({ where: { key: created.cacheKey } });
    expect(stored?.script).toEqual(expect.any(String));
    await f.prisma.lectureScriptCache.deleteMany();
    await f.prisma.lectureScriptCache.create({
      data: { key: created.cacheKey, script: stored!.script },
    });
    const before = f.calls.length;
    const cachedResponse = await POST(request({ slug: "3sum" }));
    expect(cachedResponse.status).toBe(200);
    const cached = await cachedResponse.json();
    expect(f.calls.length).toBe(before);
    expect(cached.cached).toBe(true);
    expect(cached.scriptVersion).toBe(created.scriptVersion);
    expect(cached.scriptVersion).toBe(scriptVersion(cached.script));
  });

  test("21. 请求 Key 不出现在响应正文或日志里", async () => {
    const apiKey = "request-key-lecture-answers-21";
    const byok = {
      provider: "openai-compatible" as const,
      model: "test-model",
      apiKey,
      baseURL: f.baseURL,
    };
    f.setToolsReply(() => [add("s1", "不记录密钥"), finish]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { result: createdResponse, logs: createdLogs } = await captureLogs(() => POST(request({ slug: "3sum", byok })));
      const createdText = await createdResponse.text();
      expect(createdResponse.status).toBe(200);
      expect(createdText).not.toContain(apiKey);
      expect(createdLogs).not.toContain(apiKey);
      expect(warn.mock.calls.flat().join(" ")).not.toContain(apiKey);
      expect(error.mock.calls.flat().join(" ")).not.toContain(apiKey);

      const { result: cachedResponse, logs: cachedLogs } = await captureLogs(() => POST(request({ slug: "3sum", byok })));
      const cachedText = await cachedResponse.text();
      expect(cachedText).not.toContain(apiKey);
      expect(cachedLogs).not.toContain(apiKey);
      const stored = await f.prisma.lectureScriptCache.findMany();
      expect(JSON.stringify(stored)).not.toContain(apiKey);
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });
});
