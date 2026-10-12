/**
 * POST /api/lecture · 生成讲解脚本（流式）
 * 链路：BYOK → streamObject(TeachingScript) → 前端边收边播（docs/01 §4、docs/03 §5）
 * 缓存：同题同模型只生成一次，落 LectureScriptCache。
 */
import { streamObject } from "ai";
import { createHash } from "crypto";
import { NextRequest } from "next/server";
import { IS_DEMO } from "@/lib/runtime";
import { createModel, resolveByok, type ByokConfig } from "@/lib/agent/provider";
import { buildLecturePrompt } from "@/lib/agent/modes/lecture";
import { teachingScriptSchema } from "@/lib/teaching/schema";
import { localSeedSource } from "@/lib/content/local-source";
import { prisma } from "@/lib/db/prisma";

export const runtime = "nodejs";

function cacheKeyOf(slug: string, model: string, lang: string) {
  return createHash("sha1").update(`${slug}|${model}|${lang}|lecture`).digest("hex");
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as {
    slug: string;
    byok?: ByokConfig;
    language?: "zh" | "en";
  };
  // 在线体验版不调用任何 AI：不代用他人的 Key，也不做模型请求中转
  if (IS_DEMO) {
    return Response.json(
      { error: "DEMO", message: "在线体验版只备好了「两数之和」这一课。把 AlgoStage 装到自己电脑上，接上你的 AI，就能听全部 100 题。" },
      { status: 403 },
    );
  }
  const resolved = await resolveByok(body.byok);
  const byok = resolved?.config;
  if (!byok) {
    return Response.json(
      { error: "NO_BYOK", message: "老师还没接上 AI，先去设置里接一下吧。" },
      { status: 400 },
    );
  }

  const key = cacheKeyOf(body.slug, byok.model, byok.model.includes("python") ? "python" : "typescript");
  const cached = await prisma.lectureScriptCache.findUnique({ where: { key } });
  if (cached) {
    return Response.json({ cached: true, script: JSON.parse(cached.script) });
  }

  const detail = await localSeedSource.detail(body.slug);
  const referenceCode =
    detail.referenceSolutions?.find((s) => s.language === "typescript")?.code ??
    detail.referenceSolutions?.[0]?.code ??
    "";

  const result = streamObject({
    model: createModel(byok),
    schema: teachingScriptSchema,
    prompt: buildLecturePrompt({
      title: detail.title,
      statement: detail.statement,
      referenceCode,
      language: body.language ?? "zh",
    }),
  });

  // 后台写缓存（不阻塞流）
  result.object
    .then(async (script) => {
      await prisma.lectureScriptCache.upsert({
        where: { key },
        update: { script: JSON.stringify(script) },
        create: { key, script: JSON.stringify(script) },
      });
    })
    .catch(() => {});

  return result.toTextStreamResponse();
}
