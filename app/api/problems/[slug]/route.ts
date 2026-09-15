/** GET /api/problems/[slug] · 题目详情（题面/题解/测试用例） */
import { NextRequest } from "next/server";
import { localSeedSource } from "@/lib/content/local-source";

export const runtime = "nodejs";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  try {
    const detail = await localSeedSource.detail(slug);
    return Response.json({ problem: detail });
  } catch {
    return Response.json({ error: "NOT_FOUND" }, { status: 404 });
  }
}
