#!/usr/bin/env bash
# Fail when a tree contains SQLite/archive files, backup directories, or
# dotenv files other than .env.example. node_modules is not searched.
set -euo pipefail

root="${1:-/app}"
if [[ "$root" != "/" ]]; then
  root="${root%/}"
fi

hits="$(
  find "$root" \
    -path "$root/node_modules" -prune -o \
    \( \
      -type d -name backups -o \
      -type f \( \
        -name '*.db' -o \
        -name '*.db-journal' -o \
        -name '*.db-wal' -o \
        -name '*.db-shm' -o \
        -name '*.tgz' -o \
        -name '*.tar.gz' -o \
        \( -name '.env.*' ! -name '.env.example' \) \
      \) \
    \) -print | sort
)"

if [[ -n "$hits" ]]; then
  printf '%s\n' "$hits"
  exit 1
fi

echo OK
