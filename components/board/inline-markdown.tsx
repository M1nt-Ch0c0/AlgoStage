/**
 * 行内 markdown 子集渲染（docs/03：内联 code、加粗）。
 * 字幕打字机与题面段落共用；`code` 用 JetBrains Mono + 金色高亮（docs/02 §4.6）。
 */
"use client";

import type { ReactNode } from "react";

export interface InlineSegment {
  type: "text" | "code" | "bold";
  text: string;
}

/** 解析 `code` 与 **bold**（不支持嵌套，符合协议"markdown 子集"） */
export function parseInline(md: string): InlineSegment[] {
  const segments: InlineSegment[] = [];
  const re = /`([^`]+)`|\*\*([^*]+)\*\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md)) !== null) {
    if (m.index > last) segments.push({ type: "text", text: md.slice(last, m.index) });
    if (m[1] !== undefined) segments.push({ type: "code", text: m[1] });
    else segments.push({ type: "bold", text: m[2] });
    last = m.index + m[0].length;
  }
  if (last < md.length) segments.push({ type: "text", text: md.slice(last) });
  return segments;
}

export function totalChars(segments: InlineSegment[]): number {
  return segments.reduce((n, s) => n + s.text.length, 0);
}

function renderSegment(seg: InlineSegment, key: number, clip?: number): ReactNode {
  const text = clip === undefined ? seg.text : seg.text.slice(0, clip);
  if (!text) return null;
  if (seg.type === "code") {
    return (
      <code
        key={key}
        className="rounded bg-board-700/60 px-1 font-mono text-[0.92em] text-beam-gold"
      >
        {text}
      </code>
    );
  }
  if (seg.type === "bold") {
    return (
      <strong key={key} className="font-semibold text-chalk-100">
        {text}
      </strong>
    );
  }
  return <span key={key}>{text}</span>;
}

/** 全量渲染 */
export function InlineMarkdown({ text }: { text: string }) {
  return <>{parseInline(text).map((seg, i) => renderSegment(seg, i))}</>;
}

/** 截断渲染：只显示前 count 个可见字符（打字机用） */
export function InlinePartial({
  segments,
  count,
}: {
  segments: InlineSegment[];
  count: number;
}) {
  let used = 0;
  return (
    <>
      {segments.map((seg, i) => {
        if (used >= count) return null;
        const remain = count - used;
        used += seg.text.length;
        return renderSegment(seg, i, remain >= seg.text.length ? undefined : remain);
      })}
    </>
  );
}
