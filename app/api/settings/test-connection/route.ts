import { z } from "zod";
import { NextRequest } from "next/server";
import { resolveByok } from "@/lib/agent/provider";
import { aiBaseURLSchema, badRequest, baseURLNotAllowed, byokRequestSchema } from "@/lib/agent/request";
import { checkAIConnection, settingsConnectionError, validateSettingsBaseURL } from "@/lib/agent/settings-connection";
import { hintTimeoutMs } from "@/lib/agent/defaults";
import { normalizeAIBaseURL } from "@/lib/ai/egress-guard";

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
    const invalid = await validateSettingsBaseURL(edits.baseURL, signal);
    if (invalid) return invalid;
  }
  try {
    const supplied = edits?.apiKey ? byokRequestSchema.parse(edits) : undefined;
    if (supplied && !supplied.model) return badRequest();
    const resolved = await resolveByok(supplied);
    if (!resolved) return Response.json({ error: "NO_BYOK", message: "请填好 API Key 和模型名后再测试。" }, { status: 400 });
    const config = resolved.config;
    if (!supplied && edits && (
      (edits.baseURL !== undefined && normalizeAIBaseURL(edits.baseURL) !== normalizeAIBaseURL(config.baseURL ?? "")) ||
      (edits.provider !== undefined && edits.provider !== config.provider)
    )) {
      return Response.json({ error: "BYOK_KEY_REQUIRED", message: "更换接口地址或服务商时，请同时填写 API Key。" }, { status: 400 });
    }
    const failure = await checkAIConnection({ ...config, model: edits?.model || config.model }, signal);
    return failure ?? Response.json({ ok: true });
  } catch (error) {
    return settingsConnectionError(error);
  }
}
