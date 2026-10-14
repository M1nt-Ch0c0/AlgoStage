import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CAPTURE_FALLBACK_NOTICE } from "@/lib/ask/capture";
import {
  ASK_CAPTURE_FALLBACK,
  ASK_CHIPS,
  ASK_CODE_MISS_HINT,
  ASK_EMPTY_HIT,
  ASK_ENTERED_STATUS,
  ASK_ENTRY_LABEL,
  ASK_EXIT_LABEL,
  ASK_LAYER_HINT,
  ASK_PENDING_PREPARING_SR,
  ASK_PENDING_TIMEOUT,
  ASK_REASON_BUSY,
  ASK_REASON_BUILTIN,
  ASK_REASON_RECEIVING,
  ASK_REASON_STEP_DISABLED,
  ASK_REASON_TEXT,
  ASK_REASON_UNFINISHED,
  ASK_RESIZE_HINT,
  ASK_SHORTCUT_STEP,
  ASK_SHORTCUT_SUBTITLE,
  ASK_SHORTCUT_VIZ,
  ASK_WAITING_STATUS,
} from "@/lib/ask/ask-ui-text";
import type { AskDisabledReason } from "@/lib/player/store";

const CANCELLED_PENDING = "正在准备，请稍候";

describe("ask-ui-text", () => {
  it("disabled reasons match the locked copy", () => {
    expect(ASK_REASON_BUILTIN).toBe("生成讲课后就可以提问");
    expect(ASK_REASON_RECEIVING).toBe("备课完成后可以提问");
    expect(ASK_REASON_UNFINISHED).toBe("这节课没讲完，重新生成后就可以提问");
    expect(ASK_REASON_STEP_DISABLED).toBe("这一步暂时不能提问，重新生成这节课后就可以了");
    expect(ASK_REASON_BUSY).toBe("上一个问题还在回答，答完再问");
  });

  it("ASK_REASON_TEXT covers all five AskDisabledReason keys", () => {
    const keys: AskDisabledReason[] = ["builtin", "receiving", "unfinished", "stepDisabled", "busy"];
    expect(Object.keys(ASK_REASON_TEXT).sort()).toEqual([...keys].sort());
    expect(ASK_REASON_TEXT.builtin).toBe(ASK_REASON_BUILTIN);
    expect(ASK_REASON_TEXT.receiving).toBe(ASK_REASON_RECEIVING);
    expect(ASK_REASON_TEXT.unfinished).toBe(ASK_REASON_UNFINISHED);
    expect(ASK_REASON_TEXT.stepDisabled).toBe(ASK_REASON_STEP_DISABLED);
    expect(ASK_REASON_TEXT.busy).toBe(ASK_REASON_BUSY);
  });

  it("pending, empty, and resize strings are exact", () => {
    expect(ASK_PENDING_PREPARING_SR).toBe("正在准备");
    expect(ASK_PENDING_TIMEOUT).toBe("暂时没法提问，刷新页面后再试");
    expect(ASK_EMPTY_HIT).toBe("没选中内容，换个地方试试");
    expect(ASK_CODE_MISS_HINT).toBe("代码部分没选上，换个地方再框一次");
    expect(ASK_RESIZE_HINT).toBe("窗口大小变了，请重新圈选");
    expect(ASK_LAYER_HINT).toBe("拖动画框，或点一下选中；双指可滚动");
    expect(ASK_ENTERED_STATUS).toBe("已进入圈选，选中内容后提问");
    expect(ASK_WAITING_STATUS(0)).toBe("老师在想…已等待 0 秒");
    expect(ASK_WAITING_STATUS(12)).toBe("老师在想…已等待 12 秒");
    expect(ASK_EXIT_LABEL).toBe("退出圈选");
    expect(ASK_ENTRY_LABEL).toBe("圈选提问");
    expect(ASK_SHORTCUT_SUBTITLE).toBe("当前字幕");
    expect(ASK_SHORTCUT_STEP).toBe("当前步骤");
    expect(ASK_SHORTCUT_VIZ).toBe("可视化整块");
    expect(ASK_CHIPS).toEqual(["这一步在做什么？", "为什么这样写？", "换个例子讲讲"]);
  });

  it("re-exports the capture fallback notice", () => {
    expect(ASK_CAPTURE_FALLBACK).toBe(CAPTURE_FALLBACK_NOTICE);
    expect(ASK_CAPTURE_FALLBACK).toBe("没截到图，这次只发送选中的文字。");
  });

  it("does not contain the cancelled pending phrase", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, "../lib/ask/ask-ui-text.ts"), "utf8");
    expect(source.includes(CANCELLED_PENDING)).toBe(false);
    const values = [
      ASK_REASON_BUILTIN,
      ASK_REASON_RECEIVING,
      ASK_REASON_UNFINISHED,
      ASK_REASON_STEP_DISABLED,
      ASK_REASON_BUSY,
      ASK_PENDING_PREPARING_SR,
      ASK_PENDING_TIMEOUT,
      ASK_EMPTY_HIT,
      ASK_CODE_MISS_HINT,
      ASK_RESIZE_HINT,
      ASK_LAYER_HINT,
      ASK_ENTERED_STATUS,
      ASK_WAITING_STATUS(3),
      ASK_EXIT_LABEL,
      ASK_ENTRY_LABEL,
      ASK_SHORTCUT_SUBTITLE,
      ASK_SHORTCUT_STEP,
      ASK_SHORTCUT_VIZ,
      ...ASK_CHIPS,
      ...Object.values(ASK_REASON_TEXT),
      ASK_CAPTURE_FALLBACK,
    ];
    for (const value of values) {
      expect(value.includes(CANCELLED_PENDING)).toBe(false);
    }
    expect(values.join("\n").includes("回到这一步")).toBe(false);
  });
});
