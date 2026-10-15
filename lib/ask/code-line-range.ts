export interface CodeLineRangeEditor {
  getDomNode?(): { getBoundingClientRect?(): { top: number; bottom?: number; left?: number; right?: number; width?: number; height?: number } } | null;
  getLayoutInfo?(): { contentTop?: number } | null | unknown;
  getModel?(): { getLineCount?(): number } | null;
  getVisibleRanges?(): Array<{ startLineNumber: number; endLineNumber: number }> | null;
  getScrollTop?(): number;
  getTopForLineNumber?(lineNumber: number): number;
  getOption?(option: unknown): unknown;
  lineHeight?: number;
}

export interface ComputeLineRangeOptions {
  lineHeight?: number;
  lineHeightOption?: unknown;
}

export function formatCodeRangeLabel(range: { startLine: number; endLine: number }): string {
  if (range.startLine === range.endLine) {
    return `代码第 ${range.startLine} 行`;
  }
  return `代码第 ${range.startLine}–${range.endLine} 行`;
}

/**
 * Pure geometry helper to compute the line range in Monaco for a given client Y box.
 * Returns null if editor APIs are missing, invalid, or the box is outside all visible lines.
 */
export function computeLineRange(
  editor: CodeLineRangeEditor | null | undefined,
  top: number,
  bottom: number,
  options?: ComputeLineRangeOptions,
): { startLine: number; endLine: number } | null {
  if (!editor) return null;
  if (typeof top !== "number" || typeof bottom !== "number" || Number.isNaN(top) || Number.isNaN(bottom)) {
    return null;
  }

  const domNode = editor.getDomNode?.();
  if (!domNode || typeof domNode.getBoundingClientRect !== "function") return null;
  const editorRect = domNode.getBoundingClientRect();
  if (!editorRect || typeof editorRect.top !== "number" || Number.isNaN(editorRect.top)) return null;

  const layout = (typeof editor.getLayoutInfo === "function" ? editor.getLayoutInfo() : null) as { contentTop?: number } | null;
  const contentTop = (layout && typeof layout.contentTop === "number" && !Number.isNaN(layout.contentTop))
    ? layout.contentTop
    : 0;

  if (typeof editor.getScrollTop !== "function") return null;
  const scrollTop = editor.getScrollTop();
  if (typeof scrollTop !== "number" || Number.isNaN(scrollTop)) return null;

  const model = editor.getModel?.();
  if (!model || typeof model.getLineCount !== "function") return null;
  const lineCount = model.getLineCount();
  if (typeof lineCount !== "number" || lineCount <= 0 || Number.isNaN(lineCount)) return null;

  const visibleRanges = editor.getVisibleRanges?.();
  if (!visibleRanges || !Array.isArray(visibleRanges) || visibleRanges.length === 0) return null;

  let minVisible = Infinity;
  let maxVisible = -Infinity;
  for (const r of visibleRanges) {
    if (r && typeof r.startLineNumber === "number" && typeof r.endLineNumber === "number") {
      if (r.startLineNumber < minVisible) minVisible = r.startLineNumber;
      if (r.endLineNumber > maxVisible) maxVisible = r.endLineNumber;
    }
  }
  if (!Number.isFinite(minVisible) || !Number.isFinite(maxVisible)) return null;

  minVisible = Math.max(1, Math.min(minVisible, lineCount));
  maxVisible = Math.max(minVisible, Math.min(maxVisible, lineCount));
  if (minVisible > maxVisible) return null;

  if (typeof editor.getTopForLineNumber !== "function") return null;

  const boxTop = Math.min(top, bottom);
  const boxBottom = Math.max(top, bottom);
  const y1 = boxTop - editorRect.top - contentTop + scrollTop;
  const y2 = boxBottom - editorRect.top - contentTop + scrollTop;
  if (!Number.isFinite(y1) || !Number.isFinite(y2)) return null;

  let callerLineHeight: number | undefined;
  if (typeof options?.lineHeight === "number" && Number.isFinite(options.lineHeight) && options.lineHeight > 0) {
    callerLineHeight = options.lineHeight;
  } else if (typeof editor.lineHeight === "number" && Number.isFinite(editor.lineHeight) && editor.lineHeight > 0) {
    callerLineHeight = editor.lineHeight;
  } else if (options?.lineHeightOption !== undefined && typeof editor.getOption === "function") {
    const opt = editor.getOption(options.lineHeightOption);
    if (typeof opt === "number" && Number.isFinite(opt) && opt > 0) {
      callerLineHeight = opt;
    }
  }

  const getLineHeight = (n: number): number => {
    if (callerLineHeight !== undefined) return callerLineHeight;
    if (n < lineCount) {
      const diff = editor.getTopForLineNumber!(n + 1) - editor.getTopForLineNumber!(n);
      if (Number.isFinite(diff) && diff > 0) return diff;
    }
    if (n > 1) {
      const diff = editor.getTopForLineNumber!(n) - editor.getTopForLineNumber!(n - 1);
      if (Number.isFinite(diff) && diff > 0) return diff;
    }
    return 0;
  };

  if (y2 - y1 < 4) {
    const y = (y1 + y2) / 2;
    for (let n = minVisible; n <= maxVisible; n++) {
      const top_n = editor.getTopForLineNumber(n);
      if (typeof top_n !== "number" || !Number.isFinite(top_n)) return null;
      const lh = getLineHeight(n);
      if (typeof lh !== "number" || !Number.isFinite(lh) || lh <= 0) return null;
      if (top_n <= y && y < top_n + lh) {
        return { startLine: n, endLine: n };
      }
    }
    return null;
  }

  const testY1 = y1 + 2;
  const testY2 = y2 - 2;
  if (testY1 >= testY2) return null;

  let start: number | null = null;
  for (let n = minVisible; n <= maxVisible; n++) {
    const top_n = editor.getTopForLineNumber(n);
    if (typeof top_n !== "number" || !Number.isFinite(top_n)) return null;
    const lh = getLineHeight(n);
    if (typeof lh !== "number" || !Number.isFinite(lh) || lh <= 0) return null;
    if (top_n + lh > testY1) {
      start = n;
      break;
    }
  }

  let end: number | null = null;
  for (let n = maxVisible; n >= minVisible; n--) {
    const top_n = editor.getTopForLineNumber(n);
    if (typeof top_n !== "number" || !Number.isFinite(top_n)) return null;
    if (top_n < testY2) {
      end = n;
      break;
    }
  }

  if (start === null || end === null || start > end) return null;

  start = Math.max(1, Math.max(minVisible, start));
  end = Math.min(lineCount, Math.min(maxVisible, end));
  if (start > end) return null;

  return { startLine: start, endLine: end };
}
