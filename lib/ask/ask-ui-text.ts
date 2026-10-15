/**
 * M6 ask UI copy. Strings are the locked Chinese wording from TECH §4
 * and the 21:30 / 21:35 updates. Do not paraphrase.
 */
import type { AskDisabledReason } from "@/lib/player/store";
import { CAPTURE_FALLBACK_NOTICE } from "@/lib/ask/capture";

export const ASK_REASON_BUILTIN = "生成讲课后就可以提问";
export const ASK_REASON_RECEIVING = "备课完成后可以提问";
export const ASK_REASON_UNFINISHED = "这节课没讲完，重新生成后就可以提问";
export const ASK_REASON_STEP_DISABLED = "这一步暂时不能提问，重新生成这节课后就可以了";
export const ASK_REASON_BUSY = "上一个问题还在回答，答完再问";

/** Screen-reader / spinner label only. Not the cancelled pending tip. */
export const ASK_PENDING_PREPARING_SR = "正在准备";
export const ASK_PENDING_TIMEOUT = "暂时没法提问，刷新页面后再试";
export const ASK_EMPTY_HIT = "没选中内容，换个地方试试";
export const ASK_RESIZE_HINT = "窗口大小变了，请重新圈选";
export const ASK_LAYER_HINT = "拖动画框，或点一下选中；双指可滚动";
export const ASK_ENTERED_STATUS = "已进入圈选，选中内容后提问";

export function ASK_WAITING_STATUS(n: number): string {
  return `老师在想…已等待 ${n} 秒`;
}

export const ASK_EXIT_LABEL = "退出圈选";
export const ASK_ENTRY_LABEL = "圈选提问";
export const ASK_SHORTCUT_SUBTITLE = "当前字幕";
export const ASK_SHORTCUT_STEP = "当前步骤";
export const ASK_SHORTCUT_VIZ = "可视化整块";

export const ASK_CHIPS = ["这一步在做什么？", "为什么这样写？", "换个例子讲讲"] as const;

export const ASK_REASON_TEXT: Record<AskDisabledReason, string> = {
  builtin: ASK_REASON_BUILTIN,
  receiving: ASK_REASON_RECEIVING,
  unfinished: ASK_REASON_UNFINISHED,
  stepDisabled: ASK_REASON_STEP_DISABLED,
  busy: ASK_REASON_BUSY,
};

/** Screenshot failure notice. Same string as capture.ts; do not fork the wording. */
export const ASK_CAPTURE_FALLBACK = CAPTURE_FALLBACK_NOTICE;

/** Shown the moment submit starts, before captureStage paints a frame. */
export const ASK_CAPTURE_PREPARING = "正在准备截图…";
