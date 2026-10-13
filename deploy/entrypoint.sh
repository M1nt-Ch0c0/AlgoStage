#!/bin/sh
# 启动前确保数据库结构和题库就绪（幂等），然后启动服务
set -e
node node_modules/prisma/build/index.js db push
node node_modules/tsx/dist/cli.mjs prisma/seed.ts
exec node node_modules/next/dist/bin/next start -p 3000 -H 0.0.0.0
