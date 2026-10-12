import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { HOT100 } from "../lib/content/hot100";
import { localSeedSource } from "../lib/content/local-source";
import { TWO_SUM_SOLUTIONS } from "../lib/content/solutions/two-sum";
import content from "../lib/content/generated/hot100-content.json";

test("S3：100 题均有双语参考代码，保留 two-sum 精品内容", async () => {
  assert.equal(HOT100.length, 100);
  assert.deepEqual(Object.keys(content).sort(), HOT100.map(p => p.slug).sort());
  for (const { slug } of HOT100) {
    const detail = await localSeedSource.detail(slug);
    for (const language of ["typescript", "python"]) {
      assert.ok(detail.referenceSolutions?.find(s => s.language === language)?.code.trim(), `${slug}/${language}`);
    }
  }
  assert.deepEqual((await localSeedSource.detail("two-sum")).referenceSolutions, TWO_SUM_SOLUTIONS);
});

test("S3：全部 TypeScript 题解独立通过严格类型检查，可调用题面示例正确", () => {
  const directory = mkdtempSync(join(tmpdir(), "algostage-reference-"));
  const declarations = `export {};
    declare class ListNode { val: number; next: ListNode | null; constructor(val?: number, next?: ListNode | null); }
    declare class TreeNode { val: number; left: TreeNode | null; right: TreeNode | null; constructor(val?: number, left?: TreeNode | null, right?: TreeNode | null); }
    declare class Node { val: number; next: Node | null; random: Node | null; constructor(val: number); }
  `;
  try {
    const files = Object.entries(content).map(([slug, item]) => {
      const file = join(directory, `${slug}.ts`);
      writeFileSync(file, declarations + item.solutions.find(s => s.language === "typescript")!.code);
      return file;
    });
    const program = ts.createProgram(files, { strict: true, noEmit: true, skipLibCheck: true, target: ts.ScriptTarget.ES2022, types: [], lib: ["lib.es2022.d.ts"] });
    const diagnostics = ts.getPreEmitDiagnostics(program);
    assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: f => f, getCurrentDirectory: () => directory, getNewLine: () => "\n",
    }));
    let samples = 0;
    for (const [slug, item] of Object.entries(content)) {
      const code = item.solutions.find(s => s.language === "typescript")!.code;
      if (/\b(?:ListNode|TreeNode|Node)\b/.test(code)) continue;
      const name = /function (\w+)\(/.exec(code)?.[1];
      const sample = item.statement.split("**示例**：")[1]?.split(" → ");
      if (!name || sample?.length !== 2) continue;
      let args: unknown[], expected: unknown;
      try { args = JSON.parse(`[${sample[0]}]`); expected = JSON.parse(sample[1]); } catch { continue; }
      const javascript = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
      let actual = runInNewContext(`${javascript}; ${name}(...args)`, { args }, { timeout: 1000 });
      if (actual === undefined) actual = args[0];
      // 不同 VM 上下文的数组原型不同，比较标准 JSON 值。
      actual = JSON.parse(JSON.stringify(actual));
      if (["group-anagrams", "subsets", "permutations", "combination-sum", "palindrome-partitioning"].includes(slug)) {
        const normalize = (parts: unknown) => (parts as unknown[][]).map(p => p.slice().sort()).sort();
        actual = normalize(actual); expected = normalize(expected);
      }
      assert.deepEqual(actual, expected, slug);
      samples++;
    }
    assert.ok(samples >= 60);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
