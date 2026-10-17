import type { AskSelectionSummary } from "@/lib/ask/types";

export type AskOpenSource = { kind: "chip"; key: string } | { kind: "box" };

/** Esc close-panel uses "selection"; Cancel / ghost keep "opener" (SCOPE 14:25). */
export type AskCancelFocusMode = "selection" | "opener";

let openSource: AskOpenSource | null = null;

export function setAskOpenSource(src: AskOpenSource | null): void {
  openSource = src;
}

export function getAskOpenSource(): AskOpenSource | null {
  return openSource;
}

function focusableAskId(selection: AskSelectionSummary | null): HTMLElement | null {
  const id = selection?.targets[0]?.id;
  if (!id || typeof document === "undefined") return null;
  const esc = typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(id) : id.replace(/"/g, '\\"');
  const el = document.querySelector<HTMLElement>(`[data-ask-id="${esc}"]`);
  if (!el || !el.isConnected) return null;
  if (!el.hasAttribute("tabindex")) el.tabIndex = -1;
  return el;
}

/** Live DOM lookup. Chip key wins when recorded; never prefer tabIndex===0 over the recorded key. */
export function resolveAskCancelFocusTarget(opts: {
  isMobile: boolean;
  selection: AskSelectionSummary | null;
  /** Default "opener". Esc close-panel passes "selection". */
  focusMode?: AskCancelFocusMode;
}): HTMLElement | null {
  if (typeof document === "undefined") return null;
  const focusMode = opts.focusMode ?? "opener";
  if (focusMode === "opener") {
    const src = openSource;
    if (src?.kind === "chip") {
      const chip = document.querySelector<HTMLElement>(
        `[data-ask-bottom-bar] [data-ask-shortcut="${src.key}"]`,
      );
      if (chip?.isConnected) return chip;
    }
    if (opts.isMobile) {
      const bar = document.querySelector("[data-ask-bottom-bar]");
      const chips = bar?.querySelectorAll<HTMLElement>("[data-ask-shortcut]");
      const current = Array.from(chips ?? []).find((c) => c.tabIndex === 0) ?? chips?.[0] ?? null;
      if (current?.isConnected) return current;
    }
  }
  const byId = focusableAskId(opts.selection);
  if (byId) return byId;
  return document.querySelector<HTMLElement>("[data-ask-layer]");
}
