import { readFileSync } from "node:fs";
import { describe, it, expect, expectTypeOf, vi } from "vitest";
import {
  answerSegmentSchema,
  askBBoxSchema,
  askSelectionSchema,
  askTargetSchema,
  stepAnswerSchema,
  stepAnswersMapSchema,
} from "@/lib/ask/schema";
import { effectCallSchema, effectTargetSchema } from "@/lib/teaching/schema";
import type { AnswerSegment } from "@/lib/ask/types";
import type { z } from "zod";

const bbox = { x: 1, y: 2, width: 30, height: 40 };

function selection(overrides: Record<string, unknown> = {}) {
  return {
    stepId: "s1",
    mode: "single",
    bbox,
    targets: [{ kind: "code", id: "line-4", stepId: "s1", text: "complement", codeRange: { startLine: 4, endLine: 5 } }],
    question: "这里为什么要先算补数？",
    ...overrides,
  };
}

function segment(overrides: Record<string, unknown> = {}) {
  return {
    id: "seg-1",
    narration: "先算出补数，再查哈希表。",
    targets: [{ kind: "code-line", start: 4, end: 5 }],
    effects: [{ effect: "spotlight-beam", color: "gold", intensity: "normal" }],
    viz: { type: "array", state: { values: [2, 7], highlight: [0], map: { "2": 0 }, scan: 0 } },
    ...overrides,
  };
}

function answer(overrides: Record<string, unknown> = {}) {
  return {
    v: 1,
    id: "a1",
    stepId: "s1",
    question: "这里为什么要先算补数？",
    selection: { mode: "single", bbox, targets: [{ kind: "code", id: "line-4" }] },
    segments: [segment()],
    createdAt: "2026-10-13T08:00:00.000Z",
    ...overrides,
  };
}

