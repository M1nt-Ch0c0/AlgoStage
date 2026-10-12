import { test } from "node:test";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";

test("Python 树题在默认递归限制下处理 20000 层退化树", () => {
  const output = execFileSync("python3", ["tests/python-trees.py"], { encoding: "utf8", timeout: 20000 });
  assert.ok(output.includes("20000 层退化树"));
});
