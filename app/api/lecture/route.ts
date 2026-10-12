/**
 * POST /api/lecture · 生成并校验完整讲解脚本
 * 链路：BYOK → 教学工具 → 逐步播放 → 完整校验后缓存（docs/01 §4、docs/03 §5）
 * 缓存：同题同模型只生成一次，落 LectureScriptCache。
 */
import {
  generateLecture,
  InvalidLectureScriptError,
  type LectureEvent,
  type GenerationResult,
} from "@/lib/agent/lecture-generation";
import { createHash } from "crypto";
import { NextRequest } from "next/server";
import { resolveByok, ByokConfigurationError, type ByokConfig } from "@/lib/agent/provider";
import { buildLecturePrompt } from "@/lib/agent/modes/lecture";
import { highlightProblem } from "@/lib/agent/lecture-highlights";
import { validateScript } from "@/lib/teaching/validated-script";
import { lectureRequestSchema, badRequest, configurationError } from "@/lib/agent/request";
import { localSeedSource } from "@/lib/content/local-source";
import { prisma } from "@/lib/db/prisma";

export const runtime = "nodejs";

function cacheKeyOf(
  slug: string,
  config: ByokConfig,
  solutionLanguage: string,
  narrationLanguage: string,
) {
  return createHash("sha1")
    // 隔离厂商与兼容接口，同名模型不能串缓存；密钥不参与键或元数据。
    .update(JSON.stringify([slug, config.provider, config.baseURL ?? "", config.model, solutionLanguage, narrationLanguage, "lecture"]))
    .digest("hex");
}

