/**
 * GET /api/dashboard · 看板聚合指标（docs/04 §2）
 */
import { prisma } from "@/lib/db/prisma";
import { HOT100 } from "@/lib/content/hot100";

export const runtime = "nodejs";

const USER_ID = "local-default";

export async function GET() {
  const [submissions, progress, hints, reviewDue] = await Promise.all([
    prisma.submission.findMany({ where: { userId: USER_ID } }),
    prisma.problemProgress.findMany({ where: { userId: USER_ID } }),
    prisma.hintUsage.findMany({ where: { userId: USER_ID } }),
    prisma.reviewCard.count({ where: { userId: USER_ID, dueAt: { lte: new Date() } } }),
  ]);

  // 热力图：按天聚合活动数（近 365 天）
  const heatmap: Record<string, number> = {};
  for (const s of submissions) {
    const day = s.createdAt.toISOString().slice(0, 10);
    heatmap[day] = (heatmap[day] ?? 0) + 1;
  }

  // 知识点掌握度：每模式 题分均值（solved 0.6 / mastered 1.0 − 提示惩罚）
  const progressMap = new Map(progress.map((p) => [p.problemSlug, p]));
  const hintsByProblem = new Map<string, number>();
  for (const h of hints) {
    hintsByProblem.set(h.problemSlug, (hintsByProblem.get(h.problemSlug) ?? 0) + 1);
  }
  const byPattern = new Map<string, { total: number; score: number }>();
  for (const p of HOT100) {
    for (const pattern of p.patterns) {
      const entry = byPattern.get(pattern) ?? { total: 0, score: 0 };
      entry.total += 1;
      const prog = progressMap.get(p.slug);
      if (prog?.status === "solved" || prog?.status === "mastered") {
        const base = prog.status === "mastered" ? 1 : 0.6;
        const penalty = Math.min(0.4, (hintsByProblem.get(p.slug) ?? 0) * 0.1);
        entry.score += Math.max(0.1, base - penalty);
      }
      byPattern.set(pattern, entry);
    }
  }
  const mastery = Object.fromEntries(
    [...byPattern].map(([k, v]) => [k, Math.round((v.score / v.total) * 100) / 100]),
  );

  // Streak
  const days = new Set(submissions.map((s) => s.createdAt.toISOString().slice(0, 10)));
  let streak = 0;
  const cursor = new Date();
  if (!days.has(cursor.toISOString().slice(0, 10))) {
    cursor.setDate(cursor.getDate() - 1); // 今天还没学则从昨天算起
  }
  while (days.has(cursor.toISOString().slice(0, 10))) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }

  const acCount = progress.filter((p) => p.status === "solved" || p.status === "mastered").length;
  const independentAc = progress.filter(
    (p) =>
      (p.status === "solved" || p.status === "mastered") &&
      !hintsByProblem.has(p.problemSlug),
  ).length;

  return Response.json({
    heatmap,
    mastery,
    streak,
    acCount,
    totalSubmissions: submissions.length,
    independence: acCount === 0 ? 1 : Math.round((independentAc / acCount) * 100) / 100,
    reviewDue,
  });
}
