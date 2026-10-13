import { describe, it, expect } from "vitest";
import { TWO_SUM_SCRIPT } from "@/lib/content/scripts/two-sum";
import { appendAnswer, countAnswers, findDuplicateStepIds, groupAnswersByStep, summarizeSelection } from "@/lib/ask/answers";
import { ASK_LIMITS } from "@/lib/ask/types";
import type { AskSelection, StepAnswer, StepAnswersMap } from "@/lib/ask/types";

function answer(overrides: Partial<StepAnswer> = {}): StepAnswer {
  return {
    v: 1,
    id: "a1",
    stepId: "s1",
    question: "为什么？",
    selection: {
      mode: "single",
      bbox: { x: 0, y: 0, width: 10, height: 10 },
      targets: [{ kind: "code", id: "c1", text: "map" }],
    },
    segments: [{ id: "seg", narration: "因为查找。" }],
    createdAt: "2026-10-13T08:00:00.000Z",
    ...overrides,
  };
}

describe("ask answers", () => {
  it("12. appendAnswer 不改原对象；同一步按时间排序；同 id 替换不重复", () => {
    const original: StepAnswersMap = {};
    const early = answer({ id: "early", createdAt: "2026-10-13T08:00:00.000Z" });
    const late = answer({ id: "late", createdAt: "2026-10-13T09:00:00.000Z" });
    const middle = answer({ id: "middle", createdAt: "2026-10-13T08:30:00.000Z" });

    const afterEarly = appendAnswer(original, early);
    const afterLate = appendAnswer(afterEarly, late);
    const afterMiddle = appendAnswer(afterLate, middle);

    expect(original).toEqual({});
    expect(afterEarly[early.stepId]).toEqual([early]);
    expect(afterLate.s1?.map((item) => item.id)).toEqual(["early", "late"]);
    expect(afterMiddle.s1?.map((item) => item.id)).toEqual(["early", "middle", "late"]);
    // Previous arrays are left untouched.
    expect(afterEarly.s1).toHaveLength(1);
    expect(afterLate.s1).toHaveLength(2);
    expect(afterEarly.s1).not.toBe(afterMiddle.s1);

    const replaced = answer({
      id: "middle",
      question: "换成新的",
      createdAt: "2026-10-13T10:00:00.000Z",
    });
    const afterReplace = appendAnswer(afterMiddle, replaced);
    expect(afterReplace.s1?.map((item) => item.id)).toEqual(["early", "late", "middle"]);
    expect(afterReplace.s1?.find((item) => item.id === "middle")?.question).toBe("换成新的");
    expect(afterMiddle.s1?.find((item) => item.id === "middle")?.question).toBe("为什么？");
    expect(afterReplace.s1?.filter((item) => item.id === "middle")).toHaveLength(1);

    // A different step gets its own new array; the other step's array is reused.
    const other = answer({ id: "other", stepId: "s2", createdAt: "2026-10-13T07:00:00.000Z" });
    const withOther = appendAnswer(afterReplace, other);
    expect(withOther.s1).toBe(afterReplace.s1);
    expect(withOther.s2).toEqual([other]);
    expect(afterReplace.s2).toBeUndefined();

    // Equal timestamps stay in prior relative order (stable sort).
    const sameTime = answer({ id: "tie", createdAt: early.createdAt });
    const tied = appendAnswer(appendAnswer({}, early), sameTime);
    expect(tied.s1?.map((item) => item.id)).toEqual(["early", "tie"]);

    // Same id keeps the new createdAt and lands in the sorted position.
    const moved = appendAnswer(tied, answer({ id: "early", createdAt: "2026-10-13T11:00:00.000Z" }));
    expect(moved.s1?.map((item) => item.id)).toEqual(["tie", "early"]);
  });

  it("13. groupAnswersByStep 丢弃未知 stepId", () => {
    const list = [
      answer({ id: "a", stepId: "s1", createdAt: "2026-10-13T08:00:00.000Z" }),
      answer({ id: "b", stepId: "unknown", createdAt: "2026-10-13T08:01:00.000Z" }),
      answer({ id: "c", stepId: "s2", createdAt: "2026-10-13T07:00:00.000Z" }),
      answer({ id: "a", stepId: "s1", question: "更新", createdAt: "2026-10-13T06:00:00.000Z" }),
    ];
    const valid = new Set(["s1", "s2"]);
    const grouped = groupAnswersByStep(list, valid);
    expect(Object.keys(grouped).sort()).toEqual(["s1", "s2"]);
    expect(grouped.s1?.map((item) => item.id)).toEqual(["a"]);
    expect(grouped.s1?.[0]?.question).toBe("更新");
    expect(grouped.s1?.[0]?.createdAt).toBe("2026-10-13T06:00:00.000Z");
    expect(grouped.s2?.map((item) => item.id)).toEqual(["c"]);
    expect(grouped.unknown).toBeUndefined();

    const all = groupAnswersByStep(list);
    expect(all.unknown?.map((item) => item.id)).toEqual(["b"]);
    expect(all.s1).toHaveLength(1);

    const emptyGrouped = groupAnswersByStep([], valid);
    expect(Object.keys(emptyGrouped).length).toBe(0);
    expect(Object.getPrototypeOf(emptyGrouped)).toBeNull();
  });

  it("14. countAnswers 跨步求和", () => {
    const map = groupAnswersByStep([
      answer({ id: "a", stepId: "s1" }),
      answer({ id: "b", stepId: "s1", createdAt: "2026-10-13T09:00:00.000Z" }),
      answer({ id: "c", stepId: "s2" }),
    ]);
    expect(countAnswers(map)).toBe(3);
    expect(countAnswers({})).toBe(0);
    expect(countAnswers({ s1: [], s2: [answer()] })).toBe(1);
  });

  it("15. findDuplicateStepIds：[a,b,a,\"\"] → [\"a\",\"\"]；无重复 → []", () => {
    expect(findDuplicateStepIds([{ id: "a" }, { id: "b" }, { id: "a" }, { id: "" }])).toEqual(["a", ""]);
    expect(findDuplicateStepIds([{ id: "a" }, { id: "b" }, { id: "c" }])).toEqual([]);
    expect(findDuplicateStepIds([])).toEqual([]);
    // Empty id is reported even when it appears only once, and only once if repeated.
    expect(findDuplicateStepIds([{ id: "" }])).toEqual([""]);
    expect(findDuplicateStepIds([{ id: "" }, { id: "a" }, { id: "" }, { id: "a" }])).toEqual(["", "a"]);
    // A duplicated id is listed at its second occurrence, once.
    expect(findDuplicateStepIds([
      { id: "a" }, { id: "b" }, { id: "b" }, { id: "a" }, { id: "b" },
    ])).toEqual(["b", "a"]);
  });

  it("16. 真实 seed 教案 findDuplicateStepIds 结果为 []", () => {
    // prisma/seed.ts seeds TWO_SUM_SCRIPT (lib/content/scripts/two-sum).
    // findDuplicateStepIds(TWO_SUM_SCRIPT.steps) === [] — step ids s1..s7 are unique and non-empty.
    expect(findDuplicateStepIds(TWO_SUM_SCRIPT.steps)).toEqual([]);
    expect(TWO_SUM_SCRIPT.steps.map((step) => step.id)).toEqual(["s1", "s2", "s3", "s4", "s5", "s6", "s7"]);
  });

  it("summarizeSelection 截断 text 且不改入参", () => {
    const long = "字".repeat(ASK_LIMITS.targetTextMax + 25);
    const selection: AskSelection = {
      stepId: "s1",
      mode: "region",
      bbox: { x: 1, y: 2, width: 3, height: 4 },
      targets: [
        {
          kind: "code",
          id: "c1",
          stepId: "s1",
          text: long,
          codeRange: { startLine: 2, endLine: 4 },
          vizHit: { structure: "array", nodeIds: ["a0"], indices: [0] },
        },
        { kind: "step", id: "s1" },
        { kind: "subtitle", id: "sub", text: "短" },
      ],
      question: "这个问题不进入摘要",
    };
    const summary = summarizeSelection(selection);
    expect(summary.targets[0]?.text).toHaveLength(ASK_LIMITS.targetTextMax);
    expect(summary.targets[0]?.text).toBe(long.slice(0, ASK_LIMITS.targetTextMax));
    expect(summary.targets[2]?.text).toBe("短");
    expect(summary.targets[1]?.text).toBeUndefined();
    expect(summary).toEqual({
      mode: "region",
      bbox: { x: 1, y: 2, width: 3, height: 4 },
      targets: [
        {
          kind: "code",
          id: "c1",
          stepId: "s1",
          text: long.slice(0, ASK_LIMITS.targetTextMax),
          codeRange: { startLine: 2, endLine: 4 },
          vizHit: { structure: "array", nodeIds: ["a0"], indices: [0] },
        },
        { kind: "step", id: "s1" },
        { kind: "subtitle", id: "sub", text: "短" },
      ],
    });
    expect(selection.targets[0]?.text).toBe(long);
    expect(summary.bbox).not.toBe(selection.bbox);
    expect(summary.targets[0]).not.toBe(selection.targets[0]);
    expect(summary.targets[0]?.codeRange).not.toBe(selection.targets[0]?.codeRange);
    expect(summary.targets[0]?.vizHit).not.toBe(selection.targets[0]?.vizHit);
    expect(summary.targets[0]?.vizHit?.nodeIds).not.toBe(selection.targets[0]?.vizHit?.nodeIds);

    const exact = "字".repeat(ASK_LIMITS.targetTextMax);
    const atLimit = summarizeSelection({
      ...selection,
      targets: [{ kind: "handout", id: "h", text: exact, vizHit: { structure: "array" } }],
    });
    expect(atLimit.targets[0]?.text).toBe(exact);
    expect(atLimit.targets[0]?.vizHit).toEqual({ structure: "array" });
  });

  it("StepAnswersMap 防御 prototype-key pollution（__proto__、constructor、toString、hasOwnProperty 等）", () => {
    const protoKeys = ["constructor", "toString", "__proto__", "hasOwnProperty", "s1", "s2"] as const;
    const mixedAnswers: StepAnswer[] = protoKeys.flatMap((stepId, i) => [
      answer({ id: `${stepId}-1`, stepId, createdAt: `2026-10-13T08:0${i}:00.000Z` }),
      answer({ id: `${stepId}-2`, stepId, createdAt: `2026-10-13T09:0${i}:00.000Z` }),
    ]);

    // 1. groupAnswersByStep 结果为 null-prototype，且包含 own enumerable 数组
    const grouped = groupAnswersByStep(mixedAnswers);
    expect(Object.getPrototypeOf(grouped)).toBeNull();
    expect(Object.keys(grouped).sort()).toEqual([...protoKeys].sort());
    for (const key of protoKeys) {
      expect(Object.hasOwn(grouped, key)).toBe(true);
      expect(Array.isArray(grouped[key])).toBe(true);
      expect(typeof grouped[key]).not.toBe("function");
      expect(grouped[key]).toHaveLength(2);
      expect(grouped[key]?.map((item) => item.id)).toEqual([`${key}-1`, `${key}-2`]);
    }

    // 2. appendAnswer 逐个追加混合 key（起始为 null-prototype），结果为 null-prototype 且为 own enumerable 数组
    let appended: StepAnswersMap = Object.create(null);
    for (const a of mixedAnswers) {
      appended = appendAnswer(appended, a);
    }
    expect(Object.getPrototypeOf(appended)).toBeNull();
    expect(Object.keys(appended).sort()).toEqual([...protoKeys].sort());
    for (const key of protoKeys) {
      expect(Object.hasOwn(appended, key)).toBe(true);
      expect(Array.isArray(appended[key])).toBe(true);
      expect(typeof appended[key]).not.toBe("function");
      expect(appended[key]).toHaveLength(2);
      expect(appended[key]?.map((item) => item.id)).toEqual([`${key}-1`, `${key}-2`]);
    }
  });

  it("从普通 {} map 开始 appendAnswer 原型键不会污染 Object.prototype 且结果为 null 原型", () => {
    const plain: StepAnswersMap = {};
    const ansConstructor = answer({ id: "c1", stepId: "constructor", question: "构造函数" });
    const ansProto = answer({ id: "p1", stepId: "__proto__", question: "原型" });

    // 从普通 {} 开始追加 constructor
    const afterConstructor = appendAnswer(plain, ansConstructor);
    expect(Object.getPrototypeOf(afterConstructor)).toBeNull();
    expect(Object.hasOwn(afterConstructor, "constructor")).toBe(true);
    expect(Array.isArray(afterConstructor["constructor"])).toBe(true);
    expect(typeof afterConstructor["constructor"]).not.toBe("function");
    expect(afterConstructor["constructor"]).toEqual([ansConstructor]);

    // 继续追加 __proto__
    const afterProto = appendAnswer(afterConstructor, ansProto);
    expect(Object.getPrototypeOf(afterProto)).toBeNull();
    expect(Object.hasOwn(afterProto, "__proto__")).toBe(true);
    expect(Array.isArray(afterProto["__proto__"])).toBe(true);
    expect(typeof afterProto["__proto__"]).not.toBe("function");
    expect(afterProto["__proto__"]).toEqual([ansProto]);

    // 追加同 key 的第二个答案，验证读取旧值正常（不会取到 Object.prototype 原型属性）
    const ansConstructor2 = answer({ id: "c2", stepId: "constructor", createdAt: "2026-10-13T09:00:00.000Z" });
    const ansProto2 = answer({ id: "p2", stepId: "__proto__", createdAt: "2026-10-13T09:00:00.000Z" });
    const afterSecond = appendAnswer(appendAnswer(afterProto, ansConstructor2), ansProto2);
    expect(afterSecond["constructor"]?.map((item) => item.id)).toEqual(["c1", "c2"]);
    expect(afterSecond["__proto__"]?.map((item) => item.id)).toEqual(["p1", "p2"]);

    // 从普通 {} 直接追加 __proto__ 亦为 null 原型且正常存储
    const directProto = appendAnswer({}, ansProto);
    expect(Object.getPrototypeOf(directProto)).toBeNull();
    expect(Object.hasOwn(directProto, "__proto__")).toBe(true);
    expect(Array.isArray(directProto["__proto__"])).toBe(true);
    expect(typeof directProto["__proto__"]).not.toBe("function");

    // 验证 Object.prototype 未被污染
    const dummy: Record<string, unknown> = {};
    expect(dummy.constructor).toBe(Object);
    expect(Object.getPrototypeOf(dummy)).toBe(Object.prototype);
    expect(Object.hasOwn(Object.prototype, "question")).toBe(false);
    expect(Object.hasOwn(Object.prototype, "stepId")).toBe(false);
    expect(Object.hasOwn(Object.prototype, "id")).toBe(false);
    expect(dummy["c1"]).toBeUndefined();
    expect(dummy["p1"]).toBeUndefined();
    expect(Array.isArray(dummy["constructor"])).toBe(false);
    expect(Array.isArray(dummy["__proto__"])).toBe(false);
  });
});
