import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createFixture, request } from "./api-fixture";
import { arrayVizFrameSchema, teachingScriptSchema } from "../lib/teaching/schema";
import { TWO_SUM_SCRIPT } from "../lib/content/scripts/two-sum";
import ArrayVisualizer from "../components/viz/array-visualizer";

const validViz = { type: "array", state: { values: [2, 7], highlight: [1], map: { "2": 0 }, scan: 1, hit: true } };
function scriptWithViz(viz: unknown) {
  return {
    problemSlug: "3sum", mode: "lecture", language: "zh", solutionLanguage: "typescript",
    steps: [{ id: "one", narration: "检查当前数组。", targets: [{ kind: "code-line", start: 1 }], effects: [], viz }],
  };
}

test("S2 review：按可视化类型校验状态、索引及字幕，未知类型不能通过", () => {
  assert.ok(teachingScriptSchema.safeParse(TWO_SUM_SCRIPT).success);
  for (const state of [
    { values: [2, 7] }, validViz.state, { values: [], highlight: [], map: {}, scan: -1 },
  ]) assert.ok(arrayVizFrameSchema.safeParse({ type: "array", state }).success);
  for (const state of [
    { values: "bad" }, {}, null, { values: [1, "2"] }, { values: [Infinity] },
    { values: [NaN] }, { values: [1], highlight: "bad" }, { values: [1], map: { key: {} } },
    { values: [1], scan: "0" }, { values: [1], hit: "yes" },
    { values: [1], highlight: [-1] }, { values: [1], highlight: [1] },
    { values: [1], map: { key: 1 } }, { values: [1], scan: 1 },
  ]) assert.equal(teachingScriptSchema.safeParse(scriptWithViz({ type: "array", state })).success, false);
  assert.equal(teachingScriptSchema.safeParse(scriptWithViz({ ...validViz, type: "tree" })).success, false);
  assert.equal(teachingScriptSchema.safeParse(scriptWithViz({ ...validViz, captions: [{ nodeId: "a0", text: {} }] })).success, false);
});

test("S2 review：数组组件面对非法帧安全隐藏，合法帧正常渲染", () => {
  for (const frame of [{ type: "array", state: { values: "bad" } }, { type: "tree", state: {} }]) {
    assert.equal(renderToStaticMarkup(createElement(ArrayVisualizer, { frame })), "");
  }
  const html = renderToStaticMarkup(createElement(ArrayVisualizer, { frame: validViz }));
  assert.ok(html.includes('data-viz-node="a0"'));
  assert.ok(html.includes('aria-label="数组可视化"'));
});

test("S2 review：非法可视化重试后返回 422 不缓存；非法旧缓存被清除", async () => {
  const f = await createFixture();
  try {
    const { POST } = await import("../app/api/lecture/route");
    await f.save({ apiKey: "viz-test-key", model: "viz-test-model", provider: "openai-compatible", baseURL: f.baseURL });
    for (const viz of [
      { type: "array", state: { values: "bad" } },
      { type: "array", state: { values: [1], highlight: "bad" } },
      { type: "unknown", state: { values: [1] } },
    ]) {
      const before = f.calls.length;
      f.setReply(() => scriptWithViz(viz));
      const response = await POST(request({ slug: "3sum" }));
      assert.equal(response.status, 422);
      assert.equal((await response.json()).error, "INVALID_SCRIPT");
      assert.equal(f.calls.length - before, 3);
      assert.equal(await f.prisma.lectureScriptCache.count(), 0);
    }
    f.setReply(() => scriptWithViz(validViz));
    const success = await POST(request({ slug: "3sum" }));
    assert.equal(success.status, 200);
    assert.ok(teachingScriptSchema.safeParse((await success.json()).script).success);
    const row = (await f.prisma.lectureScriptCache.findMany())[0];
    const invalid = scriptWithViz({ type: "array", state: { values: "bad" } });
    await f.prisma.lectureScriptCache.update({ where: { key: row.key }, data: { script: JSON.stringify(invalid) } });
    f.setReply(() => invalid);
    const rejected = await POST(request({ slug: "3sum" }));
    assert.equal(rejected.status, 422);
    assert.equal(await f.prisma.lectureScriptCache.count(), 0);
  } finally { await f.close(); }
});
