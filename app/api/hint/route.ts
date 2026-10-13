/**
 * POST /api/hint · 5 级渐进提示（docs/03 §6）
 * 每次请求只升一级；消耗记录由客户端调 /api/progress 写入 HintUsage。
 */
import { APICallError, generateText } from "ai";
import { NextRequest } from "next/server";
import {
  createModel,
  resolveByok,
  ByokConfigurationError,
  ByokKeyRequiredError,
} from "@/lib/agent/provider";
import {
  hintRequestSchema,
  badRequest,
  upstreamError,
  configurationError,
  byokKeyRequired,
} from "@/lib/agent/request";
import { localSeedSource } from "@/lib/content/local-source";
import {
  isTransientUpstreamError,
  UPSTREAM_RETRY_LIMIT,
  waitForUpstreamRetry,
} from "@/lib/agent/upstream-retry";
import { hintTimeoutMs } from "@/lib/agent/defaults";
import { InvalidAIBaseURLError } from "@/lib/ai/egress-guard";
import { validateBaseURL } from "@/lib/agent/settings-connection";

export const runtime = "nodejs";

const LEVEL_GUIDE: Record<number, string> = {
  1: "只引导学生重读题目的关键条件，指出被忽略的信息，不提任何算法名词。",
  2: "点出本题所属的算法模式（如哈希表/双指针/单调栈），但不讲怎么用。",
  3: "给出思路方向：用什么数据结构、按什么顺序处理，但不给实现细节。",
  4: "给出关键实现技巧与易错点，可以给一两行示意代码。",
  5: "给出伪代码骨架（仍不写完整可运行答案）。",
};

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
  const parsed = hintRequestSchema.safeParse(input);
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
  try {
    resolved = await resolveByok(body.byok);
  } catch (error) {
    if (error instanceof ByokKeyRequiredError) return byokKeyRequired();
    if (error instanceof InvalidAIBaseURLError) return upstreamError();
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
  const timeout = AbortSignal.timeout(hintTimeoutMs());
  const signal = AbortSignal.any([req.signal, timeout]);
  if (body.byok?.baseURL) {
    const invalid = await validateBaseURL(body.byok.baseURL, signal);
    if (invalid && signal.aborted) {
      return Response.json(
        timeout.aborted
          ? { error: "TIMEOUT", message: "提示请求超时，请重试。" }
          : { error: "CANCELLED", message: "提示请求已取消。" },
        { status: timeout.aborted ? 504 : 499 },
      );
    }
    if (invalid) return invalid;
  }
  const level = body.level;
  const detail = await localSeedSource.detail(body.slug);

  try {
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      try {
        const { text } = await generateText({
          model: createModel(byok),
          maxRetries: 0,
          abortSignal: signal,
          prompt: `你是苏格拉底式算法导师，学生正在做「${detail.title}」，请求第 ${level} 级提示。
规则：${LEVEL_GUIDE[level]}
严格只给这一级的信息，绝不越级剧透更深层答案，绝不给完整题解。80 字以内，中文。
${detail.statement ? `题面：${detail.statement}` : ""}
${body.userCode ? `学生当前代码：\n${body.userCode}` : ""}`,
        });

        if (resolved?.source === "request" && text.includes(byok.apiKey)) return upstreamError();
        return Response.json({ level, hint: text });
      } catch (error) {
        if (
          signal.aborted ||
          attempt >= UPSTREAM_RETRY_LIMIT ||
          !isTransientUpstreamError(error)
        )
          throw error;
        await waitForUpstreamRetry(signal);
      }
    }
  } catch (error) {
    // 上游错误体可能回显完整 Key；不记录、不透传原始异常。
    if (signal.aborted)
      return Response.json(
        {
          error: timeout.aborted ? "TIMEOUT" : "CANCELLED",
          message: timeout.aborted
            ? "提示请求超时，请重试。"
            : "提示请求已取消。",
        },
        { status: timeout.aborted ? 504 : 499 },
      );
    return upstreamError(APICallError.isInstance(error) ? error.statusCode : undefined);
  }
}
