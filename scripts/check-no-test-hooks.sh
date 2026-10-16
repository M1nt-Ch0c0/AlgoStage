#!/usr/bin/env bash
# Fail when a release build still contains the ask capture stall hook.
# The marker lives only inside the compile-time test block, which Next
# tree-shakes unless NEXT_PUBLIC_ASK_TEST_BUILD=1.
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

hits="$(rg -l -g '*.js' -g '!*.map' ASK_TEST_STALL_HOOK .next/static .next/server || true)"
if [[ -n "$hits" ]]; then
  printf '%s\n' "$hits"
  exit 1
fi
