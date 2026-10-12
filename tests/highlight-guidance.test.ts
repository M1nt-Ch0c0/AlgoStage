import { expect, test, vi } from "vitest";
import { createLectureTools } from "../lib/agent/lecture-tools";
import { highlightProblem } from "../lib/agent/lecture-highlights";
import { buildLecturePrompt } from "../lib/agent/modes/lecture";
import { localSeedSource } from "../lib/content/local-source";
import { createFixture, request } from "./api-fixture";
import { validateScript } from "../lib/teaching/validated-script";

const code = "function threeSum(nums) {\n  const res = [];\n  // 排序\n  nums.sort((a, b) => a - b);\n\n  return res;\n}";
const target = (start: number, end?: number) => ({ kind: "code-line" as const, start, end });

test("本地校验拒绝排序步的空白行、签名、注释及错误语句，不产生成功回显", () => {
  const kit = createLectureTools(code);
  for (const start of [0, 1, 2, 3, 5, 99]) {
    expect(() => kit.apply("add_step", { id: "s1", narration: "先排序", target: target(start) })).toThrow();
    expect(kit.steps).toHaveLength(0);
  }
  expect(() => kit.apply("add_step", { id: "s1", narration: "先排序", target: { kind: "statement", blockId: "insight" } })).toThrow("code-line");
  const added = kit.apply("add_step", { id: "s1", narration: "先排序", target: target(4) });
  expect(added.step?.targets).toEqual([{ kind: "code-line", start: 4 }]);
  expect(added).not.toHaveProperty("highlightedCode");
  expect(() => kit.apply("highlight_lines", { stepId: "s1", start: 1 })).toThrow("签名");
  expect(kit.steps[0].targets).toEqual([{ kind: "code-line", start: 4 }]);
});

test("空白、越界、逆序与 Python 排序就地校验；函数参数讲解允许签名", () => {
  const lines = code.split("\n");
  for (const invalid of [target(0), target(4, 3), target(99), target(1.5), target(4, 5)]) expect(highlightProblem(lines, "讲代码", invalid)).not.toBeNull();
  expect(highlightProblem(lines, "函数参数 nums 表示数组", target(1))).toBeNull();
  expect(highlightProblem(lines, "初始化结果数组", target(1))?.type).toBe("highlight_signature_mismatch");
  expect(highlightProblem(lines, "总结排序的复杂度", { kind: "statement", blockId: "summary" })).toBeNull();
  expect(highlightProblem(lines, "题意", { kind: "statement", blockId: "intro" })).toBeNull();
  expect(highlightProblem(lines, "先排序", { kind: "code-token", line: 4, match: "sort" })).toBeNull();
  const python = ["def three_sum(nums):", "    nums = sorted(nums)", "    return []"];
  expect(highlightProblem(python, "Sort the array", target(2))).toBeNull();
  expect(highlightProblem(python, "先排序", target(1))?.type).toBe("highlight_signature_mismatch");
});

test("教案提示不再要求模型自检代码回执，保留紧凑的手写两数之和示例", async () => {
  const detail = await localSeedSource.detail("3sum");
  const referenceCode = detail.referenceSolutions!.find(s => s.language === "typescript")!.code;
  const prompt = buildLecturePrompt({ slug: detail.slug, title: detail.title, solutionLanguage: "typescript", language: "zh", referenceCode: referenceCode + "\n\n" });
  expect(prompt).not.toContain("highlightedCode");
  expect(prompt).toContain("服务端本地校验");
  expect(prompt).toContain("首轮只用一次");
  expect(prompt).toContain("手写两数之和教案示例");
  expect(prompt).not.toContain(`${referenceCode.trimEnd().split("\n").length + 1}: `);
});

test("错误高亮只修正该调用，成功步骤不重复，非法教案和旧缓存都不复用", async () => {
  const f = await createFixture();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const { generateLecture } = await import("../lib/agent/lecture-generation");
    const { POST } = await import("../app/api/lecture/route");
    const config = { provider: "openai-compatible" as const, model: "test", apiKey: "fake-highlight-key", baseURL: f.baseURL };
    for (const start of [1, 3, 5, 99]) {
      let round = 0;
      const seen: string[] = [];
      f.setToolsReply(() => ++round === 1 ? [
        { name: "add_step", input: { id: "s1", narration: "找出和为零的三元组", target: { kind: "statement", blockId: "intro" } } },
        { name: "add_step", input: { id: "s2", narration: "先排序", target: target(start) } },
      ] : [
        { name: "add_step", input: { id: "s2", narration: "先排序", target: target(4) } },
        { name: "finish", input: {} },
      ]);
      const result = await generateLecture({ config, prompt: "讲解", referenceCode: code,
        metadata: { problemSlug: "3sum", mode: "lecture", solutionLanguage: "typescript", language: "zh" },
        validate: value => validateScript(value, code), onEvent: event => { if (event.type === "step") seen.push(event.step.id); },
      });
      expect(result.ok).toBe(true);
      expect(round).toBe(2);
      expect(seen).toEqual(["s1", "s2"]);
      const receipts = (f.requests.at(-1)!.messages as { role: string; content?: string }[]).filter(m => m.role === "tool").map(m => JSON.parse(m.content!));
      expect(receipts[0].ok).toBe(true);
      expect(receipts[0]).not.toHaveProperty("highlightedCode");
      expect(receipts[1].ok).toBe(false);
      expect(receipts[1].reason).toBeTruthy();
    }
    await f.save(config);
    f.setToolsReply(() => [{ name: "add_step", input: { id: "s1", narration: "先排序", target: target(1) } }]);
    expect((await POST(request({ slug: "3sum" }))).status).toBe(422);
    expect(await f.prisma.lectureScriptCache.count()).toBe(0);
    f.setToolsReply(() => [{ name: "add_step", input: { id: "s1", narration: "先排序", target: target(4) } }, { name: "finish", input: {} }]);
    expect((await POST(request({ slug: "3sum" }))).status).toBe(200);
    const row = await f.prisma.lectureScriptCache.findFirstOrThrow();
    const old = JSON.parse(row.script); old.steps[0].targets[0].start = 1;
    await f.prisma.lectureScriptCache.update({ where: { key: row.key }, data: { script: JSON.stringify(old) } });
    const response = await POST(request({ slug: "3sum" }));
    expect((await response.json()).cached).toBe(false);
    expect(JSON.parse((await f.prisma.lectureScriptCache.findFirstOrThrow()).script).steps[0].targets[0].start).toBe(4);
    expect(JSON.stringify(f.requests)).not.toContain("highlightedCode");
    expect(warn.mock.calls.flat().join(" ")).not.toContain(config.apiKey);
  } finally { warn.mockRestore(); await f.close(); }
});
