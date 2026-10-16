"use client";

import { useEffect, useLayoutEffect } from "react";
import { measureAskPlayerBarHeight } from "@/lib/ask/ask-occlusion";
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

/** Publish or clear --ask-player-bar-h. The panel margin and the chip bar read it. */
export function syncAskPlayerBarHeight(): void {
  if (typeof document === "undefined") return;
  const phase = usePlayerStore.getState().askPhase;
  const height = ASK_OPEN_PHASES.has(phase) && !keyboardOpen() ? measureAskPlayerBarHeight() : 0;
  document.documentElement.style.setProperty("--ask-player-bar-h", `${height}px`);
}

/**
 * Owns --ask-player-bar-h for the whole ask session.
 * The selection chrome unmounts at sending, and the panel unmounts when the
 * answer starts streaming, but this root stays mounted until the phase leaves
 * ask entirely. The variable resets only then (or while the keyboard is open).
 */
export default function AskPlayerBarVar() {
  const askPhase = usePlayerStore((s) => s.askPhase);

  useIsomorphicLayoutEffect(() => {
    if (typeof document === "undefined") return;
    if (!ASK_OPEN_PHASES.has(askPhase)) {
      document.documentElement.style.setProperty("--ask-player-bar-h", "0px");
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
    window.visualViewport?.addEventListener("resize", schedule);

    return () => {
      if (rafHandle !== null) cancelAnimationFrame(rafHandle);
      ro?.disconnect();
      mq.removeEventListener("change", schedule);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, { capture: true } as EventListenerOptions);
      window.visualViewport?.removeEventListener("resize", schedule);
      document.documentElement.style.setProperty("--ask-player-bar-h", "0px");
    };
  }, [askPhase]);

  return null;
}
