import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "..");
const read = (f: string) => readFileSync(path.join(root, f), "utf8");
const version = JSON.parse(read("package.json")).version;

describe("deploy buildx 与启动配置", () => {
  it("deploy/entrypoint.sh 不含 --skip-generate", () => {
    const entrypoint = read("deploy/entrypoint.sh");
    expect(entrypoint).not.toContain("--skip-generate");
  });

  it("deploy/compose.yaml 使用带默认版本的 ALGOSTAGE_IMAGE_TAG", () => {
    const compose = read("deploy/compose.yaml");
    expect(compose).toContain("image: algostage:${ALGOSTAGE_IMAGE_TAG:-" + version + "}");
  });

  it("deploy/README.md 使用 buildx 构建与 --no-build 启动", () => {
    const deployReadme = read("deploy/README.md");
    expect(deployReadme).toContain("--allow network.host");
    expect(deployReadme).toContain("--load");
    expect(deployReadme).toContain("--no-build");
    expect(deployReadme).toContain("ALGOSTAGE_IMAGE_TAG");
    expect(deployReadme).not.toContain("compose -f deploy/compose.yaml build");
  });

  it("README.md 包含 docker buildx build 与 --no-build", () => {
    const readme = read("README.md");
    expect(readme).toContain("docker buildx build");
    expect(readme).toContain("--no-build");
  });
});
