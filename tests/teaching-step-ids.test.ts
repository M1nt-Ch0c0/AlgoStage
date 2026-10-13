import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { askableStepIds, disabledStepIds, validateScript } from "@/lib/teaching/validated-script";

const meta = {
  problemSlug: "two-sum",
  mode: "lecture" as const,
  language: "zh" as const,
  solutionLanguage: "typescript" as const,
};

function script(ids: string[]) {
  return {
    ...meta,
    steps: ids.map((id) => ({
      id,
      narration: `步骤 ${id || "empty"}`,
      targets: [{ kind: "code-line", start: 9, end: 1 }],
      effects: [{ effect: "spotlight-beam", targetIndex: 0 }, { effect: "chalk-underline", targetIndex: 4 }],
    })),
  };
}

describe("validateScript step ids", () => {
  it("7. strict：重复或空 id 抛 ZodError，唯一非空 id 通过", () => {
    expect(() => validateScript(script(["a", "b", "a"]), "line1\nline2")).toThrow(ZodError);
    expect(() => validateScript(script(["a", ""]), "line1")).toThrow(ZodError);
    try {
      validateScript(script(["a", "b", "a", ""]), "line1");
    } catch (error) {
      expect(error).toBeInstanceOf(ZodError);
      expect((error as ZodError).issues).toHaveLength(1);
      expect((error as ZodError).issues[0]?.message).toBe('duplicate or empty step id: "a", ""');
    }
    try {
      validateScript(script([""]), "line1");
      expect.unreachable();
    } catch (error) {
      expect((error as ZodError).issues[0]?.message).toBe('duplicate or empty step id: ""');
    }

    const ok = validateScript(script(["a", "b"]), "line1\nline2");
    expect(ok.steps.map((step) => step.id)).toEqual(["a", "b"]);
    // Default is strict, so the same input without an options object also passes.
    expect(validateScript(script(["a", "b"]), "line1").steps).toHaveLength(2);
  });

  it("8. lenient：同样的输入不抛，askableStepIds 只收出现一次的非空 id", () => {
    const duplicated = validateScript(script(["a", "b", "a"]), "line1", { stepIds: "lenient" });
    expect(duplicated.steps.map((step) => step.id)).toEqual(["a", "b", "a"]);
    expect([...askableStepIds(duplicated)]).toEqual(["b"]);
    expect(disabledStepIds(duplicated)).toEqual(["a"]);

    const empty = validateScript(script(["a", ""]), "line1", { stepIds: "lenient" });
    expect([...askableStepIds(empty)]).toEqual(["a"]);
    expect(disabledStepIds(empty)).toEqual([""]);

    const both = validateScript(script(["a", "b", "a", ""]), "x", { stepIds: "lenient" });
    expect([...askableStepIds(both)]).toEqual(["b"]);
    expect(disabledStepIds(both)).toEqual(["a", ""]);

    const unique = validateScript(script(["a", "b"]), "x", { stepIds: "lenient" });
    expect([...askableStepIds(unique)].sort()).toEqual(["a", "b"]);
    expect(disabledStepIds(unique)).toEqual([]);
  });

  it('steps with ids ["a"," ","a","b","",""] -> disabledStepIds equals ["a"," ",""] and askableStepIds equals new Set(["b"])', () => {
    const s = validateScript(script(["a", " ", "a", "b", "", ""]), "x", { stepIds: "lenient" });
    expect(disabledStepIds(s)).toEqual(["a", " ", ""]);
    expect(askableStepIds(s)).toEqual(new Set(["b"]));
  });

  it("clamp 仍按参考代码行数收口，且重复 id 在最终结果上检查", () => {
    const validated = validateScript(script(["a"]), "only-one-line");
    const target = validated.steps[0]?.targets[0];
    expect(target).toEqual({ kind: "code-line", start: 1, end: 1 });
    // targetIndex 4 is past the remaining target, so that effect is dropped.
    expect(validated.steps[0]?.effects).toEqual([{ effect: "spotlight-beam", targetIndex: 0 }]);

    const emptyCode = validateScript(script(["only"]), "");
    expect(emptyCode.steps[0]?.targets[0]).toEqual({ kind: "statement", blockId: "intro" });
  });
});
