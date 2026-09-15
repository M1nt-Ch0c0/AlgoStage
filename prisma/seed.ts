/**
 * 种子脚本：Hot 100 元数据 + 默认用户 + 旗舰讲解脚本缓存
 * 运行：pnpm db:push && pnpm db:seed
 */
import { PrismaClient } from "@prisma/client";
import { HOT100 } from "../lib/content/hot100";
import { TWO_SUM_SCRIPT } from "../lib/content/scripts/two-sum";
import { createHash } from "crypto";

const prisma = new PrismaClient();

async function main() {
  const user = await prisma.user.upsert({
    where: { id: "local-default" },
    update: {},
    create: { id: "local-default", name: "default" },
  });

  for (const p of HOT100) {
    await prisma.problem.upsert({
      where: { slug: p.slug },
      update: {
        title: p.title,
        number: p.number,
        difficulty: p.difficulty,
        patterns: JSON.stringify(p.patterns),
        prereqs: JSON.stringify(p.prereqs),
        order: p.order,
      },
      create: {
        slug: p.slug,
        title: p.title,
        number: p.number,
        difficulty: p.difficulty,
        patterns: JSON.stringify(p.patterns),
        prereqs: JSON.stringify(p.prereqs),
        order: p.order,
      },
    });
  }

  // 旗舰脚本入缓存：无 API Key 也能立即体验讲课
  const cacheKey = createHash("sha1")
    .update("two-sum|builtin|typescript|lecture")
    .digest("hex");
  await prisma.lectureScriptCache.upsert({
    where: { key: cacheKey },
    update: { script: JSON.stringify(TWO_SUM_SCRIPT) },
    create: { key: cacheKey, script: JSON.stringify(TWO_SUM_SCRIPT) },
  });

  console.log(`Seeded ${HOT100.length} problems for user ${user.name}.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
