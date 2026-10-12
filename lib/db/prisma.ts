import { PrismaClient } from "./generated/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { databaseURL } from "./database-url";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient({
  adapter: new PrismaBetterSqlite3({ url: databaseURL() }),
});

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
