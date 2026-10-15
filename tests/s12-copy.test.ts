import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "..");
const read = (f: string) => readFileSync(path.join(root, f), "utf8");
const version = JSON.parse(read("package.json")).version;

describe("S12 首页文案", () => {
  it("首页保留本地文案且不含体验版文案", () => {
    const page = read("app/page.tsx");
    expect(page).not.toContain("记住进度");
    expect(page).not.toContain("体验版");
    expect(page).toContain("你的电脑，就是教室");
  });
});

describe("D2 Demo UI 拆解", () => {
  it("移除 DemoBanner 组件与根布局挂载", () => {
    expect(existsSync(path.join(root, "components/demo-banner.tsx"))).toBe(false);
    const layout = read("app/layout.tsx");
    expect(layout).not.toContain("DemoBanner");
    expect(layout).not.toContain("demo-banner");
  });

  it("移除 NarrationBar 废弃的 problemSlug prop", () => {
    const narrationBar = read("components/board/narration-bar.tsx");
    expect(narrationBar).not.toContain("problemSlug");
    const problemPage = read("app/problem/[slug]/page.tsx");
    expect(problemPage).not.toMatch(/<NarrationBar[^>]*problemSlug=/);
  });

  it("清理学习页与看板页的体验版文案及死分支", () => {
    const problemPage = read("app/problem/[slug]/page.tsx");
    expect(problemPage).not.toContain("lectureLocked");
    expect(problemPage).not.toContain("体验版");
    expect(problemPage).not.toContain('j.error === "DEMO"');

    const dashboardPage = read("app/dashboard/page.tsx");
    expect(dashboardPage).not.toContain("体验版");
    expect(dashboardPage).toContain("暂时打不开学习看板");
  });

  it("e2e 冒烟测试不再包含 DEMO 与在线体验版断言", () => {
    const smoke = read("e2e/smoke.spec.ts");
    expect(smoke).not.toContain("DEMO");
    expect(smoke).not.toContain("在线体验版");
    expect(smoke).not.toContain("这是在线体验版");
  });
});

describe("S12 版本号", () => {
  it("package.json 与 lockfile 根版本一致", () => {
    expect(version).toBe("0.3.1");
    const lock = JSON.parse(read("package-lock.json"));
    expect(lock.version).toBe(version);
    expect(lock.packages[""].version).toBe(version);
  });
  it("deploy 镜像 tag 对齐当前版本且不残留旧标识", () => {
    const compose = read("deploy/compose.yaml");
    expect(compose).toContain(":-" + version + "}");
    const deployReadme = read("deploy/README.md");
    expect(deployReadme).toContain("algostage:" + version);
    for (const content of [compose, deployReadme]) {
      expect(content).not.toContain("algostage-demo:");
      expect(content).not.toMatch(/algostage:0\.2\.0(?!-alpha)/);
      expect(content).not.toContain("20261008");
    }
  });
});
