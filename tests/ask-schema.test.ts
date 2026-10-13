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
import type { AnswerSegment, AskEvent, AskStart, StepAnswer } from "@/lib/ask/types";
import type { z } from "zod";
import {
  ASK_BODY_MAX_BYTES,
  ASK_SELECTION_SUMMARY_MAX_BYTES,
  askImageSchema,
  askRequestSchema,
  badRequest,
  lectureRequestSchema,
  selectionSummaryWithinLimit,
  type AskRequest,
} from "@/lib/agent/request";
import { CAPTURE_DEFAULTS, decodedBase64Bytes } from "@/lib/ask/capture";
import { summarizeSelection } from "@/lib/ask/answers";

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

const HEX40 = "a".repeat(40);

function askBody(overrides: Record<string, unknown> = {}) {
  const question = "为什么这样写？";
  return {
    problemSlug: "two-sum",
    cacheKey: HEX40,
    scriptVersion: "b".repeat(40),
    stepId: "s3",
    question,
    selection: {
      stepId: "s3",
      mode: "single",
      bbox: { x: 0, y: 0, width: 44, height: 44 },
      targets: [{ kind: "subtitle", id: "subtitle-s3", stepId: "s3", text: "当前字幕" }],
      question,
    },
    ...overrides,
  };
}

