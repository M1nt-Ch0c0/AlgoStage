import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "..");
const entrypointPath = path.join(root, "deploy/entrypoint.sh");
const fixCommand = "docker run --rm -v algostage-data:/data alpine chown -R 1001:1001 /data";

it("runs the final Docker stage as UID/GID 1001 with owned runtime and data files", () => {
  const runtime = readFileSync(path.join(root, "Dockerfile"), "utf8").split(/^FROM\s.+$/m).at(-1)!;
  expect(runtime).toMatch(/groupadd --gid 1001 algostage/);
  expect(runtime).toMatch(/useradd --uid 1001 --gid algostage\b/);
  expect(runtime).toContain("mkdir -p /app/data /data");
  expect(runtime).toContain("chown -R algostage:algostage /app /data");
  expect(runtime).toContain('DATA_DIR="/data"');
  expect(runtime).toContain('DATABASE_URL="file:/data/algostage.db"');
  const user = runtime.match(/^USER\s+(?:1001(?::1001)?|algostage(?::algostage)?)\s*$/m);
  expect(user).not.toBeNull();
  expect(user!.index).toBeLessThan(runtime.search(/^(?:ENTRYPOINT|CMD)\s/m));
  expect(runtime.match(/^USER\s/gm)).toHaveLength(1);
});

it("checks data writability before Prisma and includes the one-time volume repair hint", () => {
  const entrypoint = readFileSync(entrypointPath, "utf8");
  expect(entrypoint).toContain('DATA_DIR="${DATA_DIR:-/app/data}"');
  expect(entrypoint).toMatch(/mktemp "\$DATA_DIR\//);
  expect(entrypoint.indexOf("mktemp ")).toBeLessThan(entrypoint.indexOf("node node_modules/prisma/"));
  expect(entrypoint).toContain(fixCommand);
});

describe("entrypoint data permissions", () => {
  let directory: string;
  let dataDirectory: string;
  let binDirectory: string;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "algostage-deploy-nonroot-"));
    dataDirectory = path.join(directory, "data with spaces");
    binDirectory = path.join(directory, "bin");
    mkdirSync(dataDirectory);
    mkdirSync(binDirectory);
    writeFileSync(path.join(binDirectory, "node"), '#!/bin/sh\nprintf "%s\\n" "$*"\n', { mode: 0o755 });
    for (const command of ["chown", "docker"]) {
      writeFileSync(path.join(binDirectory, command), "#!/bin/sh\necho 'Unexpected ownership repair' >&2\nexit 99\n", { mode: 0o755 });
    }
  });

  afterEach(() => {
    chmodSync(dataDirectory, 0o755);
    rmSync(directory, { recursive: true, force: true });
  });

  function runEntrypoint() {
    return spawnSync("sh", [entrypointPath], {
      cwd: root,
      env: { ...process.env, DATA_DIR: dataDirectory, PATH: `${binDirectory}:${process.env.PATH}` },
      encoding: "utf8",
      timeout: 5000,
    });
  }

  it("cleans up the writable probe and runs Prisma, seed, then Next", () => {
    const result = runEntrypoint();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim().split("\n")).toEqual([
      "node_modules/prisma/build/index.js db push",
      "node_modules/tsx/dist/cli.mjs prisma/seed.ts",
      "node_modules/next/dist/bin/next start -p 3000 -H 0.0.0.0",
    ]);
    expect(readdirSync(dataDirectory)).toEqual([]);
  });

  it.skipIf(process.getuid?.() === 0)("fails before Prisma for an unwritable volume, showing the UID and repair hint", () => {
    chmodSync(dataDirectory, 0o555);
    const result = runEntrypoint();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(`data directory ${dataDirectory} is not writable (uid ${process.getuid?.()})`);
    expect(result.stderr).toContain(fixCommand);
    expect(result.stderr).not.toContain("Unexpected ownership repair");
    expect(readdirSync(dataDirectory)).toEqual([]);
  });
});
