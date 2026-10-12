import { expect, test } from "vitest";
import { createLectureTools } from "../lib/agent/lecture-tools";
import { buildLecturePrompt } from "../lib/agent/modes/lecture";
import { localSeedSource } from "../lib/content/local-source";
import { createFixture } from "./api-fixture";
import { validateScript } from "../lib/teaching/validated-script";

test("3sum 讲排序的工具回执准确回显 sort 行，修改高亮后回显随之更新", async () => {
  const detail = await localSeedSource.detail("3sum");
  const referenceCode = detail.referenceSolutions!.find(s => s.language === "typescript")!.code;
  const lines = referenceCode.trimEnd().split("\n"), sortLine = lines.findIndex(line => line.includes(".sort(")) + 1;
  expect(sortLine).toBeGreaterThan(1);
  const kit = createLectureTools(referenceCode);
  expect(kit.tools.add_step.description).toMatch(/先排序.*sort.*函数签名/);
  expect(kit.tools.highlight_lines.description).toMatch(/字幕.*最小必要范围/);
  const added = kit.apply("add_step", { id: "s1", narration: "先排序", target: { kind: "code-line", start: sortLine } });
  expect(added.highlightedCode).toEqual([`${sortLine}: ${lines[sortLine - 1]}`]);
  const changed = kit.apply("highlight_lines", { stepId: "s1", start: 1, end: 2 });
  expect(changed.highlightedCode).toEqual([`1: ${lines[0]}`, `2: ${lines[1]}`]);
  const prompt = buildLecturePrompt({ slug: detail.slug, title: detail.title, solutionLanguage: "typescript", language: "zh", referenceCode: referenceCode + "\n\n" });
  expect(prompt).toContain("highlightedCode");
  expect(prompt).toContain("不是函数签名");
  expect(prompt).not.toContain(`${lines.length + 1}: `);
});

test("高亮代码回执确实进入下一轮模型上下文，供模型自检", async () => {
  const f = await createFixture();
  try {
    const { generateLecture } = await import("../lib/agent/lecture-generation");
    let round = 0;
    f.setToolsReply(() => ++round === 1
      ? [{ name: "add_step", input: { id: "s1", narration: "先排序", target: { kind: "code-line", start: 2 } } }]
      : [{ name: "finish", input: {} }]);
    const code = "function threeSum(nums) {\n  nums.sort((a, b) => a - b);\n}";
    expect(await generateLecture({
      config: { provider: "openai-compatible", model: "test", apiKey: "fake-highlight-key", baseURL: f.baseURL },
      prompt: "讲解", referenceCode: code,
      metadata: { problemSlug: "3sum", mode: "lecture", solutionLanguage: "typescript", language: "zh" },
      validate: value => validateScript(value, code),
    })).toMatchObject({ ok: true });
    const messages = f.requests[1].messages as { role: string; content?: string }[];
    const receipt = messages.find(message => message.role === "tool")!;
    expect(JSON.parse(receipt.content!).highlightedCode).toEqual(["2:   nums.sort((a, b) => a - b);"]);
  } finally { await f.close(); }
});
