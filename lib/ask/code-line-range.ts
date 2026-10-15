export interface CodeLineRangeEditor {
  getDomNode?(): { getBoundingClientRect?(): { top: number; bottom?: number; left?: number; right?: number } } | null;
  getLayoutInfo?(): unknown;
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
  const rect = domNode.getBoundingClientRect();
  if (!rect || typeof rect.top !== "number" || Number.isNaN(rect.top)) return null;

  editor.getLayoutInfo?.();

  const model = editor.getModel?.();
  if (!model || typeof model.getLineCount !== "function") return null;
  const lineCount = model.getLineCount();
  if (typeof lineCount !== "number" || lineCount <= 0 || Number.isNaN(lineCount)) return null;

  const visibleRanges = editor.getVisibleRanges?.();
  if (!visibleRanges || !Array.isArray(visibleRanges) || visibleRanges.length === 0) return null;

  let minVisible = Infinity;
  let maxVisible = -Infinity;
  for (const r of visibleRanges) {
    if (typeof r.startLineNumber === "number" && typeof r.endLineNumber === "number") {
      if (r.startLineNumber < minVisible) minVisible = r.startLineNumber;
      if (r.endLineNumber > maxVisible) maxVisible = r.endLineNumber;
    }
  }
  if (!Number.isFinite(minVisible) || !Number.isFinite(maxVisible)) return null;

  minVisible = Math.max(1, Math.min(minVisible, lineCount));
  maxVisible = Math.max(minVisible, Math.min(maxVisible, lineCount));

  if (typeof editor.getScrollTop !== "function" || typeof editor.getTopForLineNumber !== "function") {
    return null;
  }
  const scrollTop = editor.getScrollTop();
  if (typeof scrollTop !== "number" || Number.isNaN(scrollTop)) return null;

  const getLineHeight = (line: number): number => {
    if (typeof options?.lineHeight === "number" && options.lineHeight > 0) {
      return options.lineHeight;
    }
    if (typeof editor.lineHeight === "number" && editor.lineHeight > 0) {
      return editor.lineHeight;
    }
    if (typeof editor.getOption === "function") {
      if (options?.lineHeightOption !== undefined) {
        const opt = editor.getOption(options.lineHeightOption);
        if (typeof opt === "number" && !Number.isNaN(opt) && opt > 0) return opt;
      }
      const optDirect = editor.getOption("lineHeight");
      if (typeof optDirect === "number" && !Number.isNaN(optDirect) && optDirect > 0) return optDirect;
    }
    if (line < lineCount) {
      const diff = editor.getTopForLineNumber!(line + 1) - editor.getTopForLineNumber!(line);
      if (typeof diff === "number" && !Number.isNaN(diff) && diff > 0) return diff;
    } else if (line > 1) {
      const diff = editor.getTopForLineNumber!(line) - editor.getTopForLineNumber!(line - 1);
      if (typeof diff === "number" && !Number.isNaN(diff) && diff > 0) return diff;
    }
    return 0;
  };

  const firstTop = editor.getTopForLineNumber(minVisible);
  const lastLineHeight = getLineHeight(maxVisible);
  const lastTop = editor.getTopForLineNumber(maxVisible);
  if (Number.isNaN(firstTop) || Number.isNaN(lastTop) || Number.isNaN(lastLineHeight) || lastLineHeight <= 0) {
    return null;
  }
  const topBound = firstTop;
  const bottomBound = lastTop + lastLineHeight;

  const boxTop = Math.min(top, bottom);
  const boxBottom = Math.max(top, bottom);
  const testBottom = boxBottom > boxTop ? boxBottom - 1 : boxTop;

  const yTop = boxTop - rect.top + scrollTop;
  const yBottom = testBottom - rect.top + scrollTop;

  if (yBottom < topBound || yTop >= bottomBound) {
    return null;
  }

  const findLineForY = (y: number): number => {
    if (y <= topBound) return minVisible;
    if (y >= bottomBound) return maxVisible;

    for (let n = minVisible; n <= maxVisible; n++) {
      const lineTop = editor.getTopForLineNumber!(n);
      const lh = getLineHeight(n);
      const lineBottom = lineTop + lh;
      if (y >= lineTop && y < lineBottom) {
        return n;
      }
      if (n < maxVisible) {
        const nextTop = editor.getTopForLineNumber!(n + 1);
        if (y >= lineBottom && y < nextTop) {
          return n;
        }
      }
    }
    return maxVisible;
  };

  let startLine = findLineForY(yTop);
  let endLine = findLineForY(yBottom);
  if (startLine > endLine) {
    const tmp = startLine;
    startLine = endLine;
    endLine = tmp;
  }
  startLine = Math.max(minVisible, Math.min(maxVisible, startLine));
  endLine = Math.max(startLine, Math.min(maxVisible, endLine));

  return { startLine, endLine };
}
