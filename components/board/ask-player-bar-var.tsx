"use client";

import { useEffect, useLayoutEffect } from "react";
import { measureAskPlayerBarHeight, writeAskRootVars } from "@/lib/ask/ask-occlusion";
import { usePlayerStore } from "@/lib/player/store";

/** Layout on the client so the first paint already has the offset; effect during SSR. */
const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

/**
 * Phases where something still reads --ask-player-bar-h: the chip bar during
 * selecting, and the panel margin while the drawer is open.
 *
 * playing is omitted on purpose. AskPanel returns null for playing and done
 * (components/board/ask-panel.tsx), so [data-ask-panel] and its 取消 are gone
 * before the answer plays. The answer itself is StepAnswers, in normal flow
 * under the lesson step, and it does not read --ask-player-bar-h. The chip
 * bar is AskSelectionLayer, which renders only for selecting/drafting/error
 * (ACTIVE_PHASES). globals.css applies the variable only to
 * [data-ask-bottom-bar] and [data-ask-panel]. Both are absent in playing, so
 * publishing the offset there would not hold any panel or 取消 in place.
 */
const ASK_OPEN_PHASES = new Set(["selecting", "drafting", "error", "sending", "streaming"]);

function keyboardOpen(): boolean {
  if (typeof window === "undefined" || !window.visualViewport) return false;
  return window.innerHeight - window.visualViewport.height > 120;
}

/**
 * Last string this module published. Compared together with the live inline
 * value so a phase change that does not move the bar skips setProperty.
 * writeAskRootVars already skips an unchanged inline value; this stays in
 * step with that so a 0px close cannot leave a stale open height behind.
 */
let lastWrittenPlayerBarH: string | null = null;

function publishPlayerBarHeight(value: string): void {
  if (typeof document === "undefined") return;
  if (lastWrittenPlayerBarH === value) {
    const live = document.documentElement.style.getPropertyValue("--ask-player-bar-h");
    if (live === value) return;
  }
  const written = writeAskRootVars({ "--ask-player-bar-h": value });
  if (written.length > 0 || document.documentElement.style.getPropertyValue("--ask-player-bar-h") === value) {
    lastWrittenPlayerBarH = value;
  }
}

/** Publish or clear --ask-player-bar-h. The panel margin and the chip bar read it. */
export function syncAskPlayerBarHeight(): void {
  if (typeof document === "undefined") return;
  const phase = usePlayerStore.getState().askPhase;
  const height = ASK_OPEN_PHASES.has(phase) && !keyboardOpen() ? measureAskPlayerBarHeight() : 0;
  publishPlayerBarHeight(`${height}px`);
}

/**
 * Owns --ask-player-bar-h for the whole ask session.
 * Keyed on open versus closed, not on the phase itself: moving between
 * selecting, drafting, sending, streaming, and error must not reset the
 * variable to 0px or measure in that commit. Open entry measures once,
 * synchronously, so the first paint has the offset. Later size changes
 * (resize, scroll, visualViewport, orientation, the narrow-viewport query)
 * re-measure on the next frame. The variable resets only when the phase
 * leaves ask entirely, on unmount, or while the keyboard is open.
 */
export default function AskPlayerBarVar() {
  const isOpen = usePlayerStore((s) => ASK_OPEN_PHASES.has(s.askPhase));

  useIsomorphicLayoutEffect(() => {
    if (typeof document === "undefined") return;
    if (!isOpen) {
      publishPlayerBarHeight("0px");
      return;
    }

    let rafHandle: number | null = null;
    const schedule = () => {
      if (rafHandle !== null) return;
      rafHandle = requestAnimationFrame(() => {
        rafHandle = null;
        syncAskPlayerBarHeight();
      });
    };

    syncAskPlayerBarHeight();

    const playerEl = document.querySelector<HTMLElement>('[aria-label="讲解播放区"]');
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(schedule) : null;
    if (playerEl) ro?.observe(playerEl);

    const mq = window.matchMedia("(max-width: 639px)");
    mq.addEventListener("change", schedule);
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, { passive: true, capture: true });
    window.addEventListener("orientationchange", schedule);
    window.visualViewport?.addEventListener("resize", schedule);

    return () => {
      if (rafHandle !== null) cancelAnimationFrame(rafHandle);
      ro?.disconnect();
      mq.removeEventListener("change", schedule);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, { capture: true } as EventListenerOptions);
      window.removeEventListener("orientationchange", schedule);
      window.visualViewport?.removeEventListener("resize", schedule);
      publishPlayerBarHeight("0px");
    };
  }, [isOpen]);

  return null;
}
