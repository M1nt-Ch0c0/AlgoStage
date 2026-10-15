import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { checkBuildCommit } from "../lib/build-commit";

export default function globalSetup() {
  const buildCommitPath = join(process.cwd(), ".next", "BUILD_COMMIT");
  const built = existsSync(buildCommitPath)
    ? readFileSync(buildCommitPath, "utf-8")
    : null;

  let head: string | null;
  try {
    head = execSync("git rev-parse HEAD", { encoding: "utf-8" });
  } catch {
    head = null;
  }

  const result = checkBuildCommit(built, head);
  if (!result.ok) {
    throw new Error(result.message);
  }
}
