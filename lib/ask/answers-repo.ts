/**
 * Read and cleanup helpers for LectureAnswer.
 * Insert stays in M3. PrismaLike is the slice tests can fake.
 */
import { groupAnswersByStep } from "@/lib/ask/answers";
import { stepAnswerSchema } from "@/lib/ask/schema";
import type { StepAnswersMap } from "@/lib/ask/types";

export interface LectureAnswerRow {
  id: string;
  cacheKey: string;
  scriptVersion: string;
  stepId: string;
  payload: string;
  createdAt: Date;
}

export interface PrismaLike {
  lectureAnswer: {
    findMany(args: {
      where: { cacheKey: string; scriptVersion: string };
      orderBy: { createdAt: "asc" };
    }): Promise<LectureAnswerRow[]>;
    deleteMany(args: { where: { cacheKey: string } }): Promise<{ count: number }>;
  };
}

/**
 * Rows for this cache key and script version only.
 * A bad payload, a schema failure, or a stepId that disagrees with the row is dropped.
 */
export async function listAnswers(
  db: PrismaLike,
  cacheKey: string,
  scriptVersion: string,
  validStepIds: ReadonlySet<string>,
): Promise<StepAnswersMap> {
  const rows = await db.lectureAnswer.findMany({
    where: { cacheKey, scriptVersion },
    orderBy: { createdAt: "asc" },
  });
  const list = [];
  for (const row of rows) {
    let payload: unknown;
    try {
      payload = JSON.parse(row.payload);
    } catch {
      console.warn("[ask] dropped lecture answer", { id: row.id });
      continue;
    }
    const parsed = stepAnswerSchema.safeParse(payload);
    if (!parsed.success || parsed.data.stepId !== row.stepId) {
      console.warn("[ask] dropped lecture answer", { id: row.id });
      continue;
    }
    list.push(parsed.data);
  }
  return groupAnswersByStep(list, validStepIds);
}

/** Delete every answer for a cache key. Returns the deleted row count. */
export async function deleteAnswersForCacheKey(tx: PrismaLike, cacheKey: string): Promise<number> {
  const result = await tx.lectureAnswer.deleteMany({ where: { cacheKey } });
  return result.count;
}
