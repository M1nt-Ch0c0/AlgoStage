import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "..");
const read = (f: string) => readFileSync(path.join(root, f), "utf8");

describe("S12 文档对齐", () => {
  it("README.md 包含验证命令、判题、Docker 与升级说明，且主验证命令不含 npx tsc --noEmit", () => {
    const readme = read("README.md");
    expect(readme).toContain("本地 Playground + 浏览器判题");
    expect(readme).toContain("npm run typecheck");
    expect(readme).toContain("npm run test:e2e");
    expect(readme).toContain("从旧版本升级");
    expect(readme).toContain("判题");
    expect(readme).toContain("Docker 自托管");
    expect(readme).toContain("子路径 + nginx");
    expect(readme).toContain("提示超时");

    const verifyLine = readme.split("\n").find((line) => line.startsWith("验证命令："));
    expect(verifyLine).toBeDefined();
    expect(verifyLine).toContain("npm run typecheck");
    expect(verifyLine).toContain("npm run test:e2e");
    expect(verifyLine).not.toContain("npx tsc --noEmit");
  });

  it(".env.example 补全 JUDGE_MAX_CONCURRENCY 与 NEXT_PUBLIC_BASE_PATH", () => {
    const envExample = read(".env.example");
    expect(envExample).toContain("JUDGE_MAX_CONCURRENCY");
    expect(envExample).toContain("NEXT_PUBLIC_BASE_PATH");
    expect(envExample).toContain("HINT_TIMEOUT_MS");
  });

  it("CHANGELOG.md 记录 0.2.0-alpha.1、Demo 移除与 db:push 升级须知", () => {
    const changelog = read("CHANGELOG.md");
    expect(changelog).toContain("0.2.0-alpha.1");
    expect(changelog).toMatch(/Demo|NEXT_PUBLIC_ALGOSTAGE_DEMO/);
    expect(changelog).toContain("db:push");
  });
});
