/**
 * Read and cleanup helpers for LectureAnswer.
 * Insert stays in M3. PrismaLike is the slice tests can fake.
 */
import { groupAnswersByStep } from "@/lib/ask/answers";
import { stepAnswerSchema } from "@/lib/ask/schema";
import type { StepAnswer, StepAnswersMap } from "@/lib/ask/types";

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

export interface AnswerInsertDb {
  lectureAnswer: {
    create(args: { data: LectureAnswerRow }): Promise<LectureAnswerRow>;
  };
}

export async function insertAnswer(
  db: AnswerInsertDb,
  input: {
    id: string;
    cacheKey: string;
    scriptVersion: string;
    stepId: string;
    payload: StepAnswer;
  },
): Promise<StepAnswer> {
  const parsed = stepAnswerSchema.parse(input.payload);
  if (parsed.id !== input.id || parsed.stepId !== input.stepId) {
    throw new Error("answer metadata mismatch");
  }
  const payload: StepAnswer = {
    v: 1,
    id: parsed.id,
    stepId: parsed.stepId,
    question: parsed.question,
    selection: parsed.selection,
    segments: parsed.segments,
    createdAt: parsed.createdAt,
  };
  await db.lectureAnswer.create({
    data: {
      id: input.id,
      cacheKey: input.cacheKey,
      scriptVersion: input.scriptVersion,
      stepId: input.stepId,
      payload: JSON.stringify(payload),
      createdAt: new Date(payload.createdAt),
    },
  });
  return payload;
}
