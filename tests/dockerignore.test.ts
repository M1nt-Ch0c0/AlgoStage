import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const lines = readFileSync(join(__dirname, "..", ".dockerignore"), "utf8")
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith("#"));

describe(".dockerignore", () => {
  it.each([
    "*.tgz", "*.tar.gz", "*.db", "*.db-journal", "*.db-wal", "*.db-shm",
    "prisma/*.db", ".env", ".env.*", "!.env.example",
  ])("contains %s", (p) => {
    expect(lines).toContain(p);
  });

  it("keeps !.env.example after .env.*", () => {
    expect(lines.indexOf("!.env.example")).toBeGreaterThan(lines.indexOf(".env.*"));
  });

  it("does not exclude files the Dockerfile needs", () => {
    for (const p of ["prisma", "prisma/schema.prisma", "package.json", "package-lock.json", "deploy", "lib", "scripts"]) {
      expect(lines).not.toContain(p);
    }
  });
});

describe("deploy/README.md backups", () => {
  const readme = readFileSync(join(__dirname, "..", "deploy", "README.md"), "utf8");
  it("does not back up into the source dir", () => {
    expect(readme).not.toContain('-v "$PWD":/backup');
    expect(readme).toContain("~/algostage-backups");
  });
});

const gitLines = readFileSync(join(__dirname, "..", ".gitignore"), "utf8")
  .split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));

describe("db/backup patterns in both ignore files", () => {
  const shared = ["*.db", "*.db-journal", "*.db-wal", "*.db-shm", "*.tgz", "backups/", "/algostage.db", "prisma/*.db"];
  it.each(shared)(".dockerignore contains %s", (p) => expect(lines).toContain(p));
  it.each(shared)(".gitignore contains %s", (p) => expect(gitLines).toContain(p));
});
