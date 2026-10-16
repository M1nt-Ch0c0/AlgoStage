/**
 * Test-only A/B toggles for the capture setup. Read from window.__ASK_AB__.
 * Production never sets that object, and every flag is then off: prewarm,
 * the pre-capture paint (one frame, then one macrotask), and the
 * post-capture input yield all run.
 */

export type AskAbFlags = {
  /** Skip the idle prewarm. The encode worker is created on demand. */
  noPrewarm?: boolean;
  /** Skip the frame and macrotask that paint the busy row before capture. */
  noDoubleRaf?: boolean;
  /** Skip the post-capture input yield. */
  noSettle?: boolean;
};

declare global {
  interface Window {
    __ASK_AB__?: AskAbFlags;
  }
}

/** The live flag object, or null when the page did not install one. */
export function askAbFlags(): AskAbFlags | null {
  if (typeof window === "undefined") return null;
  const flags = window.__ASK_AB__;
  if (flags == null || typeof flags !== "object") return null;
  return flags;
}

export function askAb(flag: keyof AskAbFlags): boolean {
  return askAbFlags()?.[flag] === true;
}
