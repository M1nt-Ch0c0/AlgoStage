/**
 * 当前用户 ID（仅服务端 Route Handler 使用）
 * 本地版只有一位用户 local-default；在线体验版按浏览器 cookie 区分访客，
 * 首次访问时生成匿名 ID 并建好 User 行，让每位访客的进度互不干扰。
 */
import { cookies } from "next/headers";
import { randomUUID } from "crypto";
import { prisma } from "@/lib/db/prisma";
import { BASE_PATH, IS_DEMO } from "@/lib/runtime";

const LOCAL_USER = "local-default";
const COOKIE = "algostage_visitor";

export async function currentUserId(): Promise<string> {
  if (!IS_DEMO) return LOCAL_USER;
  const jar = await cookies();
  let id = jar.get(COOKIE)?.value;
  if (!id || !/^v_[0-9a-f-]{36}$/.test(id)) {
    id = `v_${randomUUID()}`;
    jar.set(COOKIE, id, {
      httpOnly: true,
      sameSite: "lax",
      secure: true,
      path: BASE_PATH || "/",
      maxAge: 60 * 60 * 24 * 365,
    });
  }
  await prisma.user.upsert({ where: { id }, update: {}, create: { id, name: "visitor" } });
  return id;
}
