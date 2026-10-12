import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { expect, test, vi } from "vitest";
import { createFixture, fixturePaths } from "./api-fixture";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFileSync: vi.fn((...args: Parameters<typeof actual.execFileSync>) =>
      actual.execFileSync(...args),
    ),
  };
});

test("fixturePaths resolves repoRoot, schema, and prismaCli independent of cwd, and createFixture pushes schema with repoRoot cwd", async () => {
  const expectedRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const initialPaths = fixturePaths();

  expect(initialPaths.repoRoot).toBe(expectedRoot);
  expect(existsSync(initialPaths.schema)).toBe(true);
  expect(relative(initialPaths.repoRoot, initialPaths.schema)).toBe(
    "prisma/schema.prisma",
  );
  expect(initialPaths.schema.startsWith(initialPaths.repoRoot)).toBe(true);
  expect(existsSync(initialPaths.prismaCli)).toBe(true);

  const originalCwd = process.cwd();
  try {
    process.chdir(tmpdir());
    expect(fixturePaths()).toEqual(initialPaths);
  } finally {
    process.chdir(originalCwd);
  }

  const fixture = await createFixture();
  try {
    expect(execFileSync).toHaveBeenCalled();
    const dbPushCall = vi
      .mocked(execFileSync)
      .mock.calls.find(
        ([, args]) =>
          Array.isArray(args) && args.includes("db") && args.includes("push"),
      );
    expect(dbPushCall).toBeDefined();
    const [, args, options] = dbPushCall!;
    expect(args).toContain("--schema");
    expect(args).toContain(initialPaths.schema);
    expect((options as { cwd?: string } | undefined)?.cwd).toBe(
      initialPaths.repoRoot,
    );
  } finally {
    await fixture.close();
  }
});
