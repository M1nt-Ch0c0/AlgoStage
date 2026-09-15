/**
 * GET/PUT /api/settings · BYOK 与偏好设置（仅存本地 SQLite）
 */
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/prisma";

export const runtime = "nodejs";

const USER_ID = "local-default";
const ALLOWED_KEYS = new Set([
  "provider",
  "model",
  "apiKey",
  "baseURL",
  "theme",
  "effectLevel",
  "narrationSpeed",
]);

export async function GET() {
  const rows = await prisma.setting.findMany({ where: { userId: USER_ID } });
  const settings = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  // 不回传完整 Key，只回掩码
  if (settings.apiKey) {
    const k = settings.apiKey as string;
    settings.apiKeyMasked = k.length > 8 ? `${k.slice(0, 4)}…${k.slice(-4)}` : "已配置";
    delete settings.apiKey;
  }
  return Response.json({ settings });
}

export async function PUT(req: NextRequest) {
  const body = (await req.json()) as { settings: Record<string, string> };
  for (const [key, value] of Object.entries(body.settings ?? {})) {
    if (!ALLOWED_KEYS.has(key)) continue;
    await prisma.setting.upsert({
      where: { key_userId: { key, userId: USER_ID } },
      update: { value },
      create: { key, value, userId: USER_ID },
    });
  }
  return Response.json({ ok: true });
}