export async function POST(req: NextRequest) {
  let input: unknown;
  try {
    input = await req.json();
  } catch {
    return Response.json(
      { error: "BAD_JSON", message: "请求内容不是有效的 JSON 对象，请重试。" },
      { status: 400 },
    );
  }
  const parsed = lectureRequestSchema.safeParse(input);
  if (!parsed.success) return badRequest();
  const body = parsed.data;
  const meta = (await localSeedSource.list()).find((p) => p.slug === body.slug);
  if (!meta) {
    return Response.json(
      { error: "NOT_FOUND", message: "没找到这道题，请回路线图重新选择。" },
      { status: 404 },
    );
  }
  let resolved;
  try { resolved = await resolveByok(body.byok); }
  catch (error) { if (error instanceof ByokConfigurationError) return configurationError(); throw error; }
  const byok = resolved?.config;
  if (!byok) {
    return Response.json(
      { error: "NO_BYOK", message: "老师还没接上 AI，先去设置里接一下吧。" },
      { status: 400 },
    );
  }

  const solutionLanguage = body.solutionLanguage ?? "typescript";
  const narrationLanguage = body.language ?? "zh";
  const key = cacheKeyOf(
    body.slug,
    byok,
    solutionLanguage,
    narrationLanguage,
  );
  const detail = await localSeedSource.detail(body.slug);
  const referenceCode =
    detail.referenceSolutions?.find((s) => s.language === solutionLanguage)
      ?.code ??
    detail.referenceSolutions?.[0]?.code ??
    "";

  const matchesRequest = (script: ReturnType<typeof validateScript>) => {
    if (
      script.problemSlug !== body.slug ||
      script.mode !== "lecture" ||
      script.language !== narrationLanguage ||
      script.solutionLanguage !== solutionLanguage
    ) {
      throw new InvalidLectureScriptError();
    }
    // 同样检查旧缓存；不能继续复用只高亮空行或签名的旧教案。
    const lines = referenceCode.trimEnd().split("\n");
    for (const step of script.steps) {
      const codeTargets = step.targets.filter(target => target.kind === "code-line" || target.kind === "code-token");
      for (const target of codeTargets.length ? codeTargets : step.targets) {
        if (highlightProblem(lines, step.narration, target)) throw new InvalidLectureScriptError();
      }
    }
    return script;
  };
  // 显式重新生成跳过缓存读取；仅在生成成功并校验后 upsert 覆盖，失败或取消保留旧缓存。
  const cached = body.regenerate ? null : await prisma.lectureScriptCache.findUnique({ where: { key } });
  if (cached) {
    try {
      const script = matchesRequest(
        validateScript(JSON.parse(cached.script), referenceCode),
      );
      return Response.json({ cached: true, script });
    } catch {
      // 旧缓存可能未经过校验；丢弃后重新备课。
      await prisma.lectureScriptCache.delete({ where: { key } });
    }
  }

  const generationAbort = new AbortController();
  const abort = () => generationAbort.abort();
  if (req.signal.aborted) abort();
  else req.signal.addEventListener("abort", abort, { once: true });
  const generate = async (
    onEvent?: (event: LectureEvent) => void,
  ): Promise<GenerationResult> => {
    const cancelled: GenerationResult = {
      ok: false,
      status: 499,
      error: "CANCELLED",
      message: "备课已取消，未保存教案。",
    };
    try {
      const result = await generateLecture({
        config: byok,
        signal: generationAbort.signal,
        onEvent,
        referenceCode,
        metadata: {
          problemSlug: body.slug,
          mode: "lecture",
          language: narrationLanguage,
          solutionLanguage,
        },
        prompt: buildLecturePrompt({
          slug: body.slug,
          title: detail.title,
          statement: detail.statement,
          referenceCode,
          solutionLanguage,
          language: narrationLanguage,
        }),
        validate: (value) =>
          matchesRequest(validateScript(value, referenceCode)),
      });
      if (!result.ok) return result;
      if (generationAbort.signal.aborted) return cancelled;
      // 缓存写入期间也保持取消监听；取消时回滚本次写入。
      await prisma.$transaction(async (tx) => {
        if (generationAbort.signal.aborted) throw new Error("Cancelled");
        await tx.lectureScriptCache.upsert({
          where: { key },
          update: { script: JSON.stringify(result.script) },
          create: { key, script: JSON.stringify(result.script) },
        });
        if (generationAbort.signal.aborted) throw new Error("Cancelled");
      });
      return result;
    } catch {
      if (generationAbort.signal.aborted) return cancelled;
      // 上游可能把 Key 放进异常，响应和日志都不包含原始异常。
      return {
        ok: false,
        status: 502,
        error: "UPSTREAM_ERROR",
        message: "这次备课未能完成，请点击重试或换用推荐模型 gpt-6.1-sol。",
      };
    } finally {
      req.signal.removeEventListener("abort", abort);
    }
  };
  // 成功步骤立即发送；中断时取消模型请求，只有 finish 后的完整教案能写缓存。
  if (req.headers.get("accept")?.includes("application/x-ndjson")) {
    let disconnected = false;
    const stream = new ReadableStream({
      async start(controller) {
        const send = (event: unknown) => {
          if (!disconnected)
            controller.enqueue(
              new TextEncoder().encode(JSON.stringify(event) + "\n"),
            );
        };
        try {
          const result = await generate(send);
          send(
            result.ok
              ? { type: "result", cached: false, script: result.script }
              : {
                  type: "error",
                  error: result.error,
                  message: result.message,
                  status: result.status,
                },
          );
        } catch {
          send({
            type: "error",
            error: "UPSTREAM_ERROR",
            message: "这次备课未能完成，请点击重试或换用推荐模型 gpt-6.1-sol。",
            status: 502,
          });
        } finally {
          if (!disconnected) controller.close();
        }
      },
      cancel() {
        disconnected = true;
        generationAbort.abort();
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-store, no-transform",
        "X-Accel-Buffering": "no",
      },
    });
  }
  const result = await generate();
  return result.ok
    ? Response.json({ cached: false, script: result.script })
    : Response.json(
        { error: result.error, message: result.message },
        { status: result.status },
      );
}
