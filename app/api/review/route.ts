import { prisma } from "@/lib/db/prisma";
import { HOT100 } from "@/lib/content/hot100";
import { IS_DEMO } from "@/lib/runtime";
import { currentUserId } from "@/lib/visitor";

export const runtime = "nodejs";

export async function GET() {
  if (IS_DEMO) return Response.json(
    { error: "DEMO", message: "在线体验版不记录学习进度，请安装到本机后使用。" },
    { status: 403 },
  );
  const userId = await currentUserId();
  const [cards, progress] = await Promise.all([
    prisma.reviewCard.findMany({ where: { userId, dueAt: { lte: new Date() } }, orderBy: { dueAt: "asc" } }),
    prisma.problemProgress.findMany({ where: { userId } }),
  ]);
  const status = new Map(progress.map(item => [item.problemSlug, item.status]));
  return Response.json({ cards: cards.map(card => {
    const problem = HOT100.find(item => item.slug === card.problemSlug);
    return { ...card, title: problem?.title ?? card.problemSlug, number: problem?.number, status: status.get(card.problemSlug) ?? "untouched" };
  }) });
}
