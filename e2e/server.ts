import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The production build must also use NEXT_PUBLIC_ALGOSTAGE_DEMO=1.
// Never use the developer's SQLite database or model credentials for E2E.
const directory = mkdtempSync(join(tmpdir(), "algostage-e2e-"));
const env = {
  ...process.env,
  DATABASE_URL: `file:${join(directory, "smoke.db")}`,
  NEXT_PUBLIC_ALGOSTAGE_DEMO: "1",
  NEXT_PUBLIC_BASE_PATH: "",
  NEXT_TELEMETRY_DISABLED: "1",
  AI_API_KEY: "",
  AI_MODEL: "",
  AI_PROVIDER: "",
  AI_BASE_URL: "http://127.0.0.1:1/no-model",
};

process.on("exit", () => rmSync(directory, { recursive: true, force: true }));
for (const args of [
  ["node_modules/prisma/build/index.js", "db", "push"],
  ["node_modules/tsx/dist/cli.mjs", "prisma/seed.ts"],
]) {
  const result = spawnSync(process.execPath, args, { env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const server = spawn(process.execPath, [
  "node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", process.env.E2E_PORT || "4173",
], { env, stdio: "inherit" });
process.on("SIGTERM", () => server.kill("SIGTERM"));
process.on("SIGINT", () => server.kill("SIGINT"));
server.on("error", (error) => { console.error(error); process.exit(1); });
server.on("exit", (code) => process.exit(code ?? 0));
