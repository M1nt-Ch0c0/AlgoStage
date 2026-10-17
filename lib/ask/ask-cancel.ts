import { flushSync } from "react-dom";
import {
  applyAskSelectingRootVars,
  measureAskElementHeight,
  measureAskPlayerBarHeight,
  sharedAskMeasureCache,
} from "@/lib/ask/ask-occlusion";
import { resolveAskCancelFocusTarget } from "@/lib/ask/ask-open-source";
import { usePlayerStore } from "@/lib/player/store";

/** Visual close in this turn. Does not move focus. */
export function hideAskPanelNow(panel: HTMLElement | null): void {
  if (!panel) return;
  panel.style.display = "none";
  panel.setAttribute("aria-hidden", "true");
  panel.setAttribute("inert", "");
}

/**
 * Hide, commit the store transition, then restore selecting root vars and
 * focus before the next frame. One sync measure only when the shared cache
 * is incomplete (Leo L4), still before focus.
 */
export function finishAskCancelSync(panel: HTMLElement | null, transition: () => void): void {
  hideAskPanelNow(panel);
  flushSync(transition);
  if (usePlayerStore.getState().askPhase !== "selecting") return;
  const applied = applyAskSelectingRootVars(sharedAskMeasureCache, true);
  if (applied.deferred && typeof document !== "undefined") {
    // Leo L4: only when cache incomplete — one sync measure, then re-apply, still before focus.
    const cache = sharedAskMeasureCache;
    cache.isMobile = window.matchMedia("(max-width: 639px)").matches;
    const vv = window.visualViewport;
    cache.keyboardOpen = vv != null && window.innerHeight - vv.height > 120;
    if (cache.isMobile && !cache.keyboardOpen) {
      cache.playerHeight = measureAskPlayerBarHeight();
      const barEl = document.querySelector<HTMLElement>("[data-ask-bottom-bar]");
      cache.barHeight = barEl ? measureAskElementHeight(barEl) : cache.barHeight;
    }
    applyAskSelectingRootVars(cache, true);
  }
  const isMobile = window.matchMedia("(max-width: 639px)").matches;
  const target = resolveAskCancelFocusTarget({ isMobile, selection: usePlayerStore.getState().selection });
  const focused = document.activeElement;
  if (focused instanceof HTMLElement && focused !== target) {
    if (focused.closest("[data-ask-panel]") || target) focused.blur();
  }
  target?.focus({ preventScroll: true });
}
