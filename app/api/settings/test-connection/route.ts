import { z } from "zod";
import { NextRequest } from "next/server";
import { resolveByok } from "@/lib/agent/provider";
import { aiBaseURLSchema, badRequest, baseURLNotAllowed } from "@/lib/agent/request";
import { checkAIConnection, settingsConnectionError, validateBaseURL } from "@/lib/agent/settings-connection";
import { hintTimeoutMs } from "@/lib/agent/defaults";

export const runtime = "nodejs";

const schema = z.object({
  byok: z.object({
    provider: z.enum(["openai-compatible", "anthropic", "google"]).optional(),
    model: z.string().trim().optional(),
    apiKey: z.string().trim().optional(),
    baseURL: aiBaseURLSchema.optional(),
  }).optional(),
});

export async function POST(req: NextRequest) {
  let input: unknown;
  try { input = await req.json(); }
  catch { return badRequest(); }
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    if (parsed.error.issues.some(issue => issue.path.at(-1) === "baseURL")) return baseURLNotAllowed();
    return badRequest(parsed.error);
  }
  const signal = AbortSignal.any([req.signal, AbortSignal.timeout(hintTimeoutMs())]);
  const edits = parsed.data.byok;
  if (edits?.baseURL) {
    const invalid = await validateBaseURL(edits.baseURL, signal);
    if (invalid) return invalid;
  }
  try {
    const resolved = await resolveByok(edits);
    if (!resolved) return Response.json({ error: "NO_BYOK", message: "请填好 API Key 和模型名后再测试。" }, { status: 400 });
    const config = resolved.config;
    const failure = await checkAIConnection(config, signal);
    return failure ?? Response.json({ ok: true });
  } catch (error) {
    return settingsConnectionError(error);
  }
}
