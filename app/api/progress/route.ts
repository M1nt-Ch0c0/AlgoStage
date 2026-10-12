/**
 * POST /api/progress · 学习行为写入（提交/提示消耗/讲解进度）
 * JS/TS 的 AC 必须经过 /api/judge 服务端复判；Python 服务端判不了，接受浏览器 AC 并标记 judgedBy: "client"。
 * 进度只在本地自部署版记录（Demo 下 403），伪造 Python AC 只影响自己。
 */
import { z } from "zod";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { currentUserId } from "@/lib/visitor";
import { recordLectureStep, recordSubmission } from "@/lib/progress";
import { IS_DEMO } from "@/lib/runtime";

export const runtime = "nodejs";

const progressRequestSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("submission"),
      problemSlug: z.string().min(1).max(200),
      code: z.string(),
      language: z.enum(["typescript", "python", "javascript"]),
      verdict: z.enum(["WA", "RE", "TLE"]),
      runtimeMs: z.number().int().min(0).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("client-ac"),
      problemSlug: z.string().min(1).max(200),
      code: z.string(),
      language: z.literal("python"),
      verdict: z.literal("AC"),
      runtimeMs: z.number().int().min(0).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("hint"),
      problemSlug: z.string().min(1).max(200),
      level: z.number().int().min(1).max(5),
    })
    .strict(),
  z
    .object({
      type: z.literal("lecture-step"),
      problemSlug: z.string().min(1).max(200),
      stepIndex: z.number().int().min(0),
    })
    .strict(),
]);

export async function POST(req: NextRequest) {
  // Demo 不记录学习进度；在解析请求、识别访客和写库前直接拒绝。
  if (IS_DEMO) return Response.json(
    { error: "DEMO", message: "在线体验版不记录学习进度，请安装到本机后使用。" },
    { status: 403 },
  );
  let input: unknown;
  try {
    input = await req.json();
  } catch {
    return Response.json(
      { error: "BAD_JSON", message: "学习记录请求不是有效的 JSON。" },
      { status: 400 },
    );
  }
  const parsed = progressRequestSchema.safeParse(input);
  if (!parsed.success) {
    // 在解析访客或写入任何表之前拒绝，包括伪造的 AC；不记录代码或原始输入。
    return Response.json(
      {
        error: "BAD_REQUEST",
        message: "学习记录参数不正确；客户端不能直接上报 AC。",
      },
      { status: 400 },
    );
  }
  const body = parsed.data;
  if (!await prisma.problem.findUnique({ where: { slug: body.problemSlug }, select: { slug: true } })) {
    return Response.json({ error: "NOT_FOUND", message: "题库中没有这道题，请先初始化题库。" }, { status: 404 });
  }
  const userId = await currentUserId();
  if (body.type === "submission" || body.type === "client-ac") {
    await recordSubmission(userId, {
      problemSlug: body.problemSlug, code: body.code, language: body.language,
      verdict: body.verdict, runtimeMs: body.runtimeMs, judgedBy: "client", // 浏览器判的结果；只有 /api/judge 写入 server
    });
    return Response.json({ ok: true });
  }
  if (body.type === "hint") {
    await prisma.hintUsage.create({
      data: { userId, problemSlug: body.problemSlug, level: body.level },
    });
    return Response.json({ ok: true });
  }
  await recordLectureStep(userId, body.problemSlug);
  return Response.json({ ok: true });
}
