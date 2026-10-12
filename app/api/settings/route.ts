/**
 * GET/PUT /api/settings · BYOK 与偏好设置（仅存本地 SQLite）
 */
import { z } from "zod";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { byokFromEnv, resolveSavedByok } from "@/lib/agent/provider";
import { IS_DEMO } from "@/lib/runtime";

export const runtime = "nodejs";

const USER_ID = "local-default";
const settingsRequestSchema = z.object({
  settings: z.object({
    provider: z.enum(["openai-compatible", "anthropic", "google"]).optional(),
    model: z.string().trim().optional(),
    apiKey: z.string().trim().optional(),
    baseURL: z.union([z.url(), z.literal("")]).optional(),
    theme: z.enum(["dark", "light"]).optional(),
    effectLevel: z.enum(["full", "calm", "minimal"]).optional(),
    narrationSpeed: z.enum(["15", "22", "30"]).optional(),
  }),
});

export async function GET() {
  // 在线体验版：访客之间不共享任何设置
  if (IS_DEMO) return Response.json({ settings: {}, keySource: "none", envConfigured: false });
  const rows = await prisma.setting.findMany({ where: { userId: USER_ID } });
  const settings = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const envConfigured = Boolean(byokFromEnv());
  const keySource = resolveSavedByok(settings)?.source ?? "none";
  // 不回传完整 Key，只回掩码
  if (settings.apiKey) {
    const k = settings.apiKey as string;
    settings.apiKeyMasked = k.length > 8 ? `${k.slice(0, 4)}…${k.slice(-4)}` : "已配置";
  }
  delete settings.apiKey;
  return Response.json({ settings, keySource, envConfigured });
}

export async function PUT(req: NextRequest) {
  if (IS_DEMO) {
    return Response.json({ error: "DEMO", message: "在线体验版不能保存设置。" }, { status: 403 });
  }
  let input: unknown;
  try {
    input = await req.json();
  } catch {
    return Response.json({ error: "BAD_JSON", message: "设置请求不是有效的 JSON。" }, { status: 400 });
  }
  const parsed = settingsRequestSchema.safeParse(input);
  if (!parsed.success) {
    // 不回传 zod 原始错误或输入，避免 Key 出现在响应与日志中。
    return Response.json({ error: "BAD_REQUEST", message: "设置参数不正确，请检查 Key、模型和偏好设置。" }, { status: 400 });
  }
  await prisma.$transaction(Object.entries(parsed.data.settings).map(([key, value]) =>
    prisma.setting.upsert({
      where: { key_userId: { key, userId: USER_ID } },
      update: { value },
      create: { key, value, userId: USER_ID },
    }),
  ));
  return Response.json({ ok: true });
}
