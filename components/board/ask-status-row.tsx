/**
 * One fixed-height status line for the ask panel.
 * Idle, preparing, and waiting share the same node so the row under it
 * (取消) does not jump when the copy changes.
 */
import { ASK_CAPTURE_PREPARING, ASK_WAITING_STATUS } from "@/lib/ask/ask-ui-text";

export type AskStatusRowState = "idle" | "preparing" | "waiting";

const ROW_CLASS = "h-6 overflow-hidden text-xs leading-6 whitespace-nowrap text-ellipsis text-chalk-300";

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
