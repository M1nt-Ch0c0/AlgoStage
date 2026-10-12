// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { usePlayerStore } from "../lib/player/store";

const loading = vi.hoisted(() => {
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  return { ready, release, edit: (_value: string) => {} };
});
vi.mock("monaco-editor", async () => {
  await loading.ready;
  return {
    Range: class {
      constructor(public startLineNumber: number, public startColumn: number, public endLineNumber: number, public endColumn: number) {}
    },
    languages: {},
    editor: {
      defineTheme: () => {}, setModelLanguage: () => {}, ScrollType: { Smooth: 1 }, EditorOption: { lineHeight: 1 },
      create: (container: HTMLElement, options: { value: string }) => {
        let value = options.value;
        let onContentChange: ((event: { isFlush: boolean }) => void) | undefined;
        loading.edit = next => { value = next; onContentChange?.({ isFlush: false }); };
        const clear = () => container.replaceChildren();
        const collection = {
          clear,
          set: (decorations: { range: { startLineNumber: number }; options: { className: string } }[]) => {
            clear();
            for (const decoration of decorations) {
              const line = document.createElement("div");
              line.className = decoration.options.className;
              line.dataset.line = String(decoration.range.startLineNumber);
              container.append(line);
            }
          },
        };
        return {
          createDecorationsCollection: () => collection,
          getValue: () => value,
          setValue: (next: string) => { value = next; clear(); onContentChange?.({ isFlush: true }); },
          getModel: () => ({ getLineCount: () => value.split("\n").length }),
          getDomNode: () => container,
          updateOptions: () => {}, onDidChangeModelContent: (callback: typeof onContentChange) => { onContentChange = callback; }, onDidScrollChange: () => {},
          revealLineInCenter: () => {}, dispose: clear,
        };
      },
    },
  };
});
import CodeEditor from "../components/board/code-editor";

test("finished 回看排序步仍有 Monaco 装饰；异步加载和恢复代码后也保留高亮", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const code = "function threeSum(nums) {\n const res = [];\n // 排序\n nums.sort((a, b) => a - b);\n return res;\n}";
  usePlayerStore.setState({ status: "finished", currentIndex: 1, steps: [
    { id: "s1", narration: "题意", targets: [{ kind: "statement", blockId: "intro" }], effects: [] },
    { id: "s2", narration: "先排序", targets: [{ kind: "code-line", start: 4 }], effects: [] },
  ] });
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  const changed = vi.fn();
  try {
    await act(async () => root.render(createElement(CodeEditor, { value: code, readOnly: false, onChange: changed })));
    expect(container.querySelector(".beam-line")).toBeNull();
    await act(async () => { loading.release(); await new Promise(resolve => setTimeout(resolve, 30)); });
    expect(container.querySelector(".beam-line")?.getAttribute("data-line")).toBe("4");
    await act(async () => root.render(createElement(CodeEditor, { value: code + "\n", readOnly: false, onChange: changed })));
    expect(container.querySelector(".beam-line")?.getAttribute("data-line")).toBe("4");
    expect(changed).not.toHaveBeenCalled(); // setValue 恢复全文不能冒充学生输入。
    await act(async () => loading.edit("// 学生草稿"));
    expect(changed).toHaveBeenCalledExactlyOnceWith("// 学生草稿");
    await act(async () => usePlayerStore.getState().reset());
    expect(container.querySelector(".beam-line")).toBeNull();
  } finally {
    await act(async () => root.unmount()); container.remove();
    usePlayerStore.getState().reset(); vi.unstubAllGlobals();
  }
});
