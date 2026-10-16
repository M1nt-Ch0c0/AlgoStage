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

const PLAYER_AREA_SELECTOR = '[aria-label="讲解播放区"]';

/**
 * Visible player-bar height on a narrow viewport: from the player area's top
 * edge to the bottom of the viewport. 0 when the area is missing, off-screen,
 * or the viewport is not narrow. --ask-player-bar-h is this number.
 */
export function measureAskPlayerBarHeight(root?: ParentNode | null): number {
  if (typeof window === "undefined" || typeof document === "undefined") return 0;
  if (!window.matchMedia("(max-width: 639px)").matches) return 0;
  const scope = root ?? document;
  const playerEl = scope.querySelector<HTMLElement>(PLAYER_AREA_SELECTOR);
  if (!playerEl) return 0;
  const rect = playerEl.getBoundingClientRect();
  const vh = window.innerHeight;
  const visible = rect.height > 0 && rect.bottom > 0 && rect.top < vh;
  if (!visible) return 0;
  return Math.max(0, Math.ceil(vh - rect.top));
}

/**
 * Bottom obstacle used to decide whether content is in view above the ask bar.
 * Prefers the published --ask-bottom-occlusion (player + bar + gap); falls back to
 * the bar's own height before the variable has been written.
 * chip390-b's entering-scroll check depends on this meaning.
 */
export function getAskBottomObstacle(
  barEl: Element | null | undefined,
  root?: HTMLElement,
): number {
  const occlusion = root ? getAskBottomOcclusion(root) : getAskBottomOcclusion();
  return occlusion > 0 ? occlusion : measureAskElementHeight(barEl);
}
