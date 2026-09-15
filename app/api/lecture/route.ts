/**
 * POST /api/lecture · 生成讲解脚本（流式）
 * 链路：BYOK → streamObject(TeachingScript) → 前端边收边播（docs/01 §4、docs/03 §5）
 * 缓存：同题同模型只生成一次，落 LectureScriptCache。
 */
import { streamObject } from "ai";
import { createHash } from "crypto";
import { NextRequest } from "next/server";
import { createModel, byokFromEnv, type ByokConfig } from "@/lib/agent/provider";
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
  const byok = body.byok ?? byokFromEnv();
  if (!byok) {
    return Response.json(
      { error: "NO_BYOK", message: "请先在设置页配置 API Key 与模型" },
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
