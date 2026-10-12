import assert from "node:assert/strict";
import { test } from "node:test";
import { NextRequest } from "next/server";
import { createFixture, request } from "./api-fixture";

const script = (narration: string) => ({
  problemSlug: "3sum", mode: "lecture", language: "zh", solutionLanguage: "typescript",
  steps: [{ id: "s1", narration, targets: [{ kind: "code-line", start: 4 }], effects: [] }],
});

// 路由的 prisma 是模块单例，同一文件只能用一个 fixture，三个场景顺序执行。
test("regenerate：成功覆盖缓存；上游失败、教案不合法或取消时保留旧缓存", async () => {
  const f = await createFixture();
  try {
    const { POST } = await import("../app/api/lecture/route");
    await f.save({ apiKey: "saved-test-key", model: "test-model", provider: "openai-compatible", baseURL: f.baseURL });
    const cacheRows = () => f.prisma.lectureScriptCache.findMany();
    f.setReply(() => script("旧教案：先排序"));
    assert.equal((await POST(request({ slug: "3sum" }))).status, 200);
    const old = (await cacheRows())[0].script;

    // 1. 普通请求走缓存；regenerate 跳过缓存、请求上游并覆盖
    const before = f.calls.length;
    assert.equal((await (await POST(request({ slug: "3sum" }))).json()).cached, true);
    assert.equal(f.calls.length, before);
    f.setReply(() => script("新教案：双指针收缩"));
    const regen = await POST(request({ slug: "3sum", regenerate: true }));
    assert.equal(regen.status, 200);
    const data = await regen.json();
    assert.equal(data.cached, false);
    assert.equal(data.script.steps[0].narration, "新教案：双指针收缩");
    assert.ok(f.calls.length > before);
    let rows = await cacheRows();
    assert.equal(rows.length, 1);
    assert.notEqual(rows[0].script, old);
    assert.match(rows[0].script, /新教案：双指针收缩/);
    const fresh = rows[0].script;

    // 2. 教案不合法（422）或上游 500：旧缓存原样保留
    f.setReply(() => ({ ...script("坏"), steps: [{ id: "bad", narration: "坏", targets: [{ type: "code-line", line: 3 }] }] }));
    assert.equal((await POST(request({ slug: "3sum", regenerate: true }))).status, 422);
    f.setError(500, { error: { message: "boom" } });
    assert.notEqual((await POST(request({ slug: "3sum", regenerate: true }))).status, 200);
    rows = await cacheRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].script, fresh);

    // 3. 生成中取消：旧缓存原样保留
    f.setReply(() => script("不应写入的新教案"));
    f.setDelay(300);
    const abort = new AbortController();
    const pending = POST(new NextRequest("http://localhost/api/lecture", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug: "3sum", regenerate: true }), signal: abort.signal,
    }));
    setTimeout(() => abort.abort(), 50);
    assert.notEqual((await pending).status, 200);
    await new Promise(resolve => setTimeout(resolve, 500));
    rows = await cacheRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].script, fresh);
  } finally { await f.close(); }
});
