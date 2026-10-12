/**
 * POST /api/lecture · 生成并校验完整讲解脚本
 * 链路：BYOK → generateObject → 校验后返回完整脚本（docs/01 §4、docs/03 §5）
 * 缓存：同题同模型只生成一次，落 LectureScriptCache。
 */
import { generateObject } from "ai";
import { createHash } from "crypto";
import { NextRequest } from "next/server";
import { IS_DEMO } from "@/lib/runtime";
import { createModel, resolveByok, type ByokConfig } from "@/lib/agent/provider";
import { buildLecturePrompt } from "@/lib/agent/modes/lecture";
import { validateScript } from "@/lib/teaching/validated-script";
import { teachingScriptSchema } from "@/lib/teaching/schema";
import { localSeedSource } from "@/lib/content/local-source";
import { prisma } from "@/lib/db/prisma";

export const runtime = "nodejs";

function cacheKeyOf(slug: string, model: string, solutionLanguage: string, narrationLanguage: string) {
  return createHash("sha1").update(`${slug}|${model}|${solutionLanguage}|${narrationLanguage}|lecture`).digest("hex");
}

export async function POST(req: NextRequest) {
  let body: {
    slug: string;
    byok?: ByokConfig;
    language?: "zh" | "en";
    solutionLanguage?: "typescript" | "python";
  };
  try {
    body = await req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Bad body");
  } catch {
    return Response.json({ error: "BAD_JSON", message: "请求内容不是有效的 JSON 对象，请重试。" }, { status: 400 });
  }
  // 在线体验版不调用任何 AI：不代用他人的 Key，也不做模型请求中转
  if (IS_DEMO) {
    return Response.json(
      { error: "DEMO", message: "在线体验版只备好了「两数之和」这一课。把 AlgoStage 装到自己电脑上，接上你的 AI，就能听全部 100 题。" },
      { status: 403 },
    );
  }
  const meta = (await localSeedSource.list()).find((p) => p.slug === body.slug);
  if (!meta) {
    return Response.json({ error: "NOT_FOUND", message: "没找到这道题，请回路线图重新选择。" }, { status: 404 });
  }
  const resolved = await resolveByok(body.byok);
  const byok = resolved?.config;
  if (!byok) {
    return Response.json(
      { error: "NO_BYOK", message: "老师还没接上 AI，先去设置里接一下吧。" },
      { status: 400 },
    );
  }

  const solutionLanguage = body.solutionLanguage ?? "typescript";
  const narrationLanguage = body.language ?? "zh";
  const key = cacheKeyOf(body.slug, byok.model, solutionLanguage, narrationLanguage);
  const detail = await localSeedSource.detail(body.slug);
  const referenceCode =
    detail.referenceSolutions?.find((s) => s.language === solutionLanguage)?.code ??
    detail.referenceSolutions?.[0]?.code ??
    "";

  const matchesRequest = (script: ReturnType<typeof validateScript>) => {
    if (script.problemSlug !== body.slug || script.mode !== "lecture" ||
        script.language !== narrationLanguage || script.solutionLanguage !== solutionLanguage) {
      throw new Error("Script metadata mismatch");
    }
    return script;
  };
  const cached = await prisma.lectureScriptCache.findUnique({ where: { key } });
  if (cached) {
    try {
      const script = matchesRequest(validateScript(JSON.parse(cached.script), referenceCode));
      return Response.json({ cached: true, script });
    } catch {
      // 旧缓存可能未经过校验；丢弃后重新备课。
      await prisma.lectureScriptCache.delete({ where: { key } });
    }
  }

  let script: ReturnType<typeof validateScript> | undefined;
  // 整份教案最多生成两次，失败的输出既不返回也不入库。
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await generateObject({
        model: createModel(byok),
        schema: teachingScriptSchema,
        maxRetries: 0,
        prompt: buildLecturePrompt({
          slug: body.slug,
          title: detail.title,
          statement: detail.statement,
          referenceCode,
          solutionLanguage,
          language: narrationLanguage,
        }),
      });
      script = matchesRequest(validateScript(result.object, referenceCode));
      break;
    } catch {
      // 包括模型输出格式错误；下一次从头生成，不能拼接坏脚本。
    }
  }
  if (!script) {
    return Response.json(
      { error: "INVALID_SCRIPT", message: "老师连续两次都没备好完整教案，请稍后再试，或在设置中换一个模型。" },
      { status: 422 },
    );
  }
  await prisma.lectureScriptCache.upsert({
    where: { key },
    update: { script: JSON.stringify(script) },
    create: { key, script: JSON.stringify(script) },
  });
  return Response.json({ cached: false, script });
}
