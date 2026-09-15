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

import { useEffect, useRef } from "react";
import { usePlayerStore } from "@/lib/player/store";
import { ANCHOR_REFRESH_EVENT } from "@/components/effects/use-anchor-rect";
import type { TeachingStep } from "@/lib/teaching/types";

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
}

export default function CodeEditor({
  value,
  language = "typescript",
  readOnly = true,
  onChange,
  height = "100%",
}: CodeEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const monacoRef = useRef<MonacoApi | null>(null);
  const editorRef = useRef<IEditor | null>(null);
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

      editor.onDidChangeModelContent(() => {
        onChangeRef.current?.(editor.getValue());
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

      cleanup = () => {
        registerCodeLineResolver(null);
        cancelAnimationFrame(raf);
        decorationsRef.current?.clear();
        editor.dispose();
      };
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
  }, [value]);

  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly });
  }, [readOnly]);

  useEffect(() => {
    const monaco = monacoRef.current;
    const editor = editorRef.current;
    if (monaco && editor) {
      const model = editor.getModel();
      if (model) monaco.editor.setModelLanguage(model, language);
    }
  }, [language]);

  // 订阅播放器：注入光束 decorations + 平滑滚动跟随
  useEffect(() => {
    const apply = (step: TeachingStep | undefined, status: string) => {
      const monaco = monacoRef.current;
      const editor = editorRef.current;
      const collection = decorationsRef.current;
      if (!monaco || !editor || !collection) return;
      const model = editor.getModel();
      if (!model) return;

      if (!step || status === "idle" || status === "finished") {
        collection.clear();
        return;
      }

      const decos: import("monaco-editor").editor.IModelDeltaDecoration[] = [];
      let beamColor: string | null = null;
      let revealLine: number | null = null;

      step.targets.forEach((t, i) => {
        if (t.kind !== "code-line" && t.kind !== "code-token") return;
        const rawStart = t.kind === "code-line" ? t.start : t.line;
        const rawEnd = t.kind === "code-line" ? (t.end ?? t.start) : t.line;
        const start = Math.max(1, Math.min(rawStart, model.getLineCount()));
        const end = Math.max(start, Math.min(rawEnd, model.getLineCount()));
        const call = step.effects.find(
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

    apply(
      usePlayerStore.getState().steps[usePlayerStore.getState().currentIndex],
      usePlayerStore.getState().status,
    );
    const unsub = usePlayerStore.subscribe((s) =>
      apply(s.steps[s.currentIndex], s.status),
    );
    return unsub;
  }, []);

  return (
    <div
      ref={containerRef}
      className="h-full w-full overflow-hidden rounded-xl border border-board-700 bg-board-900"
      style={{ height }}
    />
  );
}
