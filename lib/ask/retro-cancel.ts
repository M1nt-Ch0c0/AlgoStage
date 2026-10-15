/**
 * A pointerdown whose event.timeStamp is at or before the ask fetch's
 * performance.now() was pressed before the send, even when the event is
 * dispatched after the fetch. The final release has to be on the button.
 * A slide-off is not a cancel.
 */
export function shouldRetroCancel(
  downTs: number,
  sentAt: number | null,
  releasedOnButton: boolean,
): boolean {
  if (!releasedOnButton) return false;
  if (sentAt == null) return false;
  if (!Number.isFinite(downTs) || !Number.isFinite(sentAt)) return false;
  return downTs <= sentAt;
}
