/**
 * Reads the --ask-bottom-occlusion CSS variable from the root element
 * (inline style first, then getComputedStyle) and returns px as a number.
 * Returns 0 if missing, unparsable, or during SSR.
 */
export function getAskBottomOcclusion(
  root: HTMLElement = typeof document !== "undefined" ? document.documentElement : (undefined as unknown as HTMLElement),
): number {
  if (typeof document === "undefined" && !root) {
    return 0;
  }
  if (!root || typeof root.style?.getPropertyValue !== "function") {
    return 0;
  }

  let raw = root.style.getPropertyValue("--ask-bottom-occlusion");
  if (!raw || !raw.trim()) {
    const win = root.ownerDocument?.defaultView ?? (typeof window !== "undefined" ? window : null);
    if (win && typeof win.getComputedStyle === "function") {
      try {
        raw = win.getComputedStyle(root).getPropertyValue("--ask-bottom-occlusion");
      } catch {
        raw = "";
      }
    }
  }

  const trimmed = raw?.trim() ?? "";
  if (!trimmed) return 0;

  const match = trimmed.match(/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:px)?$/i);
  if (!match) return 0;

  const val = Number.parseFloat(trimmed);
  return Number.isFinite(val) ? val : 0;
}

/** Rounded-up border-box height of an element; 0 when missing or detached. */
export function measureAskElementHeight(el: Element | null | undefined): number {
  if (!el || typeof (el as HTMLElement).getBoundingClientRect !== "function") return 0;
  const h = el.getBoundingClientRect().height;
  return Number.isFinite(h) && h > 0 ? Math.ceil(h) : 0;
}

/**
 * Bottom obstacle used to decide whether content is in view above the ask bar.
 * Prefers the published --ask-bottom-occlusion (player + bar + gap); falls back to
 * the bar's own height before the variable has been written.
 */
export function getAskBottomObstacle(
  barEl: Element | null | undefined,
  root?: HTMLElement,
): number {
  const occlusion = root ? getAskBottomOcclusion(root) : getAskBottomOcclusion();
  return occlusion > 0 ? occlusion : measureAskElementHeight(barEl);
}
