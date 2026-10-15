import { describe, expect, it } from "vitest";
import { computeLineRange, type CodeLineRangeEditor } from "@/lib/ask/code-line-range";

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
    getLayoutInfo: () => ({}),
    ...overrides,
  };
}

describe("computeLineRange / getLineRangeForClientBox", () => {
  it("computes exact line range: top=125, bottom=175 -> lines 2..4", () => {
    const editor = createMockEditor();
    const range = computeLineRange(editor, 125, 175);
    // clientTop=125 -> y'=25 in [20, 40) -> line 2
    // clientBottom=175 -> y'=(175-1)-100=74 in [60, 80) -> line 4
    expect(range).toEqual({ startLine: 2, endLine: 4 });
  });

  it("computes exact line range: top=125, bottom=155 -> lines 2..3", () => {
    const editor = createMockEditor();
    const range = computeLineRange(editor, 125, 155);
    // clientTop=125 -> y'=25 in [20, 40) -> line 2
    // clientBottom=155 -> y'=(155-1)-100=54 in [40, 60) -> line 3
    expect(range).toEqual({ startLine: 2, endLine: 3 });
  });

  it("handles line boundary correctly: bottom ending exactly on line boundary doesn't include next line", () => {
    const editor = createMockEditor();
    // Line 1 is [0, 20), Line 2 is [20, 40)
    // clientTop=100 -> y'=0 (line 1)
    // clientBottom=120 -> y'=119-100=19 (line 1, not line 2)
    const range = computeLineRange(editor, 100, 120);
    expect(range).toEqual({ startLine: 1, endLine: 1 });

    // clientBottom=121 -> y'=120-100=20 (line 2)
    const range2 = computeLineRange(editor, 100, 121);
    expect(range2).toEqual({ startLine: 1, endLine: 2 });
  });

  it("computes scrolled case: getScrollTop=60, visible 4..13, lineCount=20", () => {
    const editor = createMockEditor({
      getScrollTop: () => 60,
      getVisibleRanges: () => [{ startLineNumber: 4, endLineNumber: 13 }],
      getModel: () => ({ getLineCount: () => 20 }),
    });
    // clientTop=125 -> y'=125 - 100 + 60 = 85 in [80, 100) -> line 5
    // clientBottom=175 -> y'=174 - 100 + 60 = 134 in [120, 140) -> line 7
    const range = computeLineRange(editor, 125, 175);
    expect(range).toEqual({ startLine: 5, endLine: 7 });
  });

  it("clamps to visible lines and model lineCount when partly outside", () => {
    const editor = createMockEditor({
      getScrollTop: () => 60,
      getVisibleRanges: () => [{ startLineNumber: 4, endLineNumber: 13 }],
      getModel: () => ({ getLineCount: () => 20 }),
    });
    // Visible lines 4..13 span y' in [60, 260)
    // Box with top=50 (y' = 50 - 100 + 60 = 10 < 60) and bottom=175 (y' = 134 -> line 7)
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
    // Visible lines 4..13 span y' in [60, 260)
    // Completely above: top=0, bottom=50 -> yBottom = 49 - 100 + 60 = 9 < 60
    expect(computeLineRange(editor, 0, 50)).toBeNull();

    // Completely below: top=350, bottom=400 -> yTop = 350 - 100 + 60 = 310 >= 260
    expect(computeLineRange(editor, 350, 400)).toBeNull();
  });

  it("returns null when APIs are missing or return invalid data", () => {
    // null editor
    expect(computeLineRange(null, 125, 175)).toBeNull();

    // NaN inputs
    const validEditor = createMockEditor();
    expect(computeLineRange(validEditor, Number.NaN, 175)).toBeNull();
    expect(computeLineRange(validEditor, 125, Number.NaN)).toBeNull();

    // missing domNode
    expect(computeLineRange(createMockEditor({ getDomNode: () => null }), 125, 175)).toBeNull();

    // missing model
    expect(computeLineRange(createMockEditor({ getModel: () => null }), 125, 175)).toBeNull();

    // lineCount <= 0
    expect(computeLineRange(createMockEditor({ getModel: () => ({ getLineCount: () => 0 }) }), 125, 175)).toBeNull();

    // missing visibleRanges
    expect(computeLineRange(createMockEditor({ getVisibleRanges: () => null }), 125, 175)).toBeNull();
    expect(computeLineRange(createMockEditor({ getVisibleRanges: () => [] }), 125, 175)).toBeNull();

    // missing getScrollTop
    expect(computeLineRange(createMockEditor({ getScrollTop: undefined }), 125, 175)).toBeNull();

    // missing getTopForLineNumber
    expect(computeLineRange(createMockEditor({ getTopForLineNumber: undefined }), 125, 175)).toBeNull();
  });

  it("determines lineHeight via getOption or getTopForLineNumber difference", () => {
    // Via getOption
    const editorWithOption: CodeLineRangeEditor = {
      getDomNode: () => ({ getBoundingClientRect: () => ({ top: 100, bottom: 300 }) }),
      getScrollTop: () => 0,
      getTopForLineNumber: (n: number) => (n - 1) * 20,
      getOption: () => 20,
      getVisibleRanges: () => [{ startLineNumber: 1, endLineNumber: 10 }],
      getModel: () => ({ getLineCount: () => 10 }),
    };
    expect(computeLineRange(editorWithOption, 125, 175)).toEqual({ startLine: 2, endLine: 4 });

    // Via getTopForLineNumber difference
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
