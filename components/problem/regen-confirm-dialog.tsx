"use client";

import { type RefObject, useEffect, useId, useRef } from "react";

export interface RegenConfirmDialogProps {
  open: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
  fallbackFocusRef?: RefObject<HTMLElement | null>;
  /** 大于 0 时在确认文案后追加「你问过的 N 个问题会被清掉」。 */
  answerCount?: number;
}

function isFocusable(el: HTMLElement | null): boolean {
  if (!el || !el.isConnected) return false;
  if (el.tagName === "BODY") return false;
  if ("disabled" in el && Boolean((el as { disabled?: boolean }).disabled)) return false;
  if (el.hasAttribute("disabled")) return false;
  if (el.getAttribute("aria-disabled") === "true") return false;
  if (el.hidden || el.style.display === "none" || el.style.visibility === "hidden") return false;
  if (el.textContent?.includes("备课中")) return false;
  if (typeof el.checkVisibility === "function" && !el.checkVisibility()) return false;
  try {
    const rects = el.getClientRects();
    if (rects.length === 0) return false;
  } catch {
    // ignore
  }
  return true;
}

export function RegenConfirmDialog({
  open,
  onCancel,
  onConfirm,
  returnFocusRef,
  fallbackFocusRef,
  answerCount = 0,
}: RegenConfirmDialogProps) {
  const titleId = useId();
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;
  const closeReasonRef = useRef<"cancel" | "confirm" | null>(null);

  useEffect(() => {
    const triggerRefObj = returnFocusRef;
    const fallbackRefObj = fallbackFocusRef;
    if (!open) {
      closeReasonRef.current = null;
      return;
    }
    closeReasonRef.current = null;
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const returnFocusTarget = returnFocusRef?.current ?? previousFocus;
    cancelRef.current?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeReasonRef.current = "cancel";
        onCancelRef.current();
        return;
      }
      if (e.key === "Tab") {
        const buttons = [cancelRef.current, confirmRef.current].filter(
          (b): b is HTMLButtonElement => Boolean(b),
        );
        if (buttons.length === 0) return;
        e.preventDefault();
        const current = document.activeElement as HTMLButtonElement | null;
        const idx = current ? buttons.indexOf(current) : -1;
        if (e.shiftKey) {
          const prevIdx = idx <= 0 ? buttons.length - 1 : idx - 1;
          buttons[prevIdx]?.focus();
        } else {
          const nextIdx = idx === -1 || idx === buttons.length - 1 ? 0 : idx + 1;
          buttons[nextIdx]?.focus();
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      const isConfirm = closeReasonRef.current === "confirm";
      closeReasonRef.current = null;

      if (!isConfirm) {
        returnFocusTarget?.focus();
      } else {
        const defer =
          typeof window !== "undefined" && typeof window.requestAnimationFrame === "function"
            ? window.requestAnimationFrame
            : (fn: () => void) => setTimeout(fn, 0);

        defer(() => {
          const trigger = triggerRefObj?.current ?? returnFocusTarget;
          if (trigger && isFocusable(trigger)) {
            trigger.focus();
          } else {
            fallbackRefObj?.current?.focus();
          }
        });
      }
    };
  }, [open, returnFocusRef, fallbackFocusRef]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4"
    >
      <div className="flex max-w-sm flex-col gap-3 rounded-2xl border border-board-600 bg-board-900 p-4 text-sm text-chalk-100">
        <p id={titleId}>
          {answerCount > 0
            ? `重新生成会清掉当前教案，确定吗？你问过的 ${answerCount} 个问题会被清掉`
            : "重新生成会清掉当前教案，确定吗？"}
        </p>
        <div className="flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={() => {
              closeReasonRef.current = "cancel";
              onCancel();
            }}
            className="rounded-full border border-board-600 px-3 py-1.5 text-chalk-300 hover:text-chalk-100"
          >
            取消
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={() => {
              closeReasonRef.current = "confirm";
              onConfirm();
            }}
            className="rounded-full bg-beam-gold px-3 py-1.5 font-semibold text-on-accent"
          >
            确定重新生成
          </button>
        </div>
      </div>
    </div>
  );
}

export default RegenConfirmDialog;
