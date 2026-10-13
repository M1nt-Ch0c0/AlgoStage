import { describe, expect, it } from "vitest";
import { scriptVersion } from "@/lib/ask/script-version";
import { validateScript } from "@/lib/teaching/validated-script";

const meta = {
  problemSlug: "two-sum",
  mode: "lecture" as const,
  language: "zh" as const,
  solutionLanguage: "typescript" as const,
};

function raw(narration: string, start = 1) {
  return {
    ...meta,
    steps: [
      {
        id: "s1",
        narration,
        targets: [{ kind: "code-line", start, end: start }],
        effects: [],
      },
    ],
  };
}

describe("scriptVersion", () => {
  it("11. 同一份教案两次相同；改 narration 后不同；40 位小写 hex", () => {
    const first = validateScript(raw("先看这一行"), "a\nb");
    const second = validateScript(raw("先看这一行"), "a\nb");
    const changed = validateScript(raw("改掉旁白"), "a\nb");

    expect(scriptVersion(first)).toBe(scriptVersion(second));
    expect(scriptVersion(first)).not.toBe(scriptVersion(changed));
    expect(scriptVersion(first)).toMatch(/^[0-9a-f]{40}$/);
    expect(scriptVersion(changed)).toMatch(/^[0-9a-f]{40}$/);
  });

  it("12. version 基于 clamp 后的教案：参考代码行数变了，clamp 结果变，version 也变", () => {
    const longCode = ["a", "b", "c", "d", "e"].join("\n");
    const shortCode = "a";
    const unclamped = validateScript(raw("同一句旁白", 4), longCode);
    const clamped = validateScript(raw("同一句旁白", 4), shortCode);

    expect(unclamped.steps[0]?.targets[0]).toEqual({ kind: "code-line", start: 4, end: 4 });
    expect(clamped.steps[0]?.targets[0]).toEqual({ kind: "code-line", start: 1, end: 1 });
    expect(scriptVersion(unclamped)).not.toBe(scriptVersion(clamped));
    // Replaying the same clamped script keeps the version.
    expect(scriptVersion(validateScript(raw("同一句旁白", 4), shortCode))).toBe(scriptVersion(clamped));
  });
});
