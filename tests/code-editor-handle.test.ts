// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { getCodeEditorHandle, resetCodeEditorRegistry } from "@/lib/ask/code-editor-registry";

let mockEditorInstance: {
  getVisibleRanges: ReturnType<typeof vi.fn>;
  getModel: ReturnType<typeof vi.fn>;
  [key: string]: unknown;
};

vi.mock("monaco-editor", () => {
  return {
    Range: class {
      constructor(
        public startLineNumber: number,
        public startColumn: number,
        public endLineNumber: number,
        public endColumn: number,
      ) {}
    },
    languages: {},
    editor: {
      defineTheme: vi.fn(),
      setModelLanguage: vi.fn(),
      ScrollType: { Smooth: 1 },
      EditorOption: { lineHeight: 1 },
      create: (container: HTMLElement, options: { value: string }) => {
        let value = options.value;
        const lines = () => value.split("\n");
        mockEditorInstance = {
          createDecorationsCollection: () => ({ clear: vi.fn(), set: vi.fn() }),
          getValue: () => value,
          setValue: (next: string) => {
            value = next;
          },
          getModel: vi.fn(() => ({
            getLineCount: () => lines().length,
            getLineContent: (line: number) => lines()[line - 1] ?? "",
            getValue: () => value,
          })),
          getDomNode: () => container,
          getLayoutInfo: vi.fn(() => ({ contentLeft: 30 })),
          getScrollTop: vi.fn(() => 0),
          getTopForLineNumber: vi.fn((n: number) => (n - 1) * 20),
          getOption: vi.fn(() => 20),
          getVisibleRanges: vi.fn(() => [
            { startLineNumber: 1, endLineNumber: 10 },
          ]),
          updateOptions: vi.fn(),
          onDidChangeModelContent: vi.fn(),
          onDidScrollChange: vi.fn(),
          revealLineInCenter: vi.fn(),
          dispose: vi.fn(),
        };
        return mockEditorInstance;
      },
    },
  };
});

import CodeEditor from "@/components/board/code-editor";

describe("CodeEditor handle & ask integration", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    resetCodeEditorRegistry();
    container.remove();
    vi.unstubAllGlobals();
  });

  test("wrapper div has data-ask-target and data-ask-id defaulting to code:main", async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(CodeEditor, { value: "const a = 1;" }));
    });

    const wrapper = container.querySelector("[data-ask-target]");
    expect(wrapper).not.toBeNull();
    expect(wrapper?.getAttribute("data-ask-target")).toBe("code");
    expect(wrapper?.getAttribute("data-ask-id")).toBe("code:main");

    await act(async () => root.unmount());
  });

  test("wrapper div uses askRef prop when provided", async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(CodeEditor, { value: "const a = 1;", askRef: "custom-ref" }));
    });

    const wrapper = container.querySelector("[data-ask-target]");
    expect(wrapper?.getAttribute("data-ask-id")).toBe("code:custom-ref");

    await act(async () => root.unmount());
  });

  test("registers handle on mount and unregisters on unmount", async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(CodeEditor, {
          value: "line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8\nline 9\nline 10",
        }),
      );
    });

    const wrapper = container.querySelector<HTMLElement>("[data-ask-target]");
    expect(wrapper).not.toBeNull();
    const handle = getCodeEditorHandle(wrapper!);
    expect(handle).toBeDefined();

    // Test getLineRangeForClientBox with hits
    const range = handle!.getLineRangeForClientBox(50, 100);
    expect(range).toEqual({ startLine: 3, endLine: 5 });

    // Test getLinesText
    const linesText = handle!.getLinesText(3, 5);
    expect(linesText).toBe("line 3\nline 4\nline 5");

    // Test getFullText
    expect(handle!.getFullText()).toContain("line 1\nline 2");

    // Test coordinates clamping to visible ranges
    const clampedRange = handle!.getLineRangeForClientBox(0, 999);
    expect(clampedRange).toEqual({ startLine: 1, endLine: 10 });

    // Unmount
    await act(async () => root.unmount());
    expect(getCodeEditorHandle(wrapper!)).toBeUndefined();
  });

  test("getLineRangeForClientBox returns null when no model or no visible ranges", async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(CodeEditor, { value: "const x = 1;" }));
    });

    const wrapper = container.querySelector<HTMLElement>("[data-ask-target]");
    const handle = getCodeEditorHandle(wrapper!);

    mockEditorInstance.getVisibleRanges.mockReturnValueOnce([]);
    expect(handle!.getLineRangeForClientBox(50, 100)).toBeNull();

    mockEditorInstance.getModel.mockReturnValueOnce(null);
    expect(handle!.getLineRangeForClientBox(50, 100)).toBeNull();

    await act(async () => root.unmount());
  });
});
