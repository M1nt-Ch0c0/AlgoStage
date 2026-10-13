/**
 * GET/PUT /api/settings · BYOK 与偏好设置（仅存本地 SQLite）
 */
import { z } from "zod";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { byokFromEnv, savedKeySource, serverKeyDisabled } from "@/lib/agent/provider";
import { savedEndpoint } from "@/lib/agent/saved-endpoint";
import { aiBaseURLSchema, badRequest, baseURLNotAllowed, settingsLocked } from "@/lib/agent/request";
import { validateBaseURL } from "@/lib/agent/settings-connection";
import { hintTimeoutMs } from "@/lib/agent/defaults";

export const runtime = "nodejs";

const USER_ID = "local-default";
const settingsRequestSchema = z.object({
  settings: z.object({
    provider: z.enum(["openai-compatible", "anthropic", "google"]).optional(),
    model: z.string().trim().optional(),
    apiKey: z.string().trim().optional(),
    baseURL: aiBaseURLSchema.optional(),
    theme: z.enum(["dark", "light"]).optional(),
    effectLevel: z.enum(["full", "calm", "minimal"]).optional(),
    narrationSpeed: z.enum(["15", "22", "30"]).optional(),
  }),
});

export async function GET() {
  const rows = await prisma.setting.findMany({ where: { userId: USER_ID } });
  const settings = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const envConfigured = Boolean(byokFromEnv());
  const disabled = serverKeyDisabled();
  const keySource = disabled ? "none" : savedKeySource(settings);
  // 不回传完整 Key，只回掩码
  delete settings.apiKeyMasked;
  if (!disabled && settings.apiKey?.trim()) {
    const k = settings.apiKey.trim();
    settings.apiKeyMasked = k.length > 8 ? `••••${k.slice(-4)}` : "••••";
  }
  delete settings.apiKey;
  if (settings.baseURL) settings.baseURL = savedEndpoint(settings) ?? "";
  return Response.json({ settings, keySource, envConfigured, serverKeyDisabled: disabled });
}

export async function PUT(req: NextRequest) {
  if (serverKeyDisabled()) return settingsLocked();
  let input: unknown;
  try {
    input = await req.json();
  } catch {
    return Response.json({ error: "BAD_JSON", message: "设置请求不是有效的 JSON。" }, { status: 400 });
  }
  const parsed = settingsRequestSchema.safeParse(input);
  if (!parsed.success) {
    // 不回传 zod 原始错误或输入，避免 Key 出现在响应与日志中。
    if (parsed.error.issues.some(issue => issue.path.at(-1) === "baseURL")) return baseURLNotAllowed();
    return badRequest(parsed.error, "设置参数不正确，请检查 Key、模型和偏好设置。");
  }
  const { baseURL } = parsed.data.settings;
  if (baseURL) {
    const signal = AbortSignal.any([req.signal, AbortSignal.timeout(hintTimeoutMs())]);
    const invalid = await validateBaseURL(baseURL, signal);
    if (invalid) return invalid;
  }
  await prisma.$transaction(async tx => {
    const rows = await tx.setting.findMany({ where: { userId: USER_ID } });
    const previous = Object.fromEntries(rows.map(row => [row.key, row.value]));
    const updates: Record<string, string> = { ...parsed.data.settings };
    const provider = updates.provider ?? previous.provider ?? "openai-compatible";
    if (updates.provider !== undefined && provider !== (previous.provider ?? "openai-compatible") && updates.baseURL === undefined) {
      updates.baseURL = "";
    }
    if (updates.baseURL !== undefined) updates.baseURLProvider = provider;
    for (const [key, value] of Object.entries(updates)) {
      await tx.setting.upsert({
        where: { key_userId: { key, userId: USER_ID } },
        update: { value }, create: { key, value, userId: USER_ID },
      });
    }
  });
  return Response.json({ ok: true });
}
