import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const commit = execSync("git rev-parse HEAD", { cwd: root, encoding: "utf-8" }).trim();
mkdirSync(join(root, ".next"), { recursive: true });
writeFileSync(join(root, ".next", "BUILD_COMMIT"), `${commit}\n`, "utf-8");
console.log(`[write-build-commit] Wrote .next/BUILD_COMMIT: ${commit}`);
