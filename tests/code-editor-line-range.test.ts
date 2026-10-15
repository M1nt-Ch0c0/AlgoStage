import { describe, expect, it } from "vitest";
import {
  computeLineRange,
  formatCodeRangeLabel,
  type CodeLineRangeEditor,
} from "@/lib/ask/code-line-range";
import { summarizeSelection } from "@/lib/ask/collect-candidates";
import { buildAskPrompt } from "@/lib/agent/modes/ask";
import { TWO_SUM_SCRIPT } from "@/lib/content/scripts/two-sum";
import type { TeachingStep } from "@/lib/teaching/types";

function createMockEditor(overrides?: Partial<CodeLineRangeEditor>): CodeLineRangeEditor {
  return {
    getDomNode: () => ({
      getBoundingClientRect: () => ({
        top: 100,
        bottom: 300,
        left: 0,
        right: 200,
        width: 200,
        height: 200,
      }),
    }),
    getScrollTop: () => 0,
    getTopForLineNumber: (n: number) => (n - 1) * 20,
    lineHeight: 20,
    getVisibleRanges: () => [{ startLineNumber: 1, endLineNumber: 10 }],
    getModel: () => ({ getLineCount: () => 10 }),
    getLayoutInfo: () => ({ contentTop: 0 }),
    ...overrides,
  };
}

