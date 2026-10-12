/**
 * Hot100 内容离线整理与校验，不调用模型或任何外部 API。
 * 自写的经典解法保存在 generated JSON；按元数据顺序整理，保证两种语言齐全。
 * 用法：npx tsx scripts/gen-content.ts [--check]
 */
import { readFileSync, writeFileSync } from "node:fs";
import ts from "typescript";
import { HOT100 } from "../lib/content/hot100";
import { validateContent, type GeneratedContent } from "../lib/content/generated-check";

const out = "lib/content/generated/hot100-content.json";
const db = JSON.parse(readFileSync(out, "utf8")) as Record<string, GeneratedContent>;
for (const problem of HOT100) {
  const content = db[problem.slug];
  const error = validateContent(content);
  if (error) throw new Error(`${problem.slug}: ${error}`);
  const code = content.solutions.find((s) => s.language === "typescript")!.code;
  const result = ts.transpileModule(code, {
    reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  });
  const diagnostics = result.diagnostics?.filter((d) => d.category === ts.DiagnosticCategory.Error) ?? [];
  if (diagnostics.length) throw new Error(`${problem.slug}: ${ts.flattenDiagnosticMessageText(diagnostics[0].messageText, "\n")}`);
}
const sorted = Object.fromEntries(HOT100.map((p) => [p.slug, db[p.slug]]));
if (!process.argv.includes("--check")) writeFileSync(out, JSON.stringify(sorted, null, 2) + "\n");
console.log(`Hot100 内容校验通过：${HOT100.length}/100，TypeScript + Python，全部三段题面。`);
