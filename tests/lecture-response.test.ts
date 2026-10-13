import { expect, test, vi } from "vitest";
import { isLectureCutOff, readLectureResponse } from "../lib/player/lecture-response";

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

test("网络读取失败后取消也失败，仍释放流锁并保留原错误", async () => {
  const body = new ReadableStream({ start(controller) { controller.error(new Error("network interrupted")); } });
  await expect(readLectureResponse(new Response(body, { headers }), () => {})).rejects.toThrow("network interrupted");
  expect(body.locked).toBe(false);
});
test("isLectureCutOff：UPSTREAM_ERROR 只在已收到步骤时算中断", () => {
  expect(isLectureCutOff({ code: "TIMEOUT" })).toBe(true);
  expect(isLectureCutOff({ code: "INTERRUPTED" })).toBe(true);
  expect(isLectureCutOff({ code: "UPSTREAM_ERROR" }, 0)).toBe(false);
  expect(isLectureCutOff({ code: "UPSTREAM_ERROR" }, 2)).toBe(true);
  expect(isLectureCutOff({ code: "UPSTREAM_AUTH" }, 2)).toBe(false);
  expect(isLectureCutOff({ code: "INVALID_SCRIPT" }, 2)).toBe(false);
});
