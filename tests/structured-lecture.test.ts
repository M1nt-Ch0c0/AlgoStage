import assert from "node:assert/strict";
import { afterAll, beforeAll, describe, test } from "vitest";
import { createFixture, request } from "./api-fixture";
import { validateScript } from "../lib/teaching/validated-script";
import { readLectureResponse } from "../lib/player/lecture-response";
import { usePlayerStore } from "../lib/player/store";
import { NextRequest } from "next/server";
const metadata = {
  problemSlug: "3sum",
  mode: "lecture" as const,
  language: "zh" as const,
  solutionLanguage: "typescript" as const,
};
const step = (id: string, line = 1) => ({
  id,
  narration: `步骤 ${id}`,
  target: { kind: "code-line", start: line },
});
const streamedRequest = () =>
  new NextRequest("http://localhost/api/lecture", {
    method: "POST",
    headers: {
      Accept: "application/x-ndjson",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ slug: "3sum" }),
  });

describe("工具教案：单调用修复、白名单、流式播放、失败不缓存及总超时", () => {
  let f: Awaited<ReturnType<typeof createFixture>>;
  let POST: typeof import("../app/api/lecture/route").POST;
  let generateLecture: typeof import("../lib/agent/lecture-generation").generateLecture;
  let config: import("../lib/agent/provider").ByokConfig;
  // 在测试执行期建立共享 fixture，全部子测试结束后才关闭。
  beforeAll(async () => {
    f = await createFixture();
    ({ POST } = await import("../app/api/lecture/route"));
    ({ generateLecture } = await import("../lib/agent/lecture-generation"));
    config = {
      provider: "openai-compatible",
      model: "gpt-6.1-sol",
      apiKey: "fake-tool-key",
      baseURL: f.baseURL,
    };
    await f.save({ ...config, baseURL: f.baseURL });
  });
  afterAll(async () => {
    await f?.close();
  });
  test("非法 add_step / set_viz 只重试该调用，原步骤立即播放且保留", async () => {
    let round = 0;
    f.setDelay(40);
    f.setToolsReply(() => {
      switch (++round) {
        case 1:
          return [
            { name: "add_step", input: step("s1") },
            { name: "add_step", input: step("s2", 999) },
          ];
        case 2:
          return [{ name: "add_step", input: step("s2", 2) }];
        case 3:
          return [
            {
              name: "highlight_lines",
              input: { stepId: "s2", start: 2, end: 3 },
            },
            {
              name: "set_effect",
              input: { stepId: "s2", effect: "spotlight-beam" },
            },
            {
              name: "set_viz",
              input: {
                stepId: "s2",
                viz: { type: "array", state: { values: "bad" } },
              },
            },
          ];
        case 4:
          return [
            {
              name: "set_viz",
              input: {
                stepId: "s2",
                viz: {
                  type: "array",
                  state: { values: [2, 7], highlight: [1] },
                },
              },
            },
          ];
        default:
          return [{ name: "finish", input: {} }];
      }
    });
    const logs: string[] = [],
      warn = console.warn;
    console.warn = (...args) => logs.push(args.join(" "));
    const received: string[] = [],
      progress: string[] = [];
    let first = 0;
    const start = performance.now();
    try {
      const response = await POST(streamedRequest());
      const script = await readLectureResponse(
        response,
        (m) => progress.push(m),
        (s, update) => {
          if (!update) {
            received.push(s.id);
            first ||= performance.now() - start;
          }
        },
      );
      const valid = validateScript(script, "a\nb\nc");
      assert.deepEqual(
        valid.steps.map((s) => s.id),
        ["s1", "s2"],
      );
      assert.deepEqual(received, ["s1", "s2"]);
      assert.equal(valid.steps[1].targets[0].kind, "code-line");
      assert.deepEqual(valid.steps[1].viz?.state, {
        values: [2, 7],
        highlight: [1],
      });
      assert.ok(first > 0 && first < performance.now() - start - 60);
      assert.ok(progress.some((m) => m.includes("正在重试该调用")));
      assert.equal(round, 5);
      assert.equal(await f.prisma.lectureScriptCache.count(), 1);
      assert.ok(
        logs.some(
          (l) =>
            l.includes('"fields":["target.start"]') &&
            l.includes('"attempt":1'),
        ),
      );
      assert.ok(logs.some((l) => l.includes('"fields":["viz.state.values"]')));
      assert.ok(!logs.join("").includes(config.apiKey));
      const requests = f.requests;
      assert.deepEqual(requests[1].tool_choice, {
        type: "function",
        function: { name: "add_step" },
      });
      assert.deepEqual(requests[3].tool_choice, {
        type: "function",
        function: { name: "set_viz" },
      });
      assert.ok(requests.every((r) => !r.response_format));
      const tools = requests[0].tools as {
        function: {
          name: string;
          description: string;
          parameters: unknown;
        };
      }[];
      assert.deepEqual(
        tools.map((t) => t.function.name),
        ["add_step", "highlight_lines", "set_effect", "set_viz", "finish"],
      );
      assert.ok(
        tools.every((t) => t.function.description && t.function.parameters),
      );
      const feedback = JSON.stringify(requests[1].messages);
      assert.ok(
        feedback.includes("target.start") &&
          feedback.includes("只重新调用 add_step"),
      );
      assert.ok(!logs.join("").includes("responseFormat"));
    } finally {
      console.warn = warn;
      f.setDelay(0);
    }
  });
  test("deepseek-flash 故障注入：连续非法特效迅速失败、不缓存并提示推荐模型", async () => {
    await f.prisma.lectureScriptCache.deleteMany();
    let n = 0;
    f.setToolsReply(() =>
      ++n === 1
        ? [
            { name: "add_step", input: step("s1") },
            {
              name: "set_effect",
              input: { stepId: "s1", effect: "unknown-effect" },
            },
          ]
        : [
            {
              name: "set_effect",
              input: { stepId: "s1", effect: "unknown-effect" },
            },
          ],
    );
    const started = performance.now();
    const response = await POST(
      request({
        slug: "3sum",
        byok: { ...config, model: "deepseek-flash" },
      }),
    );
    assert.ok(performance.now() - started < 3000);
    assert.equal(response.status, 422);
    const data = await response.json();
    assert.equal(data.error, "INVALID_SCRIPT");
    assert.match(data.message, /gpt-6.1-sol/);
    assert.equal(n, 3);
    assert.equal(await f.prisma.lectureScriptCache.count(), 0);
  });
  test("修复必须针对原步骤，同轮修复后可继续生成且不会丢失错误", async () => {
    await f.prisma.lectureScriptCache.deleteMany();
    let round = 0;
    f.setToolsReply(() => {
      switch (++round) {
        case 1:
          return [
            { name: "add_step", input: step("s1") },
            { name: "add_step", input: step("s2", 2) },
            {
              name: "set_effect",
              input: { stepId: "s1", effect: "bad" },
            },
          ];
        case 2:
          return [
            {
              name: "set_effect",
              input: { stepId: "s2", effect: "focus-dim" },
            },
          ];
        default:
          return [
            {
              name: "set_effect",
              input: { stepId: "s1", effect: "focus-dim" },
            },
            { name: "add_step", input: step("s3", 3) },
            { name: "finish", input: {} },
          ];
      }
    });
    const response = await POST(request({ slug: "3sum" }));
    assert.equal(response.status, 200);
    const script = (await response.json()).script;
    assert.deepEqual(
      script.steps.map((s: { id: string }) => s.id),
      ["s1", "s2", "s3"],
    );
    assert.ok(
      script.steps[0].effects.some(
        (e: { effect: string }) => e.effect === "focus-dim",
      ),
    );
    assert.ok(
      !script.steps[1].effects.some(
        (e: { effect: string }) => e.effect === "focus-dim",
      ),
    );
    assert.equal(round, 3);
    await f.prisma.lectureScriptCache.deleteMany();
  });
  test("未知 viz、逆序/越界行号、非法下标均拒绝且不修改成功步骤", async () => {
    const { createLectureTools } = await import("../lib/agent/lecture-tools");
    const kit = createLectureTools("a\nb\nc\n\n  \n");
    kit.apply("add_step", step("s1"));
    for (const input of [
      { stepId: "s1", start: 4 },
      { stepId: "s1", start: 3, end: 1 },
      { stepId: "s1", start: 0 },
    ])
      assert.throws(() => kit.apply("highlight_lines", input));
    for (const viz of [
      { type: "tree", state: {} },
      { type: "array", state: { values: [1], highlight: [1] } },
      { type: "array", state: { values: "bad" } },
    ])
      assert.throws(() => kit.apply("set_viz", { stepId: "s1", viz }));
    assert.throws(() =>
      kit.apply("set_effect", {
        stepId: "s1",
        effect: "spotlight-beam",
        targetIndex: 2,
      }),
    );
    assert.deepEqual(kit.steps[0].targets, [{ kind: "code-line", start: 1 }]);
    assert.equal(kit.steps[0].viz, undefined);
  });
  test("共享总超时取消上游，返回 TIMEOUT，不缓存", async () => {
    f.setDelay(200);
    f.setToolsReply(() => [{ name: "add_step", input: step("s1") }]);
    const start = performance.now();
    const result = await generateLecture({
      config,
      prompt: "工具教案",
      metadata,
      referenceCode: "a\nb",
      validate: (value) => validateScript(value, "a\nb"),
      timeoutMs: 80,
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error, "TIMEOUT");
      assert.equal(result.status, 504);
      assert.match(result.message, /超时.*gpt-6.1-sol/);
    }
    assert.ok(performance.now() - start < 600);
    assert.equal(await f.prisma.lectureScriptCache.count(), 0);
    f.setDelay(0);
  });
  test("收到首步后取消流，不写缓存", async () => {
    let n = 0;
    f.setToolsReply(() =>
      ++n === 1
        ? [{ name: "add_step", input: step("s1") }]
        : [{ name: "finish", input: {} }],
    );
    const response = await POST(streamedRequest()),
      reader = response.body!.getReader();
    let text = "";
    while (!text.includes('"type":"step"'))
      text += new TextDecoder().decode((await reader.read()).value);
    f.setDelay(150);
    await reader.cancel();
    await new Promise((resolve) => setTimeout(resolve, 220));
    assert.equal(await f.prisma.lectureScriptCache.count(), 0);
    f.setDelay(0);
  });
  test("finish 的整份校验失败也只重试该调用，达到上限即失败", async () => {
    let round = 0;
    f.setToolsReply(() =>
      ++round === 1
        ? [
            { name: "add_step", input: step("s1") },
            { name: "finish", input: {} },
          ]
        : [{ name: "finish", input: {} }],
    );
    const result = await generateLecture({
      config,
      prompt: "工具教案",
      metadata,
      referenceCode: "a",
      validate: () => {
        throw new Error("invalid final script");
      },
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error, "INVALID_SCRIPT");
    assert.equal(round, 3);
    assert.equal(await f.prisma.lectureScriptCache.count(), 0);
  });
  test("上游流断开只重试本轮，已播放步骤不重复；连续断开不缓存", async () => {
    await f.prisma.lectureScriptCache.deleteMany();
    let round = 0;
    f.setStreamFailures(1);
    f.setToolsReply(() =>
      ++round === 1
        ? [{ name: "add_step", input: step("s1") }]
        : [
            { name: "add_step", input: step("s2") },
            { name: "finish", input: {} },
          ],
    );
    const seen: string[] = [],
      progress: string[] = [];
    const script = await readLectureResponse(
      await POST(streamedRequest()),
      (m) => progress.push(m),
      (s, update) => {
        if (!update) seen.push(s.id);
      },
    );
    assert.deepEqual(seen, ["s1", "s2"]);
    assert.ok(validateScript(script, "a"));
    assert.ok(progress.some((m) => m.includes("模型连接中断")));
    assert.equal(round, 2);
    assert.equal(await f.prisma.lectureScriptCache.count(), 1);
    await f.prisma.lectureScriptCache.deleteMany();
    f.setStreamFailures(2);
    f.setToolsReply(() => []);
    const before = f.calls.length;
    const response = await POST(request({ slug: "3sum" }));
    assert.equal(response.status, 502);
    assert.equal(f.calls.length - before, 2);
    assert.equal(await f.prisma.lectureScriptCache.count(), 0);
  });
  test("工具修复与上游重试都计入进度，后续成功步骤不使 attempt 倒退", async () => {
    let round = 0;
    f.setStreamFailures(1);
    f.setToolsReply(() => {
      switch (++round) {
        case 1: return [{ name: "add_step", input: step("s1") }];
        case 2: return [{ name: "add_step", input: step("s2", 999) }];
        case 3: return [{ name: "add_step", input: step("s2", 2) }];
        default: return [{ name: "finish", input: {} }];
      }
    });
    const attempts: number[] = [];
    const result = await generateLecture({
      config, prompt: "工具教案", metadata, referenceCode: "a\nb",
      validate: value => validateScript(value, "a\nb"),
      onEvent: event => { if (event.type === "progress") attempts.push(event.attempt); },
    });
    assert.equal(result.ok, true);
    assert.ok(attempts.includes(2));
    assert.equal(attempts.at(-1), 3);
    for (let i = 1; i < attempts.length; i++) assert.ok(attempts[i] >= attempts[i - 1]);
  });
  test("DeepSeek 直接工具模式关闭不兼容的默认推理，没有 response_format", async () => {
    f.setRequireNonThinkingTools(true);
    await f.save({ model: "deepseek-flash" });
    f.setToolsReply(() => [
      { name: "add_step", input: step("s1") },
      { name: "finish", input: {} },
    ]);
    const response = await POST(request({ slug: "3sum" }));
    assert.equal(response.status, 200);
    assert.deepEqual(f.requests.at(-1)!.thinking, { type: "disabled" });
    assert.equal(f.requests.at(-1)!.response_format, undefined);
  });
});

test("流播放器：收到步骤就播放，等待后续步骤，暂停不被新步骤打断，完成不跳回首步", () => {
  const store = usePlayerStore;
  store.getState().reset();
  store.getState().beginStream(metadata);
  const first = validateScript(
    {
      ...metadata,
      steps: [
        {
          id: "s1",
          narration: "第一步",
          targets: [{ kind: "code-line", start: 1 }],
        },
      ],
    },
    "a",
  ).steps[0];
  store.getState().appendStep(first);
  assert.equal(store.getState().status, "playing");
  store.getState().next();
  assert.equal(store.getState().status, "streaming");
  store.getState().appendStep({ ...first, id: "s2" });
  assert.equal(store.getState().currentIndex, 1);
  assert.equal(store.getState().status, "playing");
  store.getState().pause();
  store.getState().appendStep({ ...first, id: "s3" });
  assert.equal(store.getState().status, "paused");
  assert.equal(store.getState().currentIndex, 1);
  store
    .getState()
    .completeStream({ ...metadata, steps: store.getState().steps });
  assert.equal(store.getState().currentIndex, 1);
  assert.equal(store.getState().receiving, false);
  store.getState().beginStream(metadata);
  store.getState().appendStep(first);
  store.getState().next();
  store.getState().goto(0);
  assert.equal(store.getState().status, "playing");
  store.getState().next();
  store.getState().prev();
  assert.equal(store.getState().status, "playing");
  store.getState().reset();
  store.getState().stopStream();
  assert.equal(store.getState().status, "idle");
});

test("进度/步骤流跨字节分片读取，超时与中断提示重试", async () => {
  const text =
    JSON.stringify({
      type: "progress",
      attempt: 2,
      message: "正在重试该调用",
    }) +
    "\n" +
    JSON.stringify({
      type: "error",
      code: "TIMEOUT",
      retryable: true,
    }) +
    "\n";
  const bytes = new TextEncoder().encode(text),
    messages: string[] = [];
  const response = new Response(
    new ReadableStream({
      start(c) {
        for (let i = 0; i < bytes.length; i += 3)
          c.enqueue(bytes.slice(i, i + 3));
        c.close();
      },
    }),
    { headers: { "Content-Type": "application/x-ndjson" } },
  );
  await assert.rejects(
    readLectureResponse(response, (m) => messages.push(m)),
    /备课超时（总上限 240 秒），未保存教案。/,
  );
  assert.deepEqual(messages, ["正在重试该调用"]);
});
