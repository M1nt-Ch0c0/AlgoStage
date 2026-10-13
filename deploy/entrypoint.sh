#!/bin/sh
# 启动前确保数据库结构和题库就绪（幂等），然后启动服务
set -e

DATA_DIR="${DATA_DIR:-/app/data}"
if ! write_test=$(mktemp "$DATA_DIR/.algostage-write-test.XXXXXX" 2>/dev/null); then
  printf 'Error: data directory %s is not writable (uid %s).\n' "$DATA_DIR" "$(id -u)" >&2
  printf '%s\n' 'For an existing root-owned algostage-data volume, run this one-time fix before switching images:' >&2
  printf '%s\n' 'docker run --rm -v algostage-data:/data alpine chown -R 1001:1001 /data' >&2
  exit 1
fi
rm -f "$write_test"

node node_modules/prisma/build/index.js db push
node node_modules/tsx/dist/cli.mjs prisma/seed.ts
exec node node_modules/next/dist/bin/next start -p 3000 -H 0.0.0.0
