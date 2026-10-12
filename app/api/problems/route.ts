/** GET /api/problems · Hot 100 元数据列表（含进度） */
import { prisma } from "@/lib/db/prisma";
import { HOT100 } from "@/lib/content/hot100";
import { currentUserId } from "@/lib/visitor";

export const runtime = "nodejs";

export async function GET() {
  const userId = await currentUserId();
  const progress = await prisma.problemProgress.findMany({
    where: { userId },
  });
  const progressMap = new Map(progress.map((p) => [p.problemSlug, p]));
  return Response.json({
    problems: HOT100.map((p) => ({
      ...p,
      status: progressMap.get(p.slug)?.status ?? "untouched",
    })),
  });
}
