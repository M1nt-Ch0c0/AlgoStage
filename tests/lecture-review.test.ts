import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { createFixture, request } from "./api-fixture";
import { createLectureTools } from "../lib/agent/lecture-tools";

let f: Awaited<ReturnType<typeof createFixture>>;
let POST: typeof import("../app/api/lecture/route").POST;
beforeAll(async () => {
  f = await createFixture();
  ({ POST } = await import("../app/api/lecture/route"));
  await f.save({ provider: "openai-compatible", model: "review-model", apiKey: "fake-review-key", baseURL: f.baseURL });
});
beforeEach(async () => { await f.prisma.lectureScriptCache.deleteMany(); });
afterAll(async () => { await f?.close(); });
const add = (id: string, start = 1) => ({ name: "add_step", input: { id, narration: `步骤 ${id}`, target: { kind: "code-line", start } } });
const finish = { name: "finish", input: {} };

test("P1：s2、s3 同时排队，同批修复并 finish，无残留或重复步骤", async () => {
  let round = 0;
  f.setToolsReply(() => ++round === 1
    ? [add("s1"), add("s2", 999), add("s3", 999), finish]
    : [add("s2", 2), add("s3", 3), finish]);
  const response = await POST(request({ slug: "3sum" }));
  expect(response.status).toBe(200);
  expect((await response.json()).script.steps.map((step: { id: string }) => step.id)).toEqual(["s1", "s2", "s3"]);
  expect(round).toBe(2);
  expect(await f.prisma.lectureScriptCache.count()).toBe(1);
});

test("P1：同一步的不同工具分别出队，其他步骤的待修复调用也保留", async () => {
  let round = 0;
  const effect = (stepId: string, value: string) => ({ name: "set_effect", input: { stepId, effect: value } });
  const viz = (values: unknown) => ({ name: "set_viz", input: { stepId: "s1", viz: { type: "array", state: { values } } } });
  f.setToolsReply(() => ++round === 1
    ? [add("s1"), add("s2"), effect("s1", "bad"), viz("bad"), effect("s2", "bad")]
    : [effect("s1", "focus-dim"), viz([1, 2]), effect("s2", "attention-ripple"), finish]);
  const response = await POST(request({ slug: "3sum" }));
  expect(response.status).toBe(200);
  const script = (await response.json()).script;
  expect(script.steps[0].viz.state.values).toEqual([1, 2]);
  expect(script.steps[0].effects.some((e: { effect: string }) => e.effect === "focus-dim")).toBe(true);
  expect(script.steps[1].effects.some((e: { effect: string }) => e.effect === "attention-ripple")).toBe(true);
  expect(round).toBe(2);
});

test.each([add("s2"), { name: "highlight_lines", input: { stepId: "s1", start: 999 } }, finish])("finish 后的同批调用一律拒绝，不写缓存（$name）", async extra => {
  f.setToolsReply(() => [add("s1"), finish, extra]);
  const response = await POST(request({ slug: "3sum" }));
  expect(response.status).toBe(422);
  expect((await response.json()).error).toBe("INVALID_SCRIPT");
  expect(await f.prisma.lectureScriptCache.count()).toBe(0);
});

test("finish 不能掩盖未正常结束的上游流，不缓存截断输出", async () => {
  f.setStreamFailures(2);
  f.setToolsReply(() => [add("s1"), finish]);
  const response = await POST(request({ slug: "3sum" }));
  expect(response.ok).toBe(false);
  expect(await f.prisma.lectureScriptCache.count()).toBe(0);
  f.setStreamFailures(0);
});

test("工具行号忽略末尾空行，仍保留中间空行的真实位置", () => {
  const kit = createLectureTools("第一行\n\n第三行\n\n  \n");
  expect(() => kit.apply("add_step", add("s1", 3).input)).not.toThrow();
  expect(() => kit.apply("highlight_lines", { stepId: "s1", start: 4 })).toThrow();
  expect(() => kit.apply("highlight_lines", { stepId: "s1", start: 2 })).not.toThrow();
});

test("缓存按提供商和接口地址隔离，同名模型换接口必须重新生成", async () => {
  f.setToolsReply(() => [add("s1"), finish]);
  const byok = { provider: "openai-compatible", model: "same-model", apiKey: "fake-review-key", baseURL: f.baseURL };
  const first = await POST(request({ slug: "3sum", byok }));
  expect((await first.json()).cached).toBe(false);
  const before = f.calls.length;
  expect((await (await POST(request({ slug: "3sum", byok }))).json()).cached).toBe(true);
  expect(f.calls.length).toBe(before);
  const changed = await POST(request({ slug: "3sum", byok: { ...byok, baseURL: `${f.baseURL}/another-provider` } }));
  expect((await changed.json()).cached).toBe(false);
  expect(f.calls.length).toBe(before + 1);
  expect(await f.prisma.lectureScriptCache.count()).toBe(2);
});
