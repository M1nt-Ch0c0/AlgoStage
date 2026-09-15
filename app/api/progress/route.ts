/**
 * POST /api/progress · 学习行为写入（提交/提示消耗/讲解进度）
 * 看板指标的数据源（docs/04 §2）。
 */
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/prisma";

export const runtime = "nodejs";

const USER_ID = "local-default";

export async function POST(req: NextRequest) {
  const body = (await req.json()) as
    | {
        type: "submission";
        problemSlug: string;
        code: string;
        language: string;
        verdict: "AC" | "WA" | "RE" | "TLE";
        runtimeMs?: number;
      }
    | { type: "hint"; problemSlug: string; level: number }
    | { type: "lecture-step"; problemSlug: string; stepIndex: number };

  if (body.type === "submission") {
    await prisma.submission.create({
      data: {
        userId: USER_ID,
        problemSlug: body.problemSlug,
        code: body.code,
        language: body.language,
        verdict: body.verdict,
        runtimeMs: body.runtimeMs,
      },
    });
    const solved = body.verdict === "AC";
    await prisma.problemProgress.upsert({
      where: { userId_problemSlug: { userId: USER_ID, problemSlug: body.problemSlug } },
      update: {
        attempts: { increment: 1 },
        lastStepAt: new Date(),
        ...(solved ? { status: "solved", solvedAt: new Date() } : { status: "learning" }),
      },
      create: {
        userId: USER_ID,
        problemSlug: body.problemSlug,
        attempts: 1,
        status: solved ? "solved" : "learning",
        solvedAt: solved ? new Date() : null,
        lastStepAt: new Date(),
      },
    });
    // AC 后自动生成 SM-2 复习卡（docs/04 §3）
    if (solved) {
      const dueAt = new Date(Date.now() + 24 * 3600 * 1000);
      await prisma.reviewCard.create({
        data: { userId: USER_ID, problemSlug: body.problemSlug, dueAt },
      });
    }
    return Response.json({ ok: true });
  }

  if (body.type === "hint") {
    await prisma.hintUsage.create({
      data: { userId: USER_ID, problemSlug: body.problemSlug, level: body.level },
    });
    return Response.json({ ok: true });
  }

  if (body.type === "lecture-step") {
    await prisma.problemProgress.upsert({
      where: { userId_problemSlug: { userId: USER_ID, problemSlug: body.problemSlug } },
      update: {
        lectureSeen: { increment: 1 },
        status: "learning",
        lastStepAt: new Date(),
      },
      create: {
        userId: USER_ID,
        problemSlug: body.problemSlug,
        lectureSeen: 1,
        status: "learning",
        lastStepAt: new Date(),
      },
    });
    return Response.json({ ok: true });
  }

  return Response.json({ error: "BAD_TYPE" }, { status: 400 });
}
