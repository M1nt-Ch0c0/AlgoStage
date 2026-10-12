import { prisma } from "@/lib/db/prisma";
import { JUDGING_SPECS } from "@/lib/judge/specs";
import type { JudgeLanguage, Verdict } from "@/lib/judge/types";

interface SubmissionInput {
  problemSlug: string;
  code: string;
  language: JudgeLanguage;
  verdict: Verdict;
  runtimeMs?: number;
}

/** AC 仅供服务端判题调用；/api/progress 在解析时排除客户端 AC。 */
export async function recordSubmission(userId: string, input: SubmissionInput) {
  const now = new Date();
  return prisma.$transaction(async tx => {
    await tx.submission.create({ data: { userId, ...input } });
    const where = { userId, problemSlug: input.problemSlug };
    await tx.problemProgress.upsert({
      where: { userId_problemSlug: where },
      update: { attempts: { increment: 1 }, lastStepAt: now },
      create: { ...where, attempts: 1, lastStepAt: now, status: "learning" },
    });
    // 条件写入不会覆盖另一个提交已经建立的 solved/mastered 状态。
    await tx.problemProgress.updateMany({
      where: { ...where, status: { in: ["untouched", "learning"] } },
      data: { status: input.verdict === "AC" ? "solved" : "learning" },
    });
    if (input.verdict === "AC") {
      await tx.problemProgress.updateMany({
        where: { ...where, solvedAt: null }, data: { solvedAt: now },
      });
    }

    // 没有判题用例的题不进入复习队列；讲解上报也不产生复习卡。
    if (Object.hasOwn(JUDGING_SPECS, input.problemSlug)) {
      const card = await tx.reviewCard.findFirst({ where });
      const passed = input.verdict === "AC";
      // docs/04 §3 的简版 SM-2：AC 记 5 分，失败记 2 分并回到一天后。
      const grade = passed ? 5 : 2;
      const ease = Math.max(1.3, (card?.ease ?? 2.5) + 0.1 - (5 - grade) * (0.08 + (5 - grade) * 0.02));
      const interval = passed && card ? Math.max(1, Math.round(card.interval * card.ease)) : 1;
      const schedule = {
        ease, interval, dueAt: new Date(now.getTime() + interval * 86400000),
        reps: passed ? (card?.reps ?? 0) + 1 : 0,
        lapses: (card?.lapses ?? 0) + (passed ? 0 : 1),
      };
      if (card) await tx.reviewCard.update({ where: { id: card.id }, data: schedule });
      else await tx.reviewCard.create({ data: { ...where, ...schedule } });
    }
  });
}

export async function recordLectureStep(userId: string, problemSlug: string) {
  const where = { userId, problemSlug }, now = new Date();
  await prisma.$transaction(async tx => {
    await tx.problemProgress.upsert({
      where: { userId_problemSlug: where },
      update: { lectureSeen: { increment: 1 }, lastStepAt: now },
      create: { ...where, lectureSeen: 1, lastStepAt: now, status: "learning" },
    });
    await tx.problemProgress.updateMany({ where: { ...where, status: "untouched" }, data: { status: "learning" } });
  });
}
