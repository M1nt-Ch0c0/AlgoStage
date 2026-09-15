/**
 * POST /api/hint · 5 级渐进提示（docs/03 §6）
 * 每次请求只升一级；消耗记录由客户端调 /api/progress 写入 HintUsage。
 */
import { generateText } from "ai";
import { NextRequest } from "next/server";
import { createModel, byokFromEnv, type ByokConfig } from "@/lib/agent/provider";
import { localSeedSource } from "@/lib/content/local-source";

export const runtime = "nodejs";

const LEVEL_GUIDE: Record<number, string> = {
  1: "只引导学生重读题目的关键条件，指出被忽略的信息，不提任何算法名词。",
  2: "点出本题所属的算法模式（如哈希表/双指针/单调栈），但不讲怎么用。",
  3: "给出思路方向：用什么数据结构、按什么顺序处理，但不给实现细节。",
  4: "给出关键实现技巧与易错点，可以给一两行示意代码。",
  5: "给出伪代码骨架（仍不写完整可运行答案）。",
};

export async function POST(req: NextRequest) {
  const body = (await req.json()) as {
    slug: string;
    level: number;
    userCode?: string;
    byok?: ByokConfig;
  };
  const byok = body.byok ?? byokFromEnv();
  if (!byok) {
    return Response.json(
      { error: "NO_BYOK", message: "请先在设置页配置 API Key 与模型" },
      { status: 400 },
    );
  }
  const level = Math.min(5, Math.max(1, body.level));
  const detail = await localSeedSource.detail(body.slug);

  const { text } = await generateText({
    model: createModel(byok),
    prompt: `你是苏格拉底式算法导师，学生正在做「${detail.title}」，请求第 ${level} 级提示。
规则：${LEVEL_GUIDE[level]}
严格只给这一级的信息，绝不越级剧透更深层答案，绝不给完整题解。80 字以内，中文。
${detail.statement ? `题面：${detail.statement}` : ""}
${body.userCode ? `学生当前代码：\n${body.userCode}` : ""}`,
  });

  return Response.json({ level, hint: text });
}
