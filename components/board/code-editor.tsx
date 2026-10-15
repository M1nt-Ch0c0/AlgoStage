/**
 * CodeEditor · 黑板（Monaco 封装，docs/02 §4.1 / §5.4）
 *  - 纯本地：直接 import monaco-editor ESM（不走 CDN loader）。
 *  - 挂载时向 lib/anchors 注册 codeLineResolver：行号区间 → viewport rect
 *    （内部滚动时派发 'algostage:anchor-refresh' 让特效层重新解析锚点）。
 *  - 订阅播放器当前步：kind=code-line/code-token 的 targets 注入
 *    .beam-line + .beam-line-glyph decorations（特效色写 --beam-color），
 *    并 revealLineInCenter 平滑滚动跟随。
 *  - readOnly（讲课）/ 可编辑（练习）两种模式。
 */
"use client";

import { useEffect, useRef, useState } from "react";
import type { AnswerSegment } from "@/lib/ask/types";
import { selectAskPresentation, usePlayerStore } from "@/lib/player/store";
import { ANCHOR_REFRESH_EVENT } from "@/components/effects/use-anchor-rect";
import type { EffectCall, EffectTarget, TeachingStep } from "@/lib/teaching/types";
import { registerCodeEditor, type CodeEditorHandle } from "@/lib/ask/code-editor-registry";
import { computeLineRange } from "@/lib/ask/code-line-range";

const EMPTY_TARGETS: EffectTarget[] = [];
const EMPTY_EFFECTS: EffectCall[] = [];

type MonacoApi = typeof import("monaco-editor");
type IEditor = import("monaco-editor").editor.IStandaloneCodeEditor;

const BEAM_COLOR_VARS: Record<string, string> = {
  gold: "var(--color-beam-gold)",
  cyan: "var(--color-beam-cyan)",
  violet: "var(--color-beam-violet)",
  rose: "var(--color-beam-rose)",
  mint: "var(--color-beam-mint)",
};

export interface CodeEditorProps {
  value: string;
  language?: "typescript" | "python";
  readOnly?: boolean;
  onChange?: (value: string) => void;
  height?: number | string;
  askRef?: string;
}