function bytesOf(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

describe("ask request schema（§9 #1–#7）", () => {
  it("1. 合法最小请求、不带 image、image=null 均通过；byok 与 lecture 同一引用", () => {
    const minimal = askRequestSchema.parse(askBody());
    expect(minimal.image).toBeUndefined();
    expect(askRequestSchema.parse(askBody({ image: null })).image).toBeNull();
    expect(askRequestSchema.parse(askBody({ image: undefined })).image).toBeUndefined();
    expect("image" in askRequestSchema.parse(askBody())).toBe(false);

    expect(askRequestSchema.shape.byok).toBe(lectureRequestSchema.shape.byok);
    const parsed = askRequestSchema.parse(askBody({
      byok: { provider: "openai-compatible", model: "gpt-4o", apiKey: "sk-test", baseURL: "https://example.com/v1" },
    }));
    expect(parsed.byok).toEqual({
      provider: "openai-compatible",
      model: "gpt-4o",
      apiKey: "sk-test",
      baseURL: "https://example.com/v1",
    });

    expectTypeOf<AskRequest["byok"]>().toEqualTypeOf<z.infer<typeof lectureRequestSchema>["byok"]>();
    expectTypeOf<StepAnswer["segments"][number]>().toEqualTypeOf<AnswerSegment>();
    const start: AskStart = { answerId: "id", stepId: "s3", imageUsed: false };
    const event: AskEvent = { type: "start", ...start };
    expect(event.type).toBe("start");
    expect(ASK_BODY_MAX_BYTES).toBe(768 * 1024);
  });

  it("2. cacheKey/scriptVersion 恰 40 位小写 hex；空 problemSlug/stepId 拒绝", () => {
    expect(askRequestSchema.safeParse(askBody()).success).toBe(true);
    expect(askRequestSchema.safeParse(askBody({ cacheKey: "a".repeat(39) })).success).toBe(false);
    expect(askRequestSchema.safeParse(askBody({ cacheKey: "a".repeat(41) })).success).toBe(false);
    expect(askRequestSchema.safeParse(askBody({ cacheKey: "g".repeat(40) })).success).toBe(false);
    expect(askRequestSchema.safeParse(askBody({ cacheKey: "A".repeat(40) })).success).toBe(false);
    expect(askRequestSchema.safeParse(askBody({ scriptVersion: "b".repeat(39) })).success).toBe(false);
    expect(askRequestSchema.safeParse(askBody({ scriptVersion: "b".repeat(41) })).success).toBe(false);
    expect(askRequestSchema.safeParse(askBody({ scriptVersion: "B".repeat(40) })).success).toBe(false);
    expect(askRequestSchema.safeParse(askBody({ scriptVersion: "z".repeat(40) })).success).toBe(false);
    expect(askRequestSchema.safeParse(askBody({ problemSlug: "" })).success).toBe(false);
    expect(askRequestSchema.safeParse(askBody({ problemSlug: "   " })).success).toBe(false);
    expect(askRequestSchema.parse(askBody({ problemSlug: "  two-sum  " })).problemSlug).toBe("two-sum");
    expect(askRequestSchema.safeParse(askBody({ stepId: "" })).success).toBe(false);
    const spaced = askRequestSchema.parse(askBody({
      stepId: " s3 ",
      selection: {
        ...askBody().selection,
        stepId: " s3 ",
        targets: [{ kind: "subtitle", id: "subtitle-s3", stepId: " s3 ", text: "当前字幕" }],
      },
    }));
    expect(spaced.stepId).toBe(" s3 ");
    expect(spaced.stepId).not.toBe("s3");
  });

  it("3. question 空白拒绝；trim 后 300 通过、301 拒绝；两边一致才通过", () => {
    expect(askRequestSchema.safeParse(askBody({ question: "" })).success).toBe(false);
    expect(askRequestSchema.safeParse(askBody({ question: "   " })).success).toBe(false);
    const q300 = "问".repeat(300);
    const long = askRequestSchema.parse(askBody({
      question: `  ${q300}  `,
      selection: { ...askBody().selection, question: `  ${q300}  ` },
    }));
    expect(long.question).toBe(q300);
    expect(long.selection.question).toBe(q300);
    const q301 = "问".repeat(301);
    expect(askRequestSchema.safeParse(askBody({
      question: q301,
      selection: { ...askBody().selection, question: q301 },
    })).success).toBe(false);
    expect(askRequestSchema.safeParse(askBody({
      question: "为什么？",
      selection: { ...askBody().selection, question: "另一问" },
    })).success).toBe(false);
    const mismatch = askRequestSchema.safeParse(askBody({
      question: "  为什么？  ",
      selection: { ...askBody().selection, question: "为什么" },
    }));
    expect(mismatch.success).toBe(false);
    if (!mismatch.success) {
      expect(mismatch.error.issues.some(issue => issue.path.join(".") === "selection.question")).toBe(true);
    }
  });

  it("4. stepId 不一致、target 跨步拒绝；未带 target.stepId 通过，text 不改归属", () => {
    const stepMismatch = askRequestSchema.safeParse(askBody({
      selection: { ...askBody().selection, stepId: "other" },
    }));
    expect(stepMismatch.success).toBe(false);
    if (!stepMismatch.success) {
      expect(stepMismatch.error.issues.some(issue => issue.message === "stepId mismatch")).toBe(true);
    }

    const cross = askRequestSchema.safeParse(askBody({
      selection: {
        ...askBody().selection,
        targets: [{ kind: "code", id: "line-1", stepId: "s9", text: "改写教案" }],
      },
    }));
    expect(cross.success).toBe(false);
    if (!cross.success) {
      expect(cross.error.issues.some(issue => issue.path.join(".") === "selection.targets.0.stepId")).toBe(true);
    }

    const noTargetStep = askRequestSchema.parse(askBody({
      selection: {
        ...askBody().selection,
        targets: [{ kind: "subtitle", id: "subtitle-s3", text: "任意文字不能改归属" }],
      },
    }));
    expect(noTargetStep.stepId).toBe("s3");
    expect(noTargetStep.selection.targets[0]?.stepId).toBeUndefined();

    const same = askRequestSchema.parse(askBody({
      selection: {
        ...askBody().selection,
        targets: [
          { kind: "code", id: "line-1", stepId: "s3" },
          { kind: "viz", id: "node", text: "图" },
        ],
      },
    }));
    expect(same.selection.targets).toHaveLength(2);
  });

  it("5. targets 1/20 通过、0/21 拒绝；text、bbox、codeRange 与 16 KiB 摘要边界", () => {
    const one = askRequestSchema.parse(askBody());
    expect(one.selection.targets).toHaveLength(1);
    const twenty = askRequestSchema.parse(askBody({
      selection: {
        ...askBody().selection,
        targets: Array.from({ length: 20 }, (_, i) => ({ kind: "handout", id: `t${i}`, text: "字".repeat(200) })),
      },
    }));
    expect(twenty.selection.targets).toHaveLength(20);

    expect(askRequestSchema.safeParse(askBody({
      selection: { ...askBody().selection, targets: [] },
    })).success).toBe(false);
    expect(askRequestSchema.safeParse(askBody({
      selection: {
        ...askBody().selection,
        targets: Array.from({ length: 21 }, (_, i) => ({ kind: "code", id: `t${i}` })),
      },
    })).success).toBe(false);

    expect(askRequestSchema.safeParse(askBody({
      selection: {
        ...askBody().selection,
        targets: [{ kind: "subtitle", id: "s", text: "字".repeat(200) }],
      },
    })).success).toBe(true);
    expect(askRequestSchema.safeParse(askBody({
      selection: {
        ...askBody().selection,
        targets: [{ kind: "subtitle", id: "s", text: "字".repeat(201) }],
      },
    })).success).toBe(false);

    for (const bbox of [
      { x: Number.NaN, y: 0, width: 1, height: 1 },
      { x: 0, y: Number.POSITIVE_INFINITY, width: 1, height: 1 },
      { x: 0, y: 0, width: -1, height: 1 },
      { x: 0, y: 0, width: 1, height: -1 },
    ]) {
      expect(askRequestSchema.safeParse(askBody({
        selection: { ...askBody().selection, bbox },
      })).success).toBe(false);
    }
    expect(askRequestSchema.safeParse(askBody({
      selection: {
        ...askBody().selection,
        targets: [{ kind: "code", id: "bad", codeRange: { startLine: 5, endLine: 4 } }],
      },
    })).success).toBe(false);
    expect(askRequestSchema.safeParse(askBody({
      selection: {
        ...askBody().selection,
        targets: [{ kind: "code", id: "ok", codeRange: { startLine: 4, endLine: 4 } }],
      },
    })).success).toBe(true);

    const hugeId = "n".repeat(20_000);
    const huge = askBody({
      selection: {
        ...askBody().selection,
        targets: [{ kind: "viz", id: hugeId, vizHit: { structure: "array", nodeIds: [hugeId] } }],
      },
    });
    const summaryBytes = bytesOf(summarizeSelection(huge.selection as never));
    expect(summaryBytes).toBeGreaterThan(ASK_SELECTION_SUMMARY_MAX_BYTES);
    expect(bytesOf(huge)).toBeLessThan(ASK_BODY_MAX_BYTES);
    const hugeResult = askRequestSchema.safeParse(huge);
    expect(hugeResult.success).toBe(false);
    if (!hugeResult.success) {
      expect(hugeResult.error.issues.some(issue => issue.message === "selection summary too large")).toBe(true);
    }
    expect(selectionSummaryWithinLimit(huge.selection as never)).toBe(false);
    expect(selectionSummaryWithinLimit(askBody().selection as never)).toBe(true);

    const exactish = "m".repeat(ASK_SELECTION_SUMMARY_MAX_BYTES);
    const near = {
      stepId: "s3",
      mode: "single" as const,
      bbox: { x: 0, y: 0, width: 1, height: 1 },
      targets: [{ kind: "viz" as const, id: exactish }],
      question: "为什么这样写？",
    };
    expect(selectionSummaryWithinLimit(near)).toBe(false);
  });

  it("6. webp/jpeg 通过，png 拒绝；0/1/2 padding 与 decoded 字节一致", () => {
    const samples = [
      Buffer.from([0xff]),
      Buffer.from([0x09, 0x09]),
      Buffer.from([0x09, 0x09, 0x09]),
      Buffer.alloc(0),
    ];
    expect(samples[3]?.toString("base64")).toBe("");
    for (const mime of ["image/webp", "image/jpeg"] as const) {
      for (const buf of samples.slice(0, 3)) {
        const dataBase64 = buf.toString("base64");
        const parsed = askImageSchema.parse({ mime, dataBase64 });
        expect(parsed.dataBase64).toBe(dataBase64);
        expect(Buffer.from(dataBase64, "base64").length).toBe(decodedBase64Bytes(dataBase64));
        expect(Buffer.from(dataBase64, "base64").length).toBe(buf.length);
      }
    }
    expect(askImageSchema.safeParse({ mime: "image/png", dataBase64: Buffer.from([1]).toString("base64") }).success).toBe(false);
    expect(askRequestSchema.safeParse(askBody({
      image: { mime: "image/png", dataBase64: "QQ==" },
    })).success).toBe(false);
  });

  it("7. decoded 恰 409600 通过、409601 拒绝；字符未到上限仍可能超 decoded；拒绝非规范编码", () => {
    const exact = Buffer.alloc(CAPTURE_DEFAULTS.maxBytes, 7);
    const over = Buffer.alloc(CAPTURE_DEFAULTS.maxBytes + 1, 7);
    const exactB64 = exact.toString("base64");
    const overB64 = over.toString("base64");
    const charCap = 4 * Math.ceil(CAPTURE_DEFAULTS.maxBytes / 3);
    expect(exactB64.length).toBe(charCap);
    expect(overB64.length).toBe(charCap);
    expect(overB64.length).toBeLessThanOrEqual(charCap);
    expect(decodedBase64Bytes(exactB64)).toBe(CAPTURE_DEFAULTS.maxBytes);
    expect(decodedBase64Bytes(overB64)).toBe(CAPTURE_DEFAULTS.maxBytes + 1);
    expect(Buffer.from(exactB64, "base64").length).toBe(decodedBase64Bytes(exactB64));
    expect(Buffer.from(overB64, "base64").length).toBe(decodedBase64Bytes(overB64));

    expect(askImageSchema.safeParse({ mime: "image/webp", dataBase64: exactB64 }).success).toBe(true);
    const overResult = askRequestSchema.safeParse(askBody({
      image: { mime: "image/jpeg", dataBase64: overB64 },
    }));
    expect(overResult.success).toBe(false);

    const rejects = [
      "",
      "data:image/webp;base64,QQ==",
      " QQ==",
      "QQ==\n",
      "-w==",
      "_w==",
      "QQ=",
      "QQ",
      "Q===",
      "QR==",
    ];
    for (const dataBase64 of rejects) {
      expect(askImageSchema.safeParse({ mime: "image/webp", dataBase64 }).success).toBe(false);
    }
    expect(Buffer.from("QR==", "base64").toString("base64")).not.toBe("QR==");

    const stripped = askRequestSchema.parse(askBody({ extra: "nope", image: { mime: "image/jpeg", dataBase64: "QQ==", extra: 1 } }));
    expect(stripped).not.toHaveProperty("extra");
    expect(stripped.image).toEqual({ mime: "image/jpeg", dataBase64: "QQ==" });

    const baseURL = askRequestSchema.safeParse(askBody({ byok: { baseURL: "not a url" } }));
    expect(baseURL.success).toBe(false);
    if (!baseURL.success) {
      const response = badRequest(baseURL.error, "提问参数不正确，请检查问题和选区。");
      expect(response.status).toBe(400);
      return response.json().then(body => {
        expect(body).toMatchObject({ code: "BASE_URL_INVALID", error: "BASE_URL_INVALID" });
      });
    }
  });
});
