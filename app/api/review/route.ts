import { prisma } from "@/lib/db/prisma";
import { HOT100 } from "@/lib/content/hot100";
import { currentUserId } from "@/lib/visitor";

export const runtime = "nodejs";

export async function GET() {
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
