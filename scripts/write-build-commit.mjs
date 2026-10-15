import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
let commit;
try {
  commit = execSync("git rev-parse HEAD", { cwd: root, encoding: "utf-8", stdio: "pipe" }).trim();
} catch (err) {
  commit = process.env.GIT_COMMIT || "unknown";
  console.warn(
    `[write-build-commit] Warning: failed to determine git commit (${err?.message || err}), falling back to "${commit}"`,
  );
}
mkdirSync(join(root, ".next"), { recursive: true });
writeFileSync(join(root, ".next", "BUILD_COMMIT"), `${commit}\n`, "utf-8");
console.log(`[write-build-commit] Wrote .next/BUILD_COMMIT: ${commit}`);
