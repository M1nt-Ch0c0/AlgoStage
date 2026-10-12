import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "..");
const read = (f: string) => readFileSync(path.join(root, f), "utf8");

describe("D3 Demo 部署与构建开关拆除", () => {
  it("Dockerfile 无 DEMO / ALGOSTAGE_DEMO / ARG DEMO 及体验版注释", () => {
    const dockerfile = read("Dockerfile");
    expect(dockerfile).not.toContain("DEMO");
    expect(dockerfile).not.toContain("ALGOSTAGE_DEMO");
    expect(dockerfile).not.toContain("ARG DEMO");
    expect(dockerfile).not.toContain("体验版");
    expect(dockerfile).toContain("docker build --build-arg BASE_PATH=/a1 -t algostage .");
  });

  it("deploy/compose.yaml 切换为自托管 algostage:0.2.0-alpha.1 且无 DEMO 构建参数", () => {
    const compose = read("deploy/compose.yaml");
    expect(compose).toContain("name: algostage");
    expect(compose).toContain("image: algostage:0.2.0-alpha.1");
    expect(compose).toContain("container_name: algostage");
    expect(compose).toContain("name: algostage-data");
    expect(compose).not.toContain("DEMO:");
    expect(compose).not.toContain("algostage-demo");
  });

  it("deploy/README.md 与 docs/07-testing-ci.md 不含体验版与 ALGOSTAGE_DEMO", () => {
    for (const f of ["deploy/README.md", "docs/07-testing-ci.md"]) {
      const content = read(f);
      expect(content).not.toContain("体验版");
      expect(content).not.toContain("ALGOSTAGE_DEMO");
    }
    const deployReadme = read("deploy/README.md");
    expect(deployReadme).toContain("algostage:0.2.0-alpha.1");
    expect(deployReadme).toContain("algostage-data");
  });

  it(".github/workflows/ci.yml 不含 ALGOSTAGE_DEMO", () => {
    const ci = read(".github/workflows/ci.yml");
    expect(ci).not.toContain("ALGOSTAGE_DEMO");
  });

  it("e2e/smoke.spec.ts 仍无 DEMO 与在线体验版", () => {
    const smoke = read("e2e/smoke.spec.ts");
    expect(smoke).not.toContain("DEMO");
    expect(smoke).not.toContain("在线体验版");
  });
});
