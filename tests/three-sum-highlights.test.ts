import { expect, test } from "vitest";
import { NextRequest } from "next/server";
import { createFixture } from "./api-fixture";
import { localSeedSource } from "../lib/content/local-source";
import { readLectureResponse } from "../lib/player/lecture-response";
import { teachingScriptSchema } from "../lib/teaching/schema";
import { usePlayerStore } from "../lib/player/store";

test("3sum 生成、流式传输、缓存与回看均保留每个代码步骤的正确高亮", async () => {
  const f = await createFixture();
  try {
    const { POST } = await import("../app/api/lecture/route");
    const code = (await localSeedSource.detail("3sum")).referenceSolutions!.find(s => s.language === "typescript")!.code;
    const lines = code.split("\n");
    const meanings = [
      ["先排序，后面才能根据和的大小移动指针", "nums.sort"],
      ["遍历并固定第一个数", "for (let i = 0;"],
      ["重复的第一个数直接跳过", "if (i > 0 &&"],
      ["找到答案时将三元组写入结果", "res.push("],
    ];
    const steps = [
      { id: "s1", narration: "找出三个数的和为零，三重遍历太慢", target: { kind: "statement", blockId: "intro" } },
      ...meanings.map(([narration, code]) => ({ id: "", narration, target: { kind: "code-line", start: lines.findIndex(line => line.includes(code)) + 1 } })),
      { id: "s6", narration: "总结：排序后双指针，时间平方级", target: { kind: "statement", blockId: "summary" } },
    ].map((step, i) => ({ ...step, id: `s${i + 1}` }));
    await f.save({ provider: "openai-compatible", model: "highlight-test", apiKey: "fake-3sum-key", baseURL: f.baseURL });
    f.setToolsReply(() => [...steps.map(input => ({ name: "add_step", input })), { name: "finish", input: {} }]);
    const store = usePlayerStore.getState();
    store.beginStream({ problemSlug: "3sum", mode: "lecture", language: "zh", solutionLanguage: "typescript" });
    const response = await POST(new NextRequest("http://localhost/api/lecture", {
      method: "POST", headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" }, body: JSON.stringify({ slug: "3sum" }),
    }));
    const script = teachingScriptSchema.parse(await readLectureResponse(response, () => {}, step => { store.appendStep(step); store.next(); }));
    for (const [index, [, code]] of meanings.entries()) {
      const anchors = script.steps[index + 1].targets.filter(target => target.kind === "code-line");
      expect(anchors).toHaveLength(1);
      expect(lines[anchors[0].start - 1]).toContain(code);
    }
    expect(script.steps[1].targets).toContainEqual({ kind: "code-line", start: 4 });
    expect(f.requests).toHaveLength(1); // 正确的一批工具调用不再追加模型自检往返。
    expect(JSON.parse((await f.prisma.lectureScriptCache.findFirstOrThrow()).script).steps).toEqual(script.steps);
    store.completeStream(script); store.goto(1);
    expect(usePlayerStore.getState().status).toBe("paused");
    expect(usePlayerStore.getState().steps[1].targets).toEqual(script.steps[1].targets);
    store.play(); expect(usePlayerStore.getState().status).toBe("playing");
  } finally { usePlayerStore.getState().reset(); await f.close(); }
});
