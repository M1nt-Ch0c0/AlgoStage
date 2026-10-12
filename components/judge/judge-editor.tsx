"use client";
import { useEffect, useRef } from "react";
import CodeEditor, { type CodeEditorProps } from "@/components/board/code-editor";

/** 仅调整此练习编辑器的 Python 粘贴行为，沿用黑板外观。 */
export default function JudgeEditor(props: CodeEditorProps) {
  const container = useRef<HTMLDivElement>(null);
  const language = props.language ?? "typescript";
  useEffect(() => {
    if (language !== "python") return;
    let disposed = false;
    let subscription: { dispose(): void } | undefined;
    void import("monaco-editor").then(monaco => {
      if (disposed) return;
      const configure = (editor: import("monaco-editor").editor.ICodeEditor) => {
        if (container.current?.contains(editor.getDomNode())) {
          editor.updateOptions({ formatOnPaste: false, autoIndent: "none" });
        }
      };
      subscription = monaco.editor.onDidCreateEditor(configure);
      monaco.editor.getEditors().forEach(configure);
    }).catch(() => { /* CodeEditor 已处理 Monaco 加载失败。 */ });
    return () => { disposed = true; subscription?.dispose(); };
  }, [language]);
  // 切换语言时采用新的编辑器实例，TypeScript 使用原有默认选项。
  return <div ref={container} className="h-full w-full"><CodeEditor key={language} {...props}/></div>;
}
