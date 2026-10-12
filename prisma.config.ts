import nextEnv from "@next/env";
import { defineConfig } from "prisma/config";
import { databaseURL } from "./lib/db/database-url";

// 与 Next 运行时一致，加载 .env.local / .env；生成客户端时无需预先填写数据库 URL。
nextEnv.loadEnvConfig(process.cwd());
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { seed: "tsx prisma/seed.ts" },
  datasource: { url: databaseURL() },
});
