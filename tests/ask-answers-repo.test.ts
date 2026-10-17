import { describe, expect, it, vi } from "vitest";
import {
  deleteAnswersForCacheKey,
  insertAnswer,
  listAnswers,
  type AnswerInsertDb,
  type LectureAnswerRow,
  type PrismaLike,
} from "@/lib/ask/answers-repo";
import type { StepAnswer } from "@/lib/ask/types";

function row(overrides: Partial<LectureAnswerRow> = {}): LectureAnswerRow {
  return {
    id: "req-1",
    cacheKey: "cache-a",
    scriptVersion: "v-current",
    stepId: "s1",
    payload: JSON.stringify({
      v: 1,
      id: "req-1",
      stepId: "s1",
      question: "为什么？",
      selection: { mode: "single", bbox: { x: 0, y: 0, width: 8, height: 8 }, targets: [] },
      segments: [{ id: "seg", narration: "因为查找。" }],
      createdAt: "2026-10-13T08:00:00.000Z",
    }),
    createdAt: new Date("2026-10-13T08:00:00.000Z"),
    ...overrides,
  };
}

function payloadOf(partial: Record<string, unknown>, createdAt = "2026-10-13T08:00:00.000Z") {
  return JSON.stringify({
    v: 1,
    id: "req",
    stepId: "s1",
    question: "为什么？",
    selection: { mode: "single", bbox: { x: 0, y: 0, width: 8, height: 8 }, targets: [] },
    segments: [{ id: "seg", narration: "因为查找。" }],
    createdAt,
    ...partial,
  });
}

function fakeDb(rows: LectureAnswerRow[]) {
  const findMany = vi.fn(async (args: { where: { cacheKey: string; scriptVersion: string } }) =>
    rows.filter((item) => item.cacheKey === args.where.cacheKey && item.scriptVersion === args.where.scriptVersion),
  );
  const deleteMany = vi.fn(async (args: { where: { cacheKey: string } }) => ({
    count: rows.filter((item) => item.cacheKey === args.where.cacheKey).length,
  }));
  const create = vi.fn(async (args: { data: LectureAnswerRow }) => args.data);
  const db = { lectureAnswer: { findMany, deleteMany, create } } satisfies PrismaLike & AnswerInsertDb;
  return { db, findMany, deleteMany, create };
}

function answerPayload(overrides: Record<string, unknown> = {}): StepAnswer {
  return {
    v: 1,
    id: "req-1",
    stepId: "s1",
    question: "为什么？",
    selection: { mode: "single", bbox: { x: 0, y: 0, width: 8, height: 8 }, targets: [] },
    segments: [{ id: "seg", narration: "因为查找。" }],
    createdAt: "2026-10-13T08:00:00.000Z",
    ...overrides,
  } as StepAnswer;
}

