/**
 * Player bar + chip bar + open panel, plus the 8px gap the bottom chrome
 * leaves above the viewport edge. A positive panel hides the chip bar
 * (the drawer covers it). All three at 0 is 0, not the gap.
 * chip390-b reuses this formula on rebase; keep the math identical.
 */
export interface OcclusionParts {
  playerHeight?: number;
  barHeight?: number;
  panelHeight?: number;
}

export function computeBottomOcclusion(parts: OcclusionParts): number {
  const player = Math.max(0, Math.ceil(parts.playerHeight ?? 0));
  const panel = Math.max(0, Math.ceil(parts.panelHeight ?? 0));
  const bar = panel > 0 ? 0 : Math.max(0, Math.ceil(parts.barHeight ?? 0));

  if (player === 0 && bar === 0 && panel === 0) return 0;

  return player + bar + panel + 8;
}

/**
 * Last measured mobile / keyboard / height snapshot. Null means "not measured
 * yet" — a cancel commit must not invent a layout read to fill it.
 * chip390-b will reuse this cache on rebase.
 */
export type AskMeasureCache = {
  isMobile: boolean | null;
  keyboardOpen: boolean | null;
  playerHeight: number | null;
  barHeight: number | null;
};

export function createAskMeasureCache(): AskMeasureCache {
  return { isMobile: null, keyboardOpen: null, playerHeight: null, barHeight: null };
}

/** Drop every cached measurement. The next rAF re-measure fills them again. */
export function invalidateAskMeasureCache(cache: AskMeasureCache): void {
  cache.isMobile = null;
  cache.keyboardOpen = null;
  cache.playerHeight = null;
  cache.barHeight = null;
}

/** Root custom properties whose writes inherit and dirty the whole document. */
export type AskRootVarName = "--ask-player-bar-h" | "--ask-bottom-bar-h" | "--ask-bottom-occlusion";

const ASK_ROOT_VAR_NAMES: AskRootVarName[] = [
  "--ask-player-bar-h",
  "--ask-bottom-bar-h",
  "--ask-bottom-occlusion",
];

/**
 * Batch a root-var update. getPropertyValue on an inline style is not a layout
 * read, so every current value is read before any setProperty. Unchanged
 * values are left alone: a custom property on documentElement dirties the
 * whole tree, and the next layout read then pays for a full recalc.
 * Returns the names that were actually written.
 */
export function writeAskRootVars(
  next: Partial<Record<AskRootVarName, string>>,
  style: CSSStyleDeclaration = typeof document !== "undefined"
    ? document.documentElement.style
    : (undefined as unknown as CSSStyleDeclaration),
): AskRootVarName[] {
  if (!style || typeof style.getPropertyValue !== "function" || typeof style.setProperty !== "function") {
    return [];
  }
  const names = ASK_ROOT_VAR_NAMES.filter((name) => next[name] !== undefined);
  const current = names.map((name) => style.getPropertyValue(name));
  const written: AskRootVarName[] = [];
  for (let i = 0; i < names.length; i++) {
    const value = next[names[i]];
    if (value === undefined || current[i] === value) continue;
    style.setProperty(names[i], value);
    written.push(names[i]);
  }
  return written;
}

/**
 * Selecting-phase --ask-bottom-* values from the cache alone. No DOM and no
 * layout reads. Inactive, desktop, or an open keyboard publishes 0px. A null
 * field the formula needs means the caller must wait for the rAF re-measure.
 */
export function selectingRootVarsFromCache(
  cache: AskMeasureCache,
  active: boolean,
): { "--ask-bottom-bar-h": string; "--ask-bottom-occlusion": string } | null {
  if (!active || cache.isMobile === false || cache.keyboardOpen === true) {
    return { "--ask-bottom-bar-h": "0px", "--ask-bottom-occlusion": "0px" };
  }
  if (
    cache.isMobile == null ||
    cache.keyboardOpen == null ||
    cache.playerHeight == null ||
    cache.barHeight == null
  ) {
    return null;
  }
  const bar = `${cache.barHeight}px`;
  const occlusion = `${computeBottomOcclusion({
    playerHeight: cache.playerHeight,
    barHeight: cache.barHeight,
    panelHeight: 0,
  })}px`;
  return { "--ask-bottom-bar-h": bar, "--ask-bottom-occlusion": occlusion };
}

/**
 * Publish selecting root vars from the cache. deferred is true when the cache
 * is incomplete: nothing is written, and the caller keeps the already-queued
 * rAF re-measure.
 */
export function applyAskSelectingRootVars(
  cache: AskMeasureCache,
  active: boolean,
  style?: CSSStyleDeclaration,
): { written: AskRootVarName[]; deferred: boolean } {
  const next = selectingRootVarsFromCache(cache, active);
  if (next == null) return { written: [], deferred: true };
  return { written: writeAskRootVars(next, style), deferred: false };
}

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
