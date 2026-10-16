/**
 * Pre-send backstop. The hold wait sits between capture resolving and send.
 * A cancel released on 取消 in that window no longer has captureAbortRef
 * (cleared when capture returns), so the epoch is not bumped and the signal
 * is not aborted. The release flag and the hold latch are that decision.
 * An earlier abort still shows up as a bumped epoch or an aborted signal.
 */
export function shouldDropBeforeSend({
  epochNow,
  epochAtCapture,
  aborted,
  releasedOnCancel,
  latched,
}: {
  epochNow: number;
  epochAtCapture: number;
  aborted: boolean;
  releasedOnCancel: boolean;
  latched: "cancel" | "send" | null;
}): boolean {
  return epochNow !== epochAtCapture || aborted || releasedOnCancel || latched === "cancel";
}
