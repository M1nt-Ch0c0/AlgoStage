import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "..");
const read = (f: string) => readFileSync(path.join(root, f), "utf8");

describe("S12 Demo 文案", () => {
  it("首页 Demo 文案不再承诺记住进度", () => {
    const page = read("app/page.tsx");
    expect(page).not.toContain("记住进度");
    expect(page).toContain("体验版不记进度，没有看板");
  });
});

describe("S12 版本号", () => {
  it("package.json 与 lockfile 根版本为 0.2.0-alpha.1", () => {
    expect(JSON.parse(read("package.json")).version).toBe("0.2.0-alpha.1");
    const lock = JSON.parse(read("package-lock.json"));
    expect(lock.version).toBe("0.2.0-alpha.1");
    expect(lock.packages[""].version).toBe("0.2.0-alpha.1");
  });
  it("deploy 镜像 tag 为 algostage-demo:0.2.0-alpha.1 且不残留裸 0.2.0 或 20261008", () => {
    for (const f of ["deploy/compose.yaml", "deploy/README.md"]) {
      const content = read(f);
      expect(content).toContain("algostage-demo:0.2.0-alpha.1");
      expect(content).not.toMatch(/algostage-demo:0\.2\.0(?!-alpha)/);
      expect(content).not.toContain("20261008");
    }
  });
});
