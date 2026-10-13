import { expect, test, vi } from "vitest";
import { readLectureMeta, readLectureResponse } from "../lib/player/lecture-response";

const headers = { "Content-Type": "application/x-ndjson" };
const step = { id: "s1", narration: "首步", targets: [{ kind: "statement", blockId: "intro" }], effects: [] };

test("上游返回 HTML 错误页时使用固定提示，不把响应正文展示给学生", async () => {
  const response = new Response("<html>fake-private-token</html>", { status: 502 });
  await expect(readLectureResponse(response, () => {})).rejects.toThrow("这次备课未能完成，请重试或换用 gpt-6.1-sol。");
});

test("缓存 JSON 直接返回脚本，无响应体的流明确报错", async () => {
  const script = { steps: [step] };
  expect(await readLectureResponse(Response.json({ script }), () => {})).toEqual(script);
  await expect(readLectureResponse(new Response(null, { headers }), () => {})).rejects.toThrow("没有收到教案");
});

test.each([
  [{ type: "progress", attempt: 0, message: "错误次数" }, /数据无法读取/],
  [{ type: "unknown" }, /数据无法读取/],
  [{ type: "error", message: 7 }, /备课失败.*重试/],
  [{ type: "step", step: { ...step, targets: [{ kind: "code-line", start: -1 }] } }, /./],
])("拒绝非法流事件并取消后续读取：%j", async (event, error) => {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify(event) + "\n")); },
    cancel() { cancelled = true; },
  });
  const onStep = vi.fn(), onProgress = vi.fn();
  await expect(readLectureResponse(new Response(body, { headers }), onProgress, onStep)).rejects.toThrow(error);
  expect(onStep).not.toHaveBeenCalled();
  expect(onProgress).not.toHaveBeenCalled();
  expect(cancelled).toBe(true);
  expect(body.locked).toBe(false);
});

test("只有部分步骤没有最终结果，不能被当成完成的教案", async () => {
  const onStep = vi.fn();
  const text = `\n${JSON.stringify({ type: "step", step })}\n`;
  await expect(readLectureResponse(new Response(text, { headers }), () => {}, onStep)).rejects.toThrow("未收到完整教案");
  expect(onStep).toHaveBeenCalledWith(step, false);
});

test("超出缓冲上限的无换行响应被拒绝并取消请求", async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode("x".repeat(1024 * 1024 + 1))); },
    cancel() { cancelled = true; },
  });
  await expect(readLectureResponse(new Response(body, { headers }), () => {})).rejects.toThrow("教案数据过大");
  expect(cancelled).toBe(true);
  expect(body.locked).toBe(false);
});

test("20. 旧响应缺字段时 readLectureMeta 使用空默认值", () => {
  const empty = { cacheKey: "", scriptVersion: "", answers: {}, askDisabledStepIds: [] };
  expect(readLectureMeta(undefined)).toEqual(empty);
  expect(readLectureMeta(null)).toEqual(empty);
  expect(readLectureMeta({})).toEqual(empty);
  expect(readLectureMeta({ script: { steps: [] } })).toEqual(empty);
  expect(readLectureMeta({
    cacheKey: 12,
    scriptVersion: null,
    answers: "nope",
    askDisabledStepIds: ["s1", 2],
  })).toEqual(empty);
  expect(readLectureMeta({ askDisabledStepIds: "s1" }).askDisabledStepIds).toEqual([]);

  const answer = {
    v: 1,
    id: "a1",
    stepId: "s1",
    question: "为什么？",
    selection: { mode: "single", bbox: { x: 0, y: 0, width: 8, height: 8 }, targets: [] },
    segments: [{ id: "seg", narration: "因为查找。" }],
    createdAt: "2026-10-13T08:00:00.000Z",
  };
  expect(readLectureMeta({
    cacheKey: "cache-key",
    scriptVersion: "a".repeat(40),
    answers: { s1: [answer] },
    askDisabledStepIds: ["dup", ""],
  })).toEqual({
    cacheKey: "cache-key",
    scriptVersion: "a".repeat(40),
    answers: { s1: [answer] },
    askDisabledStepIds: ["dup", ""],
  });
  expect(readLectureMeta({ answers: { s1: [{ ...answer, stepId: "other" }] } }).answers).toEqual({});
});

test("网络读取失败后取消也失败，仍释放流锁并保留原错误", async () => {
  const body = new ReadableStream({ start(controller) { controller.error(new Error("network interrupted")); } });
  await expect(readLectureResponse(new Response(body, { headers }), () => {})).rejects.toThrow("network interrupted");
  expect(body.locked).toBe(false);
});
