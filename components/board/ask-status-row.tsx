/**
 * One reserved-height status line for the ask panel.
 * Idle, preparing, and waiting share the same node so the row under it
 * (取消) does not jump when the copy changes.
 * Copy is product-locked and must never be truncated. Desktop (the panel's
 * md breakpoint, 768px) reserves one line. Narrower widths reserve two lines
 * so the longest waiting copy can wrap without moving 取消.
 */
import { ASK_CAPTURE_PREPARING, ASK_WAITING_STATUS } from "@/lib/ask/ask-ui-text";

export type AskStatusRowState = "idle" | "preparing" | "waiting";

const ROW_CLASS = "h-12 text-xs leading-6 text-chalk-300 md:h-6";

export function AskStatusRow({
  state,
  seconds = 0,
}: {
  state: AskStatusRowState;
  seconds?: number;
}) {
  if (state === "preparing") {
    return (
      <p data-ask-status-row data-ask-capture-preparing className={ROW_CLASS}>
        {ASK_CAPTURE_PREPARING}
      </p>
    );
  }
  if (state === "waiting") {
    return (
      <p data-ask-status-row data-ask-waiting className={ROW_CLASS}>
        {ASK_WAITING_STATUS(seconds)}
      </p>
    );
  }
  return (
    <p data-ask-status-row aria-hidden className={`${ROW_CLASS} invisible`}>
      {"\u00a0"}
    </p>
  );
}
