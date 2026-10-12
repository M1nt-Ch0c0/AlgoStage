/** Prisma 7 的 CLI 与驱动共用绝对路径，兼容原先相对 prisma/ 的 SQLite 地址。 */
import { resolve } from "node:path";

export function databaseURL(): string {
  const url = process.env.DATABASE_URL || "file:./algostage.db";
  if (!url.startsWith("file:")) return url;
  const path = url.slice(5);
  return path.startsWith("/") ? url : `file:${resolve(process.cwd(), "prisma", path)}`;
}
