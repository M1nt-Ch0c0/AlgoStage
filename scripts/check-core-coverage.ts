/** 防止 glob 漏选核心文件，或报告只统计已导入文件而绕过逐文件门槛。 */
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CORE_COVERAGE_MINIMUM = 60;
export const coverageMetrics = ["statements", "branches", "functions", "lines"] as const;

export function coreCoverageFiles(root: string): string[] {
  return [
    ...readdirSync(resolve(root, "lib/agent"))
      .filter(name => /^lecture-.*\.ts$/.test(name))
      .map(name => `lib/agent/${name}`),
    ...readdirSync(resolve(root, "lib/player"))
      .filter(name => name.endsWith(".ts"))
      .map(name => `lib/player/${name}`),
    "lib/agent/provider.ts", "lib/agent/request.ts", "lib/agent/saved-endpoint.ts",
    "lib/agent/upstream-retry.ts", "lib/agent/modes/lecture.ts",
    "lib/teaching/schema.ts", "lib/teaching/validated-script.ts",
  ].sort();
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}

export function coreCoverageFailures(summary: unknown, files: string[], root: string): string[] {
  const entries = new Map(Object.entries(record(summary)).map(([file, value]) => [resolve(root, file), value]));
  const failures: string[] = [];
  for (const file of files) {
    const entry = entries.get(resolve(root, file));
    if (!entry) {
      failures.push(`${file}: 覆盖率报告缺少该核心文件`);
      continue;
    }
    for (const metric of coverageMetrics) {
      const pct = record(record(entry)[metric]).pct;
      if (typeof pct !== "number" || !Number.isFinite(pct) || pct < CORE_COVERAGE_MINIMUM)
        failures.push(`${file}: ${metric} 必须达到 ${CORE_COVERAGE_MINIMUM}%`);
    }
  }
  return failures;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const root = process.cwd();
    const files = coreCoverageFiles(root);
    const failures = coreCoverageFailures(JSON.parse(readFileSync(resolve(root, "coverage/coverage-summary.json"), "utf8")), files, root);
    if (failures.length) {
      console.error(failures.join("\n"));
      process.exitCode = 1;
    } else console.log(`核心覆盖率门槛通过：${files.length} 个文件，四项指标逐文件均 ≥ ${CORE_COVERAGE_MINIMUM}%。`);
  } catch {
    console.error("覆盖率报告不可读，请先运行带覆盖率的完整测试。");
    process.exitCode = 1;
  }
}
