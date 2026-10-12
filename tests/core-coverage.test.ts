import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { coreCoverageFiles, coreCoverageFailures, coverageMetrics } from "../scripts/check-core-coverage";

const entry = (pct: unknown) => Object.fromEntries(coverageMetrics.map(metric => [metric, { pct }]));
const root = resolve(".");
const files = ["lib/agent/lecture-generation.ts", "lib/player/store.ts"];

test("总覆盖率再高也不能代替漏掉的核心文件", () => {
  const result = coreCoverageFailures({ total: entry(100), [resolve(root, files[0])]: entry(100) }, files, root);
  expect(result).toEqual(["lib/player/store.ts: 覆盖率报告缺少该核心文件"]);
});

test.each(coverageMetrics)("逐文件检查 %s，不允许其他指标补足或无效百分数蒙混过关", metric => {
  for (const pct of [59.99, "Unknown", undefined, Number.NaN]) {
    const summary = Object.fromEntries(files.map(file => [resolve(root, file), entry(100)]));
    summary[resolve(root, files[1])][metric] = { pct };
    expect(coreCoverageFailures(summary, files, root)).toEqual([`lib/player/store.ts: ${metric} 必须达到 60%`]);
  }
});

test("边界值 60% 可通过，相对和绝对报告路径均可读取", () => {
  for (const absolute of [false, true]) {
    const summary = Object.fromEntries(files.map(file => [absolute ? resolve(root, file) : file, entry(60)]));
    expect(coreCoverageFailures(summary, files, root)).toEqual([]);
  }
  expect(coreCoverageFailures(null, files, root)).toHaveLength(2);
});

test("新增讲解或播放器模块自动纳入，未导入的新文件也不能漏检", () => {
  const directory = mkdtempSync(join(tmpdir(), "algostage-coverage-"));
  try {
    for (const folder of ["lib/agent", "lib/player"]) mkdirSync(join(directory, folder), { recursive: true });
    writeFileSync(join(directory, "lib/agent/lecture-new.ts"), "export const added = true;");
    writeFileSync(join(directory, "lib/player/new-state.ts"), "export const added = true;");
    const discovered = coreCoverageFiles(directory);
    expect(discovered).toEqual(expect.arrayContaining(["lib/agent/lecture-new.ts", "lib/player/new-state.ts"]));
    const failures = coreCoverageFailures({}, discovered, directory);
    expect(failures).toHaveLength(discovered.length);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