describe("answers repo", () => {
  it("13. 只返回当前 scriptVersion；findMany 的 where 带 cacheKey 与 scriptVersion", async () => {
    const current = row({ id: "now", payload: payloadOf({ id: "now", stepId: "s1" }) });
    const older = row({
      id: "old",
      scriptVersion: "v-old",
      payload: payloadOf({ id: "old", stepId: "s1", createdAt: "2026-10-13T07:00:00.000Z" }),
      createdAt: new Date("2026-10-13T07:00:00.000Z"),
    });
    const otherCache = row({
      id: "other",
      cacheKey: "cache-b",
      payload: payloadOf({ id: "other" }),
    });
    const { db, findMany } = fakeDb([older, otherCache, current]);

    const map = await listAnswers(db, "cache-a", "v-current", new Set(["s1"]));

    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith({
      where: { cacheKey: "cache-a", scriptVersion: "v-current" },
      orderBy: { createdAt: "asc" },
    });
    expect(Object.keys(map)).toEqual(["s1"]);
    expect(map.s1?.map((answer) => answer.id)).toEqual(["now"]);
  });

  it("14. 按 stepId 分组、组内 createdAt 升序；未知或禁问 stepId 丢弃", async () => {
    const rows = [
      row({
        id: "s2-late",
        stepId: "s2",
        payload: payloadOf({ id: "s2-late", stepId: "s2", createdAt: "2026-10-13T10:00:00.000Z" }),
        createdAt: new Date("2026-10-13T10:00:00.000Z"),
      }),
      row({
        id: "s1-late",
        stepId: "s1",
        payload: payloadOf({ id: "s1-late", stepId: "s1", createdAt: "2026-10-13T09:00:00.000Z" }),
        createdAt: new Date("2026-10-13T09:00:00.000Z"),
      }),
      row({
        id: "s1-early",
        stepId: "s1",
        payload: payloadOf({ id: "s1-early", stepId: "s1", createdAt: "2026-10-13T08:00:00.000Z" }),
        createdAt: new Date("2026-10-13T08:00:00.000Z"),
      }),
      row({
        id: "unknown",
        stepId: "ghost",
        payload: payloadOf({ id: "unknown", stepId: "ghost" }),
      }),
      row({
        id: "disabled",
        stepId: "",
        payload: payloadOf({ id: "disabled", stepId: "" }),
      }),
    ];
    const { db } = fakeDb(rows);
    const map = await listAnswers(db, "cache-a", "v-current", new Set(["s1", "s2"]));

    expect(map.s1?.map((answer) => answer.id)).toEqual(["s1-early", "s1-late"]);
    expect(map.s2?.map((answer) => answer.id)).toEqual(["s2-late"]);
    expect(map.ghost).toBeUndefined();
    expect(map[""]).toBeUndefined();
  });

  it("15. 坏 JSON、schema 不合法、payload.stepId 与列不一致时单条丢弃，其余正常", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const good = row({
      id: "good",
      payload: payloadOf({ id: "good", stepId: "s1" }),
    });
    const badJson = row({ id: "bad-json", payload: "{not json" });
    const badSchema = row({
      id: "bad-schema",
      payload: payloadOf({ id: "bad-schema", stepId: "s1", v: 2 }),
    });
    const mismatched = row({
      id: "mismatch",
      stepId: "s1",
      payload: payloadOf({ id: "mismatch", stepId: "s2" }),
    });
    const { db } = fakeDb([badJson, good, badSchema, mismatched]);

    try {
      const map = await listAnswers(db, "cache-a", "v-current", new Set(["s1", "s2"]));
      expect(map.s1?.map((answer) => answer.id)).toEqual(["good"]);
      expect(map.s2).toBeUndefined();
      const warnedIds = warn.mock.calls.map((call) => (call[1] as { id: string }).id);
      expect(warnedIds).toEqual(["bad-json", "bad-schema", "mismatch"]);
      expect(warn.mock.calls.every((call) => call[0] === "[ask] dropped lecture answer" && Object.keys(call[1] as object).join() === "id")).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it("deleteAnswersForCacheKey 返回删除条数", async () => {
    const { db, deleteMany } = fakeDb([
      row({ id: "a" }),
      row({ id: "b" }),
      row({ id: "other", cacheKey: "cache-b" }),
    ]);
    await expect(deleteAnswersForCacheKey(db, "cache-a")).resolves.toBe(2);
    expect(deleteMany).toHaveBeenCalledWith({ where: { cacheKey: "cache-a" } });
  });

  it("insertAnswer 用白名单 JSON 与 createdAt Date 调用 create", async () => {
    const { db, create } = fakeDb([]);
    const payload = answerPayload();

    const stored = await insertAnswer(db, {
      id: "req-1",
      cacheKey: "cache-a",
      scriptVersion: "v-current",
      stepId: "s1",
      payload,
    });

    expect(stored).toEqual(payload);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({
      data: {
        id: "req-1",
        cacheKey: "cache-a",
        scriptVersion: "v-current",
        stepId: "s1",
        payload: JSON.stringify(payload),
        createdAt: new Date(payload.createdAt),
      },
    });
  });

  it("insertAnswer 在 id 不一致时抛错且不写库", async () => {
    const { db, create } = fakeDb([]);
    await expect(
      insertAnswer(db, {
        id: "req-1",
        cacheKey: "cache-a",
        scriptVersion: "v-current",
        stepId: "s1",
        payload: answerPayload({ id: "other" }),
      }),
    ).rejects.toThrow("answer metadata mismatch");
    expect(create).not.toHaveBeenCalled();
  });

  it("insertAnswer 在 stepId 不一致时抛错且不写库", async () => {
    const { db, create } = fakeDb([]);
    await expect(
      insertAnswer(db, {
        id: "req-1",
        cacheKey: "cache-a",
        scriptVersion: "v-current",
        stepId: "s1",
        payload: answerPayload({ stepId: "s2" }),
      }),
    ).rejects.toThrow("answer metadata mismatch");
    expect(create).not.toHaveBeenCalled();
  });

  it("insertAnswer 丢掉 payload 上 schema 之外的字段", async () => {
    const { db, create } = fakeDb([]);
    const extra = { ...answerPayload(), note: "drop me", score: 9 } as StepAnswer & {
      note: string;
      score: number;
    };

    const stored = await insertAnswer(db, {
      id: "req-1",
      cacheKey: "cache-a",
      scriptVersion: "v-current",
      stepId: "s1",
      payload: extra,
    });

    expect(stored).toEqual(answerPayload());
    expect(stored).not.toHaveProperty("note");
    expect(stored).not.toHaveProperty("score");
    const written = create.mock.calls[0]?.[0].data.payload;
    expect(written).toBe(JSON.stringify(answerPayload()));
    expect(written).not.toContain("note");
    expect(written).not.toContain("drop me");
  });

  it("insertAnswer with imageAttached:true preserves true in returned payload and db JSON", async () => {
    const { db, create } = fakeDb([]);
    const payload = answerPayload({ imageAttached: true });

    const stored = await insertAnswer(db, {
      id: "req-1",
      cacheKey: "cache-a",
      scriptVersion: "v-current",
      stepId: "s1",
      payload,
    });

    expect(stored.imageAttached).toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
    const writtenJson = JSON.parse(create.mock.calls[0]?.[0].data.payload);
    expect(writtenJson.imageAttached).toBe(true);
  });

  it("insertAnswer with imageAttached:false preserves false in returned payload and db JSON", async () => {
    const { db, create } = fakeDb([]);
    const payload = answerPayload({ imageAttached: false });

    const stored = await insertAnswer(db, {
      id: "req-1",
      cacheKey: "cache-a",
      scriptVersion: "v-current",
      stepId: "s1",
      payload,
    });

    expect(stored.imageAttached).toBe(false);
    expect(create).toHaveBeenCalledTimes(1);
    const writtenJson = JSON.parse(create.mock.calls[0]?.[0].data.payload);
    expect(writtenJson.imageAttached).toBe(false);
  });

  it("insertAnswer without imageAttached leaves returned and stored payload without imageAttached", async () => {
    const { db, create } = fakeDb([]);
    const payload = answerPayload();
    delete (payload as Partial<StepAnswer>).imageAttached;

    const stored = await insertAnswer(db, {
      id: "req-1",
      cacheKey: "cache-a",
      scriptVersion: "v-current",
      stepId: "s1",
      payload,
    });

    expect(stored.imageAttached).toBeUndefined();
    expect("imageAttached" in stored).toBe(false);
    expect(create).toHaveBeenCalledTimes(1);
    const writtenJson = JSON.parse(create.mock.calls[0]?.[0].data.payload);
    expect(writtenJson.imageAttached).toBeUndefined();
    expect("imageAttached" in writtenJson).toBe(false);
  });

  it("listAnswers keeps imageAttached:false from stored row JSON", async () => {
    const rowWithFalse = row({
      id: "img-false",
      payload: payloadOf({ id: "img-false", stepId: "s1", imageAttached: false }),
    });
    const { db } = fakeDb([rowWithFalse]);

    const map = await listAnswers(db, "cache-a", "v-current", new Set(["s1"]));
    expect(map.s1?.[0]?.imageAttached).toBe(false);
  });
});
