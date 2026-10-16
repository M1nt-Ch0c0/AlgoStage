/**
 * A press that hit 取消, released on the button, after the ask fetch has
 * already been issued. The hit is the cancel flag from the capture-phase
 * listener, not pointerdown.timeStamp (CDP stamps that when the renderer
 * dequeues the event, which is after the stall). A slide-off is not a cancel.
 */
export function shouldRetroCancel(
  hitCancel: boolean,
  sent: boolean,
  releasedOnButton: boolean,
): boolean {
  if (!releasedOnButton) return false;
  if (!sent) return false;
  return hitCancel;
}