export default function CodeEditor({
  value,
  language = "typescript",
  readOnly = true,
  onChange,
  height = "100%",
  askRef = "main",
}: CodeEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const monacoRef = useRef<MonacoApi | null>(null);
  const editorRef = useRef<IEditor | null>(null);
  const [editorReady, setEditorReady] = useState(false);
  const decorationsRef = useRef<ReturnType<IEditor["createDecorationsCollection"]> | null>(
    null,
  );
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  // 最新 value 的 ref：monaco 异步加载完成后用彼时最新值建编辑器，
  // 避免"API 数据先于 monaco chunk 到达"的竞态导致编辑器为空
  const valueRef = useRef(value);
  valueRef.current = value;

  // 挂载：加载 monaco、建编辑器、注册锚点解析器
  useEffect(() => {
    let disposed = false;
    let cleanup: (() => void) | undefined;

    (async () => {
      try {
        // 整包引入（exports map 仅暴露包根）；workers 未配置时 monaco 主线程降级，
        // 语法高亮（monarch）/编辑/decorations 均不受影响，纯本地无 CDN。
        const monaco = await import("monaco-editor");
        // lib/anchors 顶层依赖 DOMRect，仅浏览器端动态加载（SSR 安全）
        const { registerCodeLineResolver } = await import("@/lib/anchors");
        if (disposed || !containerRef.current) return;
      monacoRef.current = monaco;
      // 无打包 worker 环境：提供空操作 worker，避免 monaco 内部 worker
      // 引导失败产生 unhandledRejection（主线程降级，功能不受影响）
      if (typeof self !== "undefined" && !("MonacoEnvironment" in self)) {
        (self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
          getWorker: () =>
            new Worker(
              URL.createObjectURL(
                new Blob(["self.onmessage=()=>{}"], { type: "text/javascript" }),
              ),
            ),
        };
      }
      // 关闭 TS worker 语义诊断（无 worker 环境；类型未暴露，按运行时探测调用）
      (monaco.languages as unknown as {
        typescript?: {
          typescriptDefaults?: {
            setDiagnosticsOptions?: (o: Record<string, boolean>) => void;
          };
        };
      }).typescript?.typescriptDefaults?.setDiagnosticsOptions?.({
        noSemanticValidation: true,
        noSyntaxValidation: true,
      });

      monaco.editor.defineTheme("chalkboard-dark", {
        base: "vs-dark",
        inherit: true,
        rules: [],
        colors: {
          "editor.background": "#111716",
          "editor.lineHighlightBackground": "#1a222080",
          "editorLineNumber.foreground": "#5d594e",
          "editorLineNumber.activeForeground": "#cfc9b8",
          "editorGutter.background": "#111716",
        },
      });

      const editor = monaco.editor.create(containerRef.current, {
        value: valueRef.current,
        language,
        theme: "chalkboard-dark",
        readOnly,
        glyphMargin: true,
        minimap: { enabled: false },
        fontFamily: '"JetBrains Mono", "Maple Mono NF", ui-monospace, monospace',
        fontSize: 13.5,
        lineHeight: 22,
        padding: { top: 12, bottom: 12 },
        scrollBeyondLastLine: false,
        renderLineHighlight: "none",
        automaticLayout: true,
        scrollbar: { verticalScrollbarSize: 8 },
      });
      editorRef.current = editor;
      decorationsRef.current = editor.createDecorationsCollection();

      editor.onDidChangeModelContent((event) => {
        // setValue 恢复参考代码属于程序更新，不是学生输入，不能回写或保存为草稿。
        if (!event.isFlush) onChangeRef.current?.(editor.getValue());
      });

      // Monaco 内部滚动 → 通知特效层重新解析锚点（rAF 合帧）
      let raf = 0;
      editor.onDidScrollChange(() => {
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() =>
          window.dispatchEvent(new Event(ANCHOR_REFRESH_EVENT)),
        );
      });

      // 行号区间 → viewport rect（供 DOM 特效锚定代码行）
      registerCodeLineResolver((start, end) => {
        const dom = editor.getDomNode();
        const model = editor.getModel();
        if (!dom || !model) return null;
        const s = Math.max(1, Math.min(start, model.getLineCount()));
        const e = Math.max(s, Math.min(end, model.getLineCount()));
        const lineHeight = editor.getOption(monaco.editor.EditorOption.lineHeight);
        const top = editor.getTopForLineNumber(s) - editor.getScrollTop();
        const h = editor.getTopForLineNumber(e) - editor.getScrollTop() + lineHeight - top;
        const r = dom.getBoundingClientRect();
        const y = Math.max(r.top + top, r.top);
        if (y > r.bottom || r.top + top + h < r.top) return null; // 滚出可视区
        return new DOMRect(r.left, y, r.width, h);
      });

      const handle: CodeEditorHandle = {
        getLineRangeForClientBox(top: number, bottom: number): { startLine: number; endLine: number } | null {
          let lineHeight: number | undefined;
          try {
            lineHeight = editor.getOption(monaco.editor.EditorOption.lineHeight);
          } catch {
            // fallback if unavailable
          }
          return computeLineRange(editor, top, bottom, {
            lineHeight: typeof lineHeight === "number" && lineHeight > 0 ? lineHeight : 22,
          });
        },
        getLinesText(startLine: number, endLine: number): string {
          const model = editor.getModel();
          if (!model) return "";
          const lineCount = model.getLineCount?.() ?? 0;
          const s = Math.max(1, Math.min(startLine, lineCount));
          const e = Math.max(s, Math.min(endLine, lineCount));
          const lines: string[] = [];
          for (let i = s; i <= e; i++) {
            lines.push(model.getLineContent(i));
          }
          return lines.join("\n");
        },
        getFullText(): string {
          const model = editor.getModel();
          return model ? model.getValue() : editor.getValue?.() ?? "";
        },
      };

      const unregister = registerCodeEditor(containerRef.current, handle);

      cleanup = () => {
        unregister();
        registerCodeLineResolver(null);
        cancelAnimationFrame(raf);
        decorationsRef.current?.clear();
        editor.dispose();
      };
      // 首步可能先于 Monaco 到达，实例就绪后必须补应用当前步骤。
      setEditorReady(true);
      } catch (err) {
        // monaco chunk 加载失败（如 HMR 期间）：静默降级为空黑板，不产生 unhandledRejection
        if (!disposed) console.warn("[CodeEditor] monaco 加载失败", err);
      }
    })();

    return () => {
      disposed = true;
      cleanup?.();
    };
    // 编辑器实例只建一次；value/readOnly 由下方 effect 同步
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 外部 value 变化 → 同步进编辑器（避免覆盖用户正在输入的内容）
  useEffect(() => {
    const editor = editorRef.current;
    if (editor && editor.getValue() !== value) editor.setValue(value);
  }, [value, editorReady]);

  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly });
  }, [readOnly, editorReady]);

  useEffect(() => {
    const monaco = monacoRef.current;
    const editor = editorRef.current;
    if (monaco && editor) {
      const model = editor.getModel();
      if (model) monaco.editor.setModelLanguage(model, language);
    }
  }, [language, editorReady]);

  // 订阅播放器：注入光束 decorations + 平滑滚动跟随
  useEffect(() => {
    const apply = (step: TeachingStep | undefined, status: string, segment: AnswerSegment | null) => {
      const monaco = monacoRef.current;
      const editor = editorRef.current;
      const collection = decorationsRef.current;
      if (!monaco || !editor || !collection) return;
      const model = editor.getModel();
      if (!model) return;

      if (!step || status === "idle") {
        collection.clear();
        return;
      }

      // 回答段在播时只用该段的 targets/effects；缺省按空数组，不回落到原步。
      const targets = segment ? (segment.targets ?? EMPTY_TARGETS) : step.targets;
      const effects = segment ? (segment.effects ?? EMPTY_EFFECTS) : step.effects;

      const decos: import("monaco-editor").editor.IModelDeltaDecoration[] = [];
      let beamColor: string | null = null;
      let revealLine: number | null = null;

      targets.forEach((t, i) => {
        if (t.kind !== "code-line" && t.kind !== "code-token") return;
        const rawStart = t.kind === "code-line" ? t.start : t.line;
        const rawEnd = t.kind === "code-line" ? (t.end ?? t.start) : t.line;
        const start = Math.max(1, Math.min(rawStart, model.getLineCount()));
        const end = Math.max(start, Math.min(rawEnd, model.getLineCount()));
        const call = effects.find(
          (c) => c.effect === "spotlight-beam" && (c.targetIndex ?? 0) === i,
        );
        beamColor = beamColor ?? BEAM_COLOR_VARS[call?.color ?? "gold"];
        revealLine = revealLine ?? start;
        decos.push({
          range: new monaco.Range(start, 1, end, 1),
          options: {
            isWholeLine: true,
            className: "beam-line",
            glyphMarginClassName: "beam-line-glyph",
          },
        });
      });

      collection.set(decos);
      const dom = editor.getDomNode();
      if (dom && beamColor) dom.style.setProperty("--beam-color", beamColor);
      if (revealLine !== null) {
        editor.revealLineInCenter(revealLine, monaco.editor.ScrollType.Smooth);
      }
    };

    const publish = (s: Parameters<typeof selectAskPresentation>[0] & {
      steps: TeachingStep[];
      currentIndex: number;
      status: string;
    }) => apply(s.steps[s.currentIndex], s.status, selectAskPresentation(s));
    publish(usePlayerStore.getState());
    const unsub = usePlayerStore.subscribe(publish);
    return unsub;
  // 恢复参考代码会清掉 Monaco 装饰，代码同步后也要重新应用当前步骤。
  }, [editorReady, value]);

  return (
    <div
      ref={containerRef}
      data-ask-target="code"
      data-ask-id={`code:${askRef}`}
      className="h-full w-full overflow-hidden bg-board-900"
      style={{ height }}
    />
  );
}
