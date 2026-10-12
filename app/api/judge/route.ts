import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { JUDGING_SPECS } from "@/lib/judge/specs";
import { judgeOnServer, release, tryAcquire } from "@/lib/judge/server";
import { recordSubmission } from "@/lib/progress";
import { currentUserId } from "@/lib/visitor";

export const runtime = "nodejs";

const judgeRequestSchema = z.object({
  problemSlug: z.string().min(1).max(200),
  language: z.enum(["javascript", "typescript", "python"]),
  code: z.string().max(65536),
}).strict();

export async function POST(req: NextRequest) {
  let input: unknown;
  try { input = await req.json(); }
  catch { return Response.json({ error: "BAD_JSON", message: "判题请求不是有效的 JSON。" }, { status: 400 }); }
  const parsed = judgeRequestSchema.safeParse(input);
  if (!parsed.success) {
    return Response.json({ error: "BAD_REQUEST", message: "判题参数不正确；只接受题目、语言和代码。" }, { status: 400 });
  }
  const body = parsed.data;
  if (!Object.hasOwn(JUDGING_SPECS, body.problemSlug) || !JUDGING_SPECS[body.problemSlug].cases.length) {
    return Response.json({ error: "UNJUDGED", message: "这道题未配置判题用例，服务端无法判定。" }, { status: 422 });
  }
  if (body.language === "python") {
    // Python 无法在服务端判题；浏览器结果经 /api/progress 上报并带 judgedBy: "client"。
    return Response.json({ error: "CLIENT_JUDGED", message: "服务端不判 Python；请通过学习记录上报浏览器判题结果。" }, { status: 422 });
  }
  if (!await prisma.problem.findUnique({ where: { slug: body.problemSlug }, select: { slug: true } })) {
    return Response.json({ error: "NOT_FOUND", message: "题库中没有这道题，请先初始化题库。" }, { status: 404 });
  }
  if (!tryAcquire()) {
    return Response.json({ error: "BUSY", message: "判题繁忙，结果未保存，请稍后再试" }, { status: 429 });
  }
  try {
    const result = await judgeOnServer({ ...body, problem: JUDGING_SPECS[body.problemSlug] });
    if (result.error) {
      return Response.json({ error: "UNAVAILABLE", message: "服务端无法判定，执行环境未能启动；没有记录提交，请重试。" }, { status: 503 });
    }
    await recordSubmission(await currentUserId(), { ...body, verdict: result.verdict, runtimeMs: result.runtimeMs, judgedBy: "server" });
    return Response.json({ ok: true, result });
  } finally {
    release();
  }
}
