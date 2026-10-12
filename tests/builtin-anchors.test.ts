import assert from "node:assert/strict";
import { test } from "node:test";
import { readdir } from "node:fs/promises";
import { localSeedSource } from "../lib/content/local-source";
import { teachingScriptSchema } from "../lib/teaching/schema";

/** 断言讲到的具体代码，不能仅靠“行号未越界”把右花括号当成 map 写入。 */
const expected: Record<
  string,
  Record<string, { start: number; end: number; text: string }[]>
> = {
  "two-sum": {
    s3: [
      {
        start: 2,
        end: 3,
        text: "// 哈希表：键 = 数值，值 = 下标\nconst map = new Map<number, number>();",
      },
    ],
    s4: [
      {
        start: 4,
        end: 5,
        text: "for (let i = 0; i < nums.length; i++) {\nconst complement = target - nums[i];",
      },
    ],
    s5: [
      {
        start: 6,
        end: 8,
        text: "// 命中：之前见过 complement\nif (map.has(complement)) {\nreturn [map.get(complement)!, i];",
      },
    ],
    s6: [{ start: 10, end: 10, text: "map.set(nums[i], i);" }],
  },
};

test("所有内置教案：每个代码锚点均对应参考题解的预期文本", async () => {
  const directory = new URL("../lib/content/scripts/", import.meta.url);
  const files = (await readdir(directory)).filter((file) =>
    file.endsWith(".ts"),
  );
  assert.ok(files.length > 0);
  for (const file of files) {
    const module = await import(new URL(file, directory).href);
    const scripts = Object.values(module).filter(
      (value) =>
        typeof value === "object" && value !== null && "steps" in value,
    );
    assert.ok(scripts.length > 0, `${file} 应导出内置教案`);
    for (const value of scripts) {
      const script = teachingScriptSchema.parse(value);
      const detail = await localSeedSource.detail(script.problemSlug);
      const code = detail.referenceSolutions?.find(
        (s) => s.language === script.solutionLanguage,
      )?.code;
      assert.ok(code);
      const lines = code.split("\n");
      const expectedSteps = expected[script.problemSlug];
      assert.ok(expectedSteps, `${file} 需补充预期代码文本`);
      const anchored: string[] = [];
      for (const step of script.steps) {
        const targets = step.targets.filter(
          (target) => target.kind === "code-line",
        );
        if (targets.length) {
          anchored.push(step.id);
          const expectedTargets = expectedSteps[step.id];
          assert.ok(expectedTargets, `${file}/${step.id} 缺少预期代码文本`);
          assert.equal(targets.length, expectedTargets.length);
          targets.forEach((target, i) => {
            const end = target.end ?? target.start,
              anchor = expectedTargets[i];
            assert.ok(
              target.start >= 1 && end >= target.start && end <= lines.length,
            );
            assert.deepEqual(
              { start: target.start, end },
              { start: anchor.start, end: anchor.end },
            );
            assert.equal(
              lines
                .slice(target.start - 1, end)
                .map((line) => line.trim())
                .join("\n"),
              anchor.text,
              `${file}/${step.id} 指向错误代码`,
            );
          });
        }
        for (const target of step.targets)
          if (target.kind === "code-token") {
            assert.ok(target.line >= 1 && target.line <= lines.length);
            assert.ok(lines[target.line - 1].includes(target.match));
          }
      }
      assert.deepEqual(anchored.sort(), Object.keys(expectedSteps).sort());
    }
  }
});
