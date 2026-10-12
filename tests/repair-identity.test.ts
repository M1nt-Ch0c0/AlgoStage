import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { createFixture, request } from "./api-fixture";

let f: Awaited<ReturnType<typeof createFixture>>;
let POST: typeof import("../app/api/lecture/route").POST;
beforeAll(async () => {
  f = await createFixture();
  ({ POST } = await import("../app/api/lecture/route"));
  await f.save({ provider: "openai-compatible", model: "repair-model", apiKey: "fake-repair-key", baseURL: f.baseURL });
});
beforeEach(async () => { await f.prisma.lectureScriptCache.deleteMany(); });
afterAll(async () => { await f?.close(); });
const add = (id: string, retryOf?: string) => ({ name: "add_step", input: { id, narration: "讲这一段代码", target: { kind: "code-line", start: 1 }, ...(retryOf ? { retryOf } : {}) } });
const finish = { name: "finish", input: {} };
function failures(body: Record<string, unknown>) {
  return (body.messages as { role: string; tool_call_id?: string; content: string }[])
    .filter(m => m.role === "tool")
    .map(m => ({ ...JSON.parse(m.content), call: m.tool_call_id }))
    .filter(result => !result.ok);
}

test.each([true, false])("重复 s1 修正成 s2 后消费原始失败调用，兼容显式和隐式对应：%s", async explicit => {
  let round = 0;
  let identityMatches = false;
  f.setToolsReply(body => {
    if (++round === 1) return [add("s1"), add("s1"), finish];
    const errors = failures(body);
    identityMatches = errors[0].retryOf === errors[0].call;
    return [add("s2", explicit ? errors[0].retryOf : undefined), finish];
  });
  const response = await POST(request({ slug: "3sum" }));
  expect(response.status).toBe(200);
  expect((await response.json()).script.steps.map((s: { id: string }) => s.id)).toEqual(["s1", "s2"]);
  expect(round).toBe(2);
  expect(identityMatches).toBe(true);
  expect(await f.prisma.lectureScriptCache.count()).toBe(1);
});

test("同批同工具同一步两次失败，一次成功只能清掉一个原始调用", async () => {
  let round = 0;
  let ids: string[] = [];
  let pendingChoice: unknown, finishFailure: string;
  const highlight = (start: number, retryOf?: string) => ({ name: "highlight_lines", input: { stepId: "s1", start, ...(retryOf ? { retryOf } : {}) } });
  f.setToolsReply(body => {
    round++;
    if (round === 1) return [add("s1"), highlight(999), highlight(998)];
    if (round === 2) {
      ids = failures(body).map(error => error.retryOf);
      return [highlight(4, ids[0]), finish];
    }
    // 第二项仍待修复，finish 没有误把它当作成功。
    pendingChoice = body.tool_choice;
    finishFailure = failures(body).at(-1).error;
    return [highlight(6, ids[1]), finish];
  });
  const response = await POST(request({ slug: "3sum" }));
  expect(response.status).toBe(200);
  expect(round).toBe(3);
  expect(new Set(ids).size).toBe(2);
  expect(pendingChoice).toMatchObject({ function: { name: "highlight_lines" } });
  expect(finishFailure!).toBe("unrepaired_call");
  expect((await response.json()).script.steps[0].targets).toContainEqual({ kind: "code-line", start: 6, end: 6 });
});

test("retryOf 对不上时不回退到 pending[0]：报 unknown_retry_call，原失败调用仍待修复", async () => {
  let round = 0;
  let original = "";
  let mismatch: { error?: string; retryOf?: unknown } | undefined;
  let choice: unknown;
  const highlight = (start: number, retryOf?: string) => ({ name: "highlight_lines", input: { stepId: "s1", start, ...(retryOf ? { retryOf } : {}) } });
  f.setToolsReply(body => {
    round++;
    if (round === 1) return [add("s1"), highlight(999)];
    if (round === 2) {
      original = failures(body)[0].retryOf;
      return [highlight(4, "no-such-call")];
    }
    mismatch = failures(body).at(-1);
    choice = body.tool_choice;
    return [highlight(4, original), finish];
  });
  const response = await POST(request({ slug: "3sum" }));
  expect(response.status).toBe(200);
  expect(round).toBe(3);
  expect(mismatch?.error).toBe("unknown_retry_call");
  // 指回原始失败调用，而不是把错的 retryOf 当成它的修复
  expect(mismatch?.retryOf).toBe(original);
  expect(choice).toMatchObject({ function: { name: "highlight_lines" } });
  expect((await response.json()).script.steps[0].targets).toContainEqual({ kind: "code-line", start: 4, end: 4 });
});

test("不存在的 retryOf 不能消费其他失败记录，失败不缓存", async () => {
  const before = f.requests.length;
  f.setToolsReply(() => [add("s1", "unknown-call")]);
  const response = await POST(request({ slug: "3sum" }));
  expect(response.status).toBe(422);
  expect(f.requests.length - before).toBe(3);
  expect(await f.prisma.lectureScriptCache.count()).toBe(0);
});
