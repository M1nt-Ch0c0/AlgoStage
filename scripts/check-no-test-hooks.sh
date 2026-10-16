#!/usr/bin/env bash
# Fail when a release build still contains the ask capture stall hook or an
# S4 dump marker. The stall hook lives only inside the compile-time test
# block, which Next tree-shakes unless NEXT_PUBLIC_ASK_TEST_BUILD=1.
# S4_PIXELS, S4_PERF_DUMP, and S4_OUT_DIR must not ship in the prod bundle.
set -euo pipefail

root="${1:-.}"
cd "$root"

if ! command -v rg >/dev/null 2>&1; then
  printf 'rg is required\n' >&2
  exit 2
fi

if [[ ! -d .next/static || ! -d .next/server ]]; then
  printf 'error: .next/static and .next/server must both exist\n' >&2
  exit 2
fi

markers=(ASK_TEST_STALL_HOOK S4_PIXELS S4_PERF_DUMP S4_OUT_DIR)
failed=0

for marker in "${markers[@]}"; do
  hits="$(rg -l --fixed-strings -g '*.js' -g '!*.map' "$marker" .next/static .next/server || true)"
  if [[ -n "$hits" ]]; then
    while IFS= read -r file; do
      [[ -z "$file" ]] && continue
      printf '%s %s\n' "$file" "$marker"
    done <<< "$hits"
    failed=1
  fi
done

exit "$failed"
