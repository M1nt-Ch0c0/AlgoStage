import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const script = path.resolve(__dirname, "../scripts/check-no-test-hooks.sh");

describe("check-no-test-hooks", () => {
  let directory: string;

  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  function run() {
    return spawnSync("bash", [script], {
      cwd: directory,
      encoding: "utf8",
      timeout: 10_000,
    });
  }

  it("exits 2 when .next is missing", () => {
    directory = mkdtempSync(path.join(tmpdir(), "algostage-hooks-missing-"));
    const result = run();
    expect(result.status, result.stderr).toBe(2);
    expect(result.stderr).toContain(".next/static");
    expect(result.stderr).toContain(".next/server");
  });

  it("exits 0 when compiled js has no stall hook", () => {
    directory = mkdtempSync(path.join(tmpdir(), "algostage-hooks-clean-"));
    mkdirSync(path.join(directory, ".next/static"), { recursive: true });
    mkdirSync(path.join(directory, ".next/server"), { recursive: true });
    writeFileSync(path.join(directory, ".next/static/app.js"), "const ok = 1;\n");
    writeFileSync(path.join(directory, ".next/server/page.js"), "export const page = 1;\n");
    writeFileSync(
      path.join(directory, ".next/static/app.js.map"),
      "ASK_TEST_STALL_HOOK\nS4_PIXELS\nS4_PERF_DUMP\nS4_OUT_DIR\n",
    );
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("exits 1 and prints the file when compiled js contains the stall hook", () => {
    directory = mkdtempSync(path.join(tmpdir(), "algostage-hooks-hit-"));
    mkdirSync(path.join(directory, ".next/static/chunks"), { recursive: true });
    mkdirSync(path.join(directory, ".next/server"), { recursive: true });
    const hit = path.join(directory, ".next/static/chunks/ask.js");
    writeFileSync(hit, "performance.mark(\"ASK_TEST_STALL_HOOK\");\n");
    const result = run();
    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout).toContain(path.relative(directory, hit));
    expect(result.stdout).toContain("ASK_TEST_STALL_HOOK");
  });

  it("exits 1 and prints the file when compiled js contains S4_PIXELS", () => {
    directory = mkdtempSync(path.join(tmpdir(), "algostage-hooks-pixels-"));
    mkdirSync(path.join(directory, ".next/static/chunks"), { recursive: true });
    mkdirSync(path.join(directory, ".next/server"), { recursive: true });
    const hit = path.join(directory, ".next/static/chunks/pixels.js");
    writeFileSync(hit, "const flag = \"S4_PIXELS\";\n");
    const result = run();
    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout).toContain(path.relative(directory, hit));
    expect(result.stdout).toContain("S4_PIXELS");
  });

  it("exits 1 and prints the file when compiled js contains S4_PERF_DUMP", () => {
    directory = mkdtempSync(path.join(tmpdir(), "algostage-hooks-perf-"));
    mkdirSync(path.join(directory, ".next/static"), { recursive: true });
    mkdirSync(path.join(directory, ".next/server/chunks"), { recursive: true });
    const hit = path.join(directory, ".next/server/chunks/perf.js");
    writeFileSync(hit, "process.env.S4_PERF_DUMP\n");
    const result = run();
    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout).toContain(path.relative(directory, hit));
    expect(result.stdout).toContain("S4_PERF_DUMP");
  });
});
