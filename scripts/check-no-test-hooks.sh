#!/usr/bin/env bash
# Fail when a release build still contains the ask capture stall hook or an
# S4 dump marker. The stall hook lives only inside the compile-time test
# block, which Next tree-shakes unless NEXT_PUBLIC_ASK_TEST_BUILD=1.
# S4_PIXELS, S4_PERF_DUMP, and S4_OUT_DIR must not ship in the prod bundle.
#
# Walks .next with Node so CI images that do not ship ripgrep still pass.
set -euo pipefail

root="${1:-.}"
cd "$root"

if [[ ! -d .next/static || ! -d .next/server ]]; then
  printf 'error: .next/static and .next/server must both exist\n' >&2
  exit 2
fi

exec node --input-type=module -e '
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const markers = ["ASK_TEST_STALL_HOOK", "S4_PIXELS", "S4_PERF_DUMP", "S4_OUT_DIR"];
const roots = [".next/static", ".next/server"];

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walk(full));
    } else if (entry.isFile() && entry.name.endsWith(".js") && !entry.name.endsWith(".js.map")) {
      files.push(full);
    }
  }
  return files;
}

const files = (await Promise.all(roots.map((dir) => walk(dir)))).flat().sort();
let failed = 0;
for (const file of files) {
  const text = await readFile(file, "utf8");
  for (const marker of markers) {
    if (text.includes(marker)) {
      process.stdout.write(`${file} ${marker}\n`);
      failed = 1;
    }
  }
}
process.exit(failed);
'