describe("ask schema", () => {
  it("10. 合法 AskSelection / StepAnswer 通过，非法字段拒绝", () => {
    const parsedSelection = askSelectionSchema.parse(selection({ question: "  补数是什么？  " }));
    expect(parsedSelection.question).toBe("补数是什么？");
    expect(askSelectionSchema.safeParse(selection({ mode: "region", targets: [] })).success).toBe(true);

    const parsedAnswer = stepAnswerSchema.parse(answer({ question: "  为什么？  " }));
    expect(parsedAnswer.question).toBe("为什么？");
    expect(parsedAnswer.v).toBe(1);
    expect(stepAnswerSchema.safeParse(answer({
      createdAt: "2026-10-13T08:00:00+08:00",
      segments: [segment(), segment({ id: "seg-2", narration: "再存进 map。" })],
    })).success).toBe(true);

    expect(askSelectionSchema.safeParse(selection({ question: "   " })).success).toBe(false);
    expect(askSelectionSchema.safeParse(selection({ question: "" })).success).toBe(false);
    expect(askSelectionSchema.safeParse(selection({ question: "问".repeat(301) })).success).toBe(false);
    expect(askSelectionSchema.safeParse(selection({ question: "问".repeat(300) })).success).toBe(true);
    expect(stepAnswerSchema.safeParse(answer({ question: "   " })).success).toBe(false);
    expect(stepAnswerSchema.safeParse(answer({ question: "问".repeat(301) })).success).toBe(false);

    expect(stepAnswerSchema.safeParse(answer({
      segments: [segment({ effects: [{ effect: "not-a-real-effect" }] })],
    })).success).toBe(false);

    expect(askTargetSchema.safeParse({
      kind: "code", id: "bad-range", codeRange: { startLine: 5, endLine: 4 },
    }).success).toBe(false);
    expect(askSelectionSchema.safeParse(selection({
      targets: [{ kind: "code", id: "bad-range", codeRange: { startLine: 8, endLine: 3 } }],
    })).success).toBe(false);
    expect(askTargetSchema.safeParse({
      kind: "code", id: "ok-range", codeRange: { startLine: 4, endLine: 4 },
    }).success).toBe(true);
    expect(askTargetSchema.safeParse({
      kind: "code", id: "zero", codeRange: { startLine: 0, endLine: 2 },
    }).success).toBe(false);

    expect(stepAnswerSchema.safeParse(answer({ segments: [] })).success).toBe(false);
    expect(stepAnswerSchema.safeParse(answer({
      segments: Array.from({ length: 9 }, (_, i) => segment({ id: `seg-${i}` })),
    })).success).toBe(false);
    expect(stepAnswerSchema.safeParse(answer({
      segments: Array.from({ length: 8 }, (_, i) => segment({ id: `seg-${i}`, narration: "好" })),
    })).success).toBe(true);

    expect(answerSegmentSchema.safeParse(segment({ narration: "" })).success).toBe(false);
    expect(answerSegmentSchema.safeParse(segment({ narration: "字".repeat(121) })).success).toBe(false);
    expect(answerSegmentSchema.safeParse(segment({ narration: "字".repeat(120) })).success).toBe(true);
  });

  it("11. map key 与 stepId 不一致被拒", () => {
    const ok = stepAnswersMapSchema.safeParse({
      s1: [answer()],
      s2: [answer({ id: "a2", stepId: "s2" })],
    });
    expect(ok.success).toBe(true);

    const mismatch = stepAnswersMapSchema.safeParse({
      s1: [answer({ stepId: "other" })],
    });
    expect(mismatch.success).toBe(false);

    const mixed = stepAnswersMapSchema.safeParse({
      s1: [answer(), answer({ id: "a2", stepId: "s2" })],
    });
    expect(mixed.success).toBe(false);

    expect(stepAnswersMapSchema.safeParse({}).success).toBe(true);
  });

  it("schema 其余分支：bbox、target、effect、viz、createdAt", () => {
    expect(askBBoxSchema.safeParse(bbox).success).toBe(true);
    expect(askBBoxSchema.safeParse({ ...bbox, width: 0, height: 0 }).success).toBe(true);
    expect(askBBoxSchema.safeParse({ ...bbox, width: -1 }).success).toBe(false);
    expect(askBBoxSchema.safeParse({ ...bbox, height: -0.1 }).success).toBe(false);
    expect(askBBoxSchema.safeParse({ ...bbox, x: Number.NaN }).success).toBe(false);
    expect(askBBoxSchema.safeParse({ ...bbox, y: Number.POSITIVE_INFINITY }).success).toBe(false);
    expect(askBBoxSchema.safeParse({ ...bbox, width: Number.NaN }).success).toBe(false);

    expect(askTargetSchema.safeParse({ kind: "viz", id: "n", text: "字".repeat(200) }).success).toBe(true);
    expect(askTargetSchema.safeParse({ kind: "viz", id: "n", text: "字".repeat(201) }).success).toBe(false);
    expect(askTargetSchema.safeParse({ kind: "nope", id: "n" }).success).toBe(false);
    expect(askTargetSchema.safeParse({
      kind: "viz",
      id: "node",
      vizHit: { structure: "array", nodeIds: ["a0"], indices: [0, 1] },
    }).success).toBe(true);
    expect(askTargetSchema.safeParse({
      kind: "viz", id: "node", vizHit: { structure: "array", indices: [1.5] },
    }).success).toBe(false);

    expect(askSelectionSchema.safeParse(selection({
      targets: Array.from({ length: 21 }, (_, i) => ({ kind: "code", id: `t${i}` })),
    })).success).toBe(false);
    expect(askSelectionSchema.safeParse(selection({
      targets: Array.from({ length: 20 }, (_, i) => ({ kind: "handout", id: `t${i}` })),
    })).success).toBe(true);

    expect(stepAnswerSchema.safeParse(answer({ v: 2 })).success).toBe(false);
    expect(stepAnswerSchema.safeParse(answer({ createdAt: "2026-10-13" })).success).toBe(false);
    expect(stepAnswerSchema.safeParse(answer({ createdAt: "2026-10-13T08:00:00" })).success).toBe(false);
    expect(stepAnswerSchema.safeParse(answer({ createdAt: "not-a-date" })).success).toBe(false);
    expect(stepAnswerSchema.safeParse(answer({
      selection: { mode: "region", bbox, targets: [] },
    })).success).toBe(true);

    const kinds = ["code-line", "code-token", "statement", "viz-node", "dom"] as const;
    expect(answerSegmentSchema.safeParse(segment({
      targets: [
        { kind: "code-line", start: 1 },
        { kind: "code-token", line: 2, match: "map" },
        { kind: "statement", blockId: "intro" },
        { kind: "viz-node", nodeId: "a0" },
        { kind: "dom", selector: "[data-step]" },
      ],
      effects: [{
        effect: "chalk-underline",
        targetIndex: 1,
        color: "violet",
        intensity: "whisper",
        params: { shape: "circle" },
      }],
    })).success).toBe(true);
    expect(kinds).toHaveLength(5);
    expect(answerSegmentSchema.safeParse(segment({
      targets: [{ kind: "code-line", start: 0 }],
    })).success).toBe(false);
    expect(answerSegmentSchema.safeParse(segment({
      targets: [{ kind: "code-token", line: 1 }],
    })).success).toBe(false);
    expect(answerSegmentSchema.safeParse(segment({
      effects: [{ effect: "spotlight-beam", targetIndex: -1 }],
    })).success).toBe(false);
    expect(answerSegmentSchema.safeParse(segment({
      effects: [{ effect: "spotlight-beam", color: "black" }],
    })).success).toBe(false);
    expect(answerSegmentSchema.safeParse(segment({
      effects: [{ effect: "spotlight-beam", intensity: "loud" }],
    })).success).toBe(false);
    expect(answerSegmentSchema.safeParse(segment({
      viz: { type: "array", state: { values: [Number.NaN] } },
    })).success).toBe(true);
    expect(answerSegmentSchema.safeParse({ id: "bare", narration: "只有旁白" }).success).toBe(true);
  });

  it("1. ask schema 不再本地定义 effectTarget / effectCall，与教学 schema 同一引用", async () => {
    const source = readFileSync(new URL("../lib/ask/schema.ts", import.meta.url), "utf8");
    expect(source).not.toContain('z.discriminatedUnion("kind"');
    const teaching = await import("@/lib/teaching/schema");
    expect(effectTargetSchema).toBe(teaching.effectTargetSchema);
    expect(effectCallSchema).toBe(teaching.effectCallSchema);
  });

  it("2. 合法 array viz 保留且原样输出", () => {
    const viz = { type: "array" as const, state: { values: [2, 7], highlight: [0], map: { "2": 0 }, scan: 0 } };
    const parsed = answerSegmentSchema.parse(segment({ viz }));
    expect("viz" in parsed ? parsed.viz : undefined).toEqual(viz);
    expect(Object.prototype.hasOwnProperty.call(parsed, "viz")).toBe(true);
  });

  it("3-5. 非数组或不合法 viz 丢掉键，文字与 targets 保留，整段整条都不失败", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cases = [
      { type: "tree", state: { values: [1] } },
      { type: "array", state: { values: [1], highlight: [5] } },
      "x",
      null,
    ];
    try {
      for (const viz of cases) {
        warn.mockClear();
        const parsed = answerSegmentSchema.parse(segment({ viz }));
        expect(parsed.narration).toBe("先算出补数，再查哈希表。");
        expect(parsed.targets).toEqual([{ kind: "code-line", start: 4, end: 5 }]);
        expect(Object.prototype.hasOwnProperty.call(parsed, "viz")).toBe(false);
        expect("viz" in parsed).toBe(false);
        expect(warn).toHaveBeenCalledWith("[ask] dropped non-array viz");
        expect(warn.mock.calls.every((call) => call.length === 1 && call[0] === "[ask] dropped non-array viz")).toBe(true);

        const whole = stepAnswerSchema.parse(answer({ segments: [segment({ viz })] }));
        expect(whole.segments).toHaveLength(1);
        expect(Object.prototype.hasOwnProperty.call(whole.segments[0], "viz")).toBe(false);
      }
    } finally {
      warn.mockRestore();
    }
  });

  it("缺省 viz 不告警，输出也没有 viz 键", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const full = segment();
      const without = { ...full, viz: undefined };
      delete without.viz;
      const parsed = answerSegmentSchema.parse(without);
      expect(Object.prototype.hasOwnProperty.call(parsed, "viz")).toBe(false);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("6. createdAt 接受 Z 与偏移，拒绝纯日期和普通文字", () => {
    expect(stepAnswerSchema.safeParse(answer({ createdAt: "2026-10-13T11:00:00.000Z" })).success).toBe(true);
    expect(stepAnswerSchema.safeParse(answer({ createdAt: "2026-10-13T19:00:00+08:00" })).success).toBe(true);
    expect(stepAnswerSchema.safeParse(answer({ createdAt: "2026-10-13" })).success).toBe(false);
    expect(stepAnswerSchema.safeParse(answer({ createdAt: "yesterday" })).success).toBe(false);
  });

  it("answerSegmentSchema 输出可赋给 AnswerSegment", () => {
    expectTypeOf<z.output<typeof answerSegmentSchema>>().toMatchTypeOf<AnswerSegment>();
  });
});
