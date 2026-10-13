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
import { resolveByok, ByokConfigurationError, ByokKeyRequiredError, type ByokConfig, savedBaseURLOf } from "@/lib/agent/provider";
import { buildLecturePrompt } from "@/lib/agent/modes/lecture";
import { highlightProblem } from "@/lib/agent/lecture-highlights";
import { validateScript } from "@/lib/teaching/validated-script";
import { lectureRequestSchema, badRequest, baseURLInvalid, byokKeyRequired, configurationError, upstreamError } from "@/lib/agent/request";
import { localSeedSource } from "@/lib/content/local-source";
import { prisma } from "@/lib/db/prisma";
import { AI_CONNECTION_ERROR, InvalidAIBaseURLError, ServerAIBaseURLError } from "@/lib/ai/egress-guard";
import { validateBaseURL } from "@/lib/agent/settings-connection";
import { hintTimeoutMs } from "@/lib/agent/defaults";

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
  if (!parsed.success) return badRequest(parsed.error);
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
  catch (error) {
    if (error instanceof ByokKeyRequiredError) return byokKeyRequired();
    if (error instanceof ServerAIBaseURLError) return upstreamError();
    if (error instanceof InvalidAIBaseURLError) return baseURLInvalid();
    if (error instanceof ByokConfigurationError) return configurationError();
    throw error;
  }
  const byok = resolved?.config;
  if (!byok) {
    return Response.json(
      { error: "NO_BYOK", message: "老师还没接上 AI，先去设置里接一下吧。" },
      { status: 400 },
    );
  }

  const checkURL = body.byok?.baseURL || savedBaseURLOf(byok);
  if (checkURL) {
    const invalid = await validateBaseURL(checkURL, AbortSignal.any([req.signal, AbortSignal.timeout(hintTimeoutMs())]));
    if (invalid && req.signal.aborted) return Response.json({ error: "CANCELLED", message: "讲课请求已取消。" }, { status: 499 });
    if (invalid) return invalid;
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

  // A custom upstream can echo its Authorization credential even in a 200 body.
  // Reject it before streaming or persisting any generated content.
  const assertNoRequestKey = (value: unknown) => {
    if (resolved?.source === "request" && JSON.stringify(value).includes(byok.apiKey)) throw new InvalidLectureScriptError();
  };
  const matchesRequest = (script: ReturnType<typeof validateScript>) => {
    assertNoRequestKey(script);
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
        onEvent: event => {
          assertNoRequestKey(event);
          onEvent?.(event);
        },
        referenceCode,
        validateOutput: assertNoRequestKey,
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
        message: AI_CONNECTION_ERROR,
      };
    } finally {
      req.signal.removeEventListener("abort", abort);
    }
  };
  // 成功步骤立即发送；中断时取消模型请求，只有 finish 后的完整教案能写缓存。
  if (req.headers.get("accept")?.includes("application/x-ndjson")) {
    let disconnected = false;
    // Keep the HTTP status writable until the first usable step. DNS/connect/
    // redirect failures before then must be actual 502 responses, even for NDJSON.
    let ready!: (failure?: Extract<GenerationResult, { ok: false }>) => void;
    const firstStep = new Promise<Extract<GenerationResult, { ok: false }> | undefined>(resolve => { ready = resolve; });
    const stream = new ReadableStream({
      async start(controller) {
        const send = (event: unknown) => {
          if (!disconnected)
            controller.enqueue(
              new TextEncoder().encode(JSON.stringify(event) + "\n"),
            );
        };
        try {
          const result = await generate(event => {
            send(event);
            if (event.type === "step" || event.type === "step-update") ready();
          });
          ready(result.ok ? undefined : result);
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
          const failure = {
            ok: false as const,
            error: "UPSTREAM_ERROR" as const,
            message: AI_CONNECTION_ERROR,
            status: 502,
          };
          ready(failure);
          send({
            type: "error",
            error: failure.error,
            message: failure.message,
            status: failure.status,
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
    const failure = await firstStep;
    if (failure) {
      await stream.cancel();
      return Response.json({ error: failure.error, message: failure.message }, { status: failure.status });
    }
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