describe("computeLineRange / getLineRangeForClientBox", () => {
  it("box exactly on line boundaries: y1 = top of line 8, y2 = bottom of line 9 -> 8–9", () => {
    const editor = createMockEditor();
    // Line 8: [140, 160), Line 9: [160, 180)
    // clientTop = 100 + 140 = 240; clientBottom = 100 + 180 = 280
    const range = computeLineRange(editor, 240, 280);
    expect(range).toEqual({ startLine: 8, endLine: 9 });
  });

  it("box grazing within 2px into neighbour lines above and below is not counted", () => {
    const editor = createMockEditor();
    // Line 8 spans [140, 160), Line 9 spans [160, 180)
    // Neighbor above: line 7 [120, 140). Neighbor below: line 10 [180, 200).
    // Grazing 1px above line 8 (y1 = 139) and 1px below line 9 (y2 = 181):
    const range1 = computeLineRange(editor, 100 + 139, 100 + 181);
    expect(range1).toEqual({ startLine: 8, endLine: 9 });

    // Grazing exactly 2px above line 8 (y1 = 138) and 2px below line 9 (y2 = 182):
    // y1+2 = 140 (line 7 top+lh = 140, not > 140 -> line 7 not counted)
    // y2-2 = 180 (line 10 top = 180, not < 180 -> line 10 not counted)
    const range2 = computeLineRange(editor, 100 + 138, 100 + 182);
    expect(range2).toEqual({ startLine: 8, endLine: 9 });

    // Grazing >2px (3px above and below) intersects neighbor lines:
    const range3 = computeLineRange(editor, 100 + 137, 100 + 183);
    expect(range3).toEqual({ startLine: 7, endLine: 10 });
  });

  it("handles nonzero contentTop correctly", () => {
    const editor = createMockEditor({
      getLayoutInfo: () => ({ contentTop: 15 }),
    });
    // With contentTop = 15, line 8 content Y in [140, 160) corresponds to
    // client Y in [100 + 15 + 140, 100 + 15 + 160) = [255, 275)
    // and line 9 content Y in [160, 180) corresponds to client Y in [275, 295).
    const range = computeLineRange(editor, 255, 295);
    expect(range).toEqual({ startLine: 8, endLine: 9 });
  });

  it("computes scrolled case: getScrollTop=60, visible 4..13, lineCount=20", () => {
    const editor = createMockEditor({
      getScrollTop: () => 60,
      getVisibleRanges: () => [{ startLineNumber: 4, endLineNumber: 13 }],
      getModel: () => ({ getLineCount: () => 20 }),
    });
    // clientTop=125 -> y1 = 125 - 100 + 60 = 85 (y1+2 = 87 -> line 5 top=80, top+lh=100 > 87)
    // clientBottom=175 -> y2 = 175 - 100 + 60 = 135 (y2-2 = 133 -> line 7 top=120 < 133, line 8 top=140 not < 133)
    const range = computeLineRange(editor, 125, 175);
    expect(range).toEqual({ startLine: 5, endLine: 7 });
  });

  it("reproduces the e2e 8–9 shape (start at center of line 8, end at center of line 9 -> 8–9)", () => {
    const lineHeight = 22;
    const contentTop = 12;
    const editorRectTop = 50;
    const editor = createMockEditor({
      getDomNode: () => ({
        getBoundingClientRect: () => ({ top: editorRectTop, bottom: 500, left: 0, right: 300 }),
      }),
      getLayoutInfo: () => ({ contentTop }),
      getScrollTop: () => 0,
      getTopForLineNumber: (n: number) => (n - 1) * lineHeight,
      lineHeight,
      getVisibleRanges: () => [{ startLineNumber: 1, endLineNumber: 15 }],
      getModel: () => ({ getLineCount: () => 15 }),
    });

    // In Monaco, line 8 top = 7 * 22 = 154, center = 154 + 11 = 165
    // Line 9 top = 8 * 22 = 176, center = 176 + 11 = 187
    // Rendered client Y (e2e getMonacoLineY):
    const startClientY = editorRectTop + contentTop + 165; // 227
    const endClientY = editorRectTop + contentTop + 187;   // 249

    const range = computeLineRange(editor, startClientY, endClientY, { lineHeight });
    expect(range).toEqual({ startLine: 8, endLine: 9 });
  });

  it("clamps to visible lines and model lineCount when partly outside", () => {
    const editor = createMockEditor({
      getScrollTop: () => 60,
      getVisibleRanges: () => [{ startLineNumber: 4, endLineNumber: 13 }],
      getModel: () => ({ getLineCount: () => 20 }),
    });
    // Box with top=50 (y1 = 10) and bottom=175 (y2 = 135 -> line 7)
    // Start line clamped to minVisible = 4
    const range = computeLineRange(editor, 50, 175);
    expect(range).toEqual({ startLine: 4, endLine: 7 });
  });

  it("returns null when box is completely outside all visible lines", () => {
    const editor = createMockEditor({
      getScrollTop: () => 60,
      getVisibleRanges: () => [{ startLineNumber: 4, endLineNumber: 13 }],
      getModel: () => ({ getLineCount: () => 20 }),
    });
    expect(computeLineRange(editor, 0, 50)).toBeNull();
    expect(computeLineRange(editor, 350, 400)).toBeNull();
  });

  it("returns null when box height is <= 4px (y2 - 2 <= y1 + 2)", () => {
    const editor = createMockEditor();
    // 4px box: y1=20, y2=24 -> y1+2=22, y2-2=22 (empty test interval)
    expect(computeLineRange(editor, 120, 124)).toBeNull();
    // 0px point click: y1=20, y2=20 -> y1+2=22, y2-2=18
    expect(computeLineRange(editor, 120, 120)).toBeNull();
  });

  it("returns null when APIs are missing or return invalid data", () => {
    expect(computeLineRange(null, 125, 175)).toBeNull();

    const validEditor = createMockEditor();
    expect(computeLineRange(validEditor, Number.NaN, 175)).toBeNull();
    expect(computeLineRange(validEditor, 125, Number.NaN)).toBeNull();

    expect(computeLineRange(createMockEditor({ getDomNode: () => null }), 125, 175)).toBeNull();
    expect(computeLineRange(createMockEditor({ getModel: () => null }), 125, 175)).toBeNull();
    expect(computeLineRange(createMockEditor({ getModel: () => ({ getLineCount: () => 0 }) }), 125, 175)).toBeNull();
    expect(computeLineRange(createMockEditor({ getVisibleRanges: () => null }), 125, 175)).toBeNull();
    expect(computeLineRange(createMockEditor({ getVisibleRanges: () => [] }), 125, 175)).toBeNull();
    expect(computeLineRange(createMockEditor({ getScrollTop: undefined }), 125, 175)).toBeNull();
    expect(computeLineRange(createMockEditor({ getTopForLineNumber: undefined }), 125, 175)).toBeNull();
  });

  it("determines lineHeight via caller option or getTopForLineNumber difference", () => {
    // Via caller options.lineHeight
    const editorWithOption: CodeLineRangeEditor = {
      getDomNode: () => ({ getBoundingClientRect: () => ({ top: 100, bottom: 300 }) }),
      getScrollTop: () => 0,
      getTopForLineNumber: (n: number) => (n - 1) * 20,
      getVisibleRanges: () => [{ startLineNumber: 1, endLineNumber: 10 }],
      getModel: () => ({ getLineCount: () => 10 }),
    };
    expect(computeLineRange(editorWithOption, 125, 175, { lineHeight: 20 })).toEqual({ startLine: 2, endLine: 4 });

    // Via getTopForLineNumber difference fallback
    const editorWithDiff: CodeLineRangeEditor = {
      getDomNode: () => ({ getBoundingClientRect: () => ({ top: 100, bottom: 300 }) }),
      getScrollTop: () => 0,
      getTopForLineNumber: (n: number) => (n - 1) * 20,
      getVisibleRanges: () => [{ startLineNumber: 1, endLineNumber: 10 }],
      getModel: () => ({ getLineCount: () => 10 }),
    };
    expect(computeLineRange(editorWithDiff, 125, 175)).toEqual({ startLine: 2, endLine: 4 });
  });
});

