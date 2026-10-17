import { flushSync } from "react-dom";
import {
  applyAskSelectingRootVars,
  measureAskElementHeight,
  measureAskPlayerBarHeight,
  sharedAskMeasureCache,
} from "@/lib/ask/ask-occlusion";
import {
  resolveAskCancelFocusTarget,
  type AskCancelFocusMode,
} from "@/lib/ask/ask-open-source";
import { usePlayerStore } from "@/lib/player/store";

/**
 * Compatibility mousedown/click after a touch cancel. Armed at the end of
 * finishAskCancelSync, after the opener chip is focused. Stays up for 500ms
 * so the ghost that follows the microtask unmount cannot move focus onto the
 * bar exit. 0 means idle.
 *
 * One ghost gesture: the compatibility sequence is a mouse pointerdown, then
 * mousedown, then click, with no touch pointerdown between them. A real tap
 * starts with a touch pointerdown and ends the window so the exit button
 * still receives its click.
 */
export let askCancelGhostUntil = 0;

const GHOST_SUPPRESS_MS = 500;

const GHOST_TARGET =
  "[data-ask-layer], [data-ask-bottom-bar], [data-ask-entry], [data-ask-shortcut]";

/** True once this window has swallowed its ghost mousedown. */
let ghostGestureSpent = false;
/** The swallowed mousedown. Only its matching click is eaten. */
let ghostMouseDown: Event | null = null;

function ghostSuppressActive(): boolean {
  return askCancelGhostUntil > 0 && performance.now() < askCancelGhostUntil;
}

/** True while the post-cancel ghost window is still open. */
export function isAskCancelGhostActive(): boolean {
  return ghostSuppressActive();
}

const BAR_EXIT_SELECTOR = "[data-ask-bottom-bar] [data-ask-entry]";

/** Bar exit, or any ask-entry that is not the opener chip. */
function isGhostFocusSteal(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const entry = target.closest("[data-ask-entry]");
  if (!entry) return false;
  if (entry.closest("[data-ask-shortcut]")) return false;
  return true;
}

function barExitButton(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  return document.querySelector<HTMLElement>(BAR_EXIT_SELECTOR);
}

/**
 * While the ghost window is up, the bar exit cannot take a pointer hit.
 * Cleared when the window ends (timeout or the first real touch). Keyboard
 * Esc stays on the window listener — this only sets pointer-events.
 */
function syncGhostExitPointerEvents(): void {
  const exit = barExitButton();
  if (!exit) return;
  if (ghostSuppressActive()) {
    exit.style.pointerEvents = "none";
    return;
  }
  if (exit.style.pointerEvents === "none") exit.style.pointerEvents = "";
}

function endAskCancelGhostWindow(): void {
  askCancelGhostUntil = 0;
  ghostGestureSpent = false;
  ghostMouseDown = null;
  syncGhostExitPointerEvents();
}

function eventInGhostZone(event: Event): boolean {
  const target = event.target;
  if (!(target instanceof Element)) return false;
  return target.closest(GHOST_TARGET) != null;
}

function swallowGhost(event: Event): void {
  event.preventDefault();
  event.stopPropagation();
}

function onGhostMouse(event: Event): void {
  if (event.type === "click") {
    // A real click() has no swallowed mousedown. The compatibility click
    // follows the mousedown this window already ate.
    if (ghostMouseDown == null) return;
    if (!eventInGhostZone(event)) return;
    swallowGhost(event);
    ghostMouseDown = null;
    return;
  }
  if (!ghostSuppressActive() || ghostGestureSpent) return;
  if (!eventInGhostZone(event)) return;
  swallowGhost(event);
  ghostGestureSpent = true;
  ghostMouseDown = event;
}

let ghostSuppressInstalled = false;

/** Capture listeners, installed once. No-op until armAskCancelGhostSuppress. */
function installAskCancelGhostSuppress(): void {
  if (ghostSuppressInstalled || typeof document === "undefined") return;
  ghostSuppressInstalled = true;
  document.addEventListener("mousedown", onGhostMouse, true);
  document.addEventListener("click", onGhostMouse, true);
  document.addEventListener("pointerdown", onGhostPointerDown, true);
  document.addEventListener("focusin", onGhostFocusIn, true);
}

/**
 * Capture focusin while the ghost window is up. A scheduled focus (ask-entry
 * hide effect, or a ghost that focuses the exit) must not stick. Same
 * resolve+focus as finishAskCancelSync, synchronously — no rAF.
 */
function onGhostFocusIn(event: FocusEvent): void {
  if (!ghostSuppressActive()) return;
  if (!isGhostFocusSteal(event.target)) return;
  focusAskCancelTarget();
}

function onGhostPointerDown(event: Event): void {
  if (!ghostSuppressActive()) return;
  if (!(event instanceof PointerEvent)) return;
  // A new touch is a real gesture. Drop the window so its click is delivered.
  if (event.pointerType === "touch") {
    endAskCancelGhostWindow();
    return;
  }
  if (event.pointerType !== "mouse" || ghostGestureSpent) return;
  if (!eventInGhostZone(event)) return;
  swallowGhost(event);
}

/**
 * Hold ghost suppress until performance.now()+500. Call after the first
 * opener focus in finishAskCancelSync, still in that same turn.
 */
export function armAskCancelGhostSuppress(): void {
  if (typeof performance === "undefined") return;
  installAskCancelGhostSuppress();
  ghostGestureSpent = false;
  ghostMouseDown = null;
  askCancelGhostUntil = performance.now() + GHOST_SUPPRESS_MS;
  syncGhostExitPointerEvents();
  if (typeof window !== "undefined") {
    window.setTimeout(() => {
      if (!ghostSuppressActive()) syncGhostExitPointerEvents();
    }, GHOST_SUPPRESS_MS);
  }
}

/** Visual close in this turn. Does not move focus. */
export function hideAskPanelNow(panel: HTMLElement | null): void {
  if (!panel) return;
  panel.style.display = "none";
  panel.setAttribute("aria-hidden", "true");
  panel.setAttribute("inert", "");
}

function focusAskCancelTarget(focusMode: AskCancelFocusMode = "opener"): void {
  const isMobile = window.matchMedia("(max-width: 639px)").matches;
  const target = resolveAskCancelFocusTarget({
    isMobile,
    selection: usePlayerStore.getState().selection,
    focusMode,
  });
  const focused = document.activeElement;
  if (focused instanceof HTMLElement && focused !== target) {
    if (focused.closest("[data-ask-panel]") || target) focused.blur();
  }
  target?.focus({ preventScroll: true });
}

/**
 * Hide, commit the store transition, then restore selecting root vars and
 * focus before the next frame. One sync measure only when the shared cache
 * is incomplete (Leo L4), still before focus.
 * focusMode: Esc close-panel passes "selection"; Cancel keeps default "opener".
 */
export function finishAskCancelSync(
  panel: HTMLElement | null,
  transition: () => void,
  opts?: { focusMode?: AskCancelFocusMode },
): void {
  const focusMode = opts?.focusMode ?? "opener";
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
  focusAskCancelTarget(focusMode);
  // After the first focus: the compatibility mousedown lands once the
  // panel unmounts on the following microtask. Swallow it, then put focus
  // back on the opener in this same turn. No rAF, timeout, or microtask.
  armAskCancelGhostSuppress();
  focusAskCancelTarget(focusMode);
}