describe("formatCodeRangeLabel and prompt/summary reference", () => {
  it("formats single line as 「代码第 n 行」", () => {
    expect(formatCodeRangeLabel({ startLine: 9, endLine: 9 })).toBe("代码第 9 行");
    expect(formatCodeRangeLabel({ startLine: 1, endLine: 1 })).toBe("代码第 1 行");
  });

  it("formats multi-line as 「代码第 a–b 行」 with en dash and exact spacing", () => {
    const formatted = formatCodeRangeLabel({ startLine: 8, endLine: 9 });
    expect(formatted).toBe("代码第 8–9 行");
    // Verify en dash code point U+2013
    expect(formatted.charCodeAt(5)).toBe(0x2013);

    const formattedMulti = formatCodeRangeLabel({ startLine: 2, endLine: 4 });
    expect(formattedMulti).toBe("代码第 2–4 行");
  });

  it("summarizeSelection uses formatCodeRangeLabel for single-line code selection", () => {
    const summary = summarizeSelection({
      mode: "region",
      bbox: { x: 10, y: 10, width: 100, height: 24 },
      targets: [{ kind: "code", id: "code:main", codeRange: { startLine: 9, endLine: 9 }, text: "line 9" }],
    });
    expect(summary).toBe("已选：代码第 9 行");
  });

  it("summarizeSelection uses formatCodeRangeLabel for multi-line code selection", () => {
    const summary = summarizeSelection({
      mode: "region",
      bbox: { x: 10, y: 10, width: 100, height: 44 },
      targets: [{ kind: "code", id: "code:main", codeRange: { startLine: 8, endLine: 9 }, text: "lines 8-9" }],
    });
    expect(summary).toBe("已选：代码第 8–9 行");
  });

  it("summarizeSelection uses formatCodeRangeLabel in mixed selection", () => {
    const summarySingle = summarizeSelection({
      mode: "region",
      bbox: { x: 10, y: 10, width: 200, height: 100 },
      targets: [
        { kind: "code", id: "code:main", codeRange: { startLine: 9, endLine: 9 }, text: "line 9" },
        { kind: "viz", id: "viz:s1", text: "viz 1" },
      ],
    });
    expect(summarySingle).toBe("已选：代码第 9 行 · 可视化 1 处");

    const summaryMulti = summarizeSelection({
      mode: "region",
      bbox: { x: 10, y: 10, width: 200, height: 100 },
      targets: [
        { kind: "code", id: "code:main", codeRange: { startLine: 8, endLine: 9 }, text: "lines 8-9" },
        { kind: "viz", id: "viz:s1", text: "viz 1" },
      ],
    });
    expect(summaryMulti).toBe("已选：代码第 8–9 行 · 可视化 1 处");
  });

  it("prompt builder preserves target codeRange", () => {
    const step = TWO_SUM_SCRIPT.steps[0] as TeachingStep;
    const prompt = buildAskPrompt({
      script: TWO_SUM_SCRIPT,
      step,
      referenceCode: "function twoSum() {}\n",
      selection: {
        mode: "region",
        bbox: { x: 10, y: 10, width: 100, height: 24 },
        targets: [{ kind: "code", id: "c1", codeRange: { startLine: 9, endLine: 9 }, text: "line 9" }],
      },
      question: "为什么选第9行？",
    });
    const parsed = JSON.parse(prompt.trim().split("\n").at(-1) ?? "");
    expect(parsed.selection.targets[0].codeRange).toEqual({ startLine: 9, endLine: 9 });
  });
});
