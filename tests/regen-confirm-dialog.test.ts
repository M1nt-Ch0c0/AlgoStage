// @vitest-environment happy-dom
import { act, createElement, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import RegenConfirmDialog from "../components/problem/regen-confirm-dialog";

let root: Root, container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

test("弹窗打开时初始聚焦取消、Tab 循环焦点、Escape 关闭并恢复焦点到触发按钮、Space 不被阻止默认行为", async () => {
  const onCancelSpy = vi.fn();
  const onConfirmSpy = vi.fn();

  function Harness() {
    const [open, setOpen] = useState(true);
    const triggerRef = useRef<HTMLButtonElement | null>(null);
    return createElement(
      "div",
      null,
      createElement("button", { ref: triggerRef, type: "button" }, "更多"),
      createElement(RegenConfirmDialog, {
        open,
        onCancel: () => {
          onCancelSpy();
          setOpen(false);
        },
        onConfirm: onConfirmSpy,
        returnFocusRef: triggerRef,
      }),
    );
  }

  await act(async () => {
    root.render(createElement(Harness));
  });

  const dialog = container.querySelector('[role="dialog"][aria-modal="true"]');
  expect(dialog).not.toBeNull();
  const labelledBy = dialog?.getAttribute("aria-labelledby");
  expect(labelledBy).toBeTruthy();
  expect(document.getElementById(labelledBy!)?.textContent).toBe("重新生成会清掉当前教案，确定吗？");

  const buttons = Array.from(dialog!.querySelectorAll("button"));
  const cancelBtn = buttons.find((b) => b.textContent === "取消")!;
  const confirmBtn = buttons.find((b) => b.textContent === "确定重新生成")!;
  const triggerBtn = Array.from(container.querySelectorAll("button")).find(
    (b) => b.textContent === "更多",
  )!;

  // Initial focus on 取消
  expect(document.activeElement).toBe(cancelBtn);

  // Space keydown on 取消 is not defaultPrevented
  let spaceEvent!: KeyboardEvent;
  await act(async () => {
    spaceEvent = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
    cancelBtn.dispatchEvent(spaceEvent);
  });
  expect(spaceEvent.defaultPrevented).toBe(false);

  // Tab wraps between 取消 and 确定重新生成
  await act(async () => {
    cancelBtn.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
  });
  expect(document.activeElement).toBe(confirmBtn);

  await act(async () => {
    confirmBtn.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
  });
  expect(document.activeElement).toBe(cancelBtn);

  await act(async () => {
    cancelBtn.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }),
    );
  });
  expect(document.activeElement).toBe(confirmBtn);

  // Escape calls onCancel and returns focus to trigger
  await act(async () => {
    confirmBtn.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
  });
  expect(onCancelSpy).toHaveBeenCalledTimes(1);
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(triggerBtn);
});

test("trigger removed/hidden after confirm -> focus lands on fallback element (aria-label 讲解播放区), not body", async () => {
  const onConfirmSpy = vi.fn();

  function RemoveHarness() {
    const [open, setOpen] = useState(true);
    const [triggerMounted, setTriggerMounted] = useState(true);
    const triggerRef = useRef<HTMLButtonElement | null>(null);
    const fallbackRef = useRef<HTMLDivElement | null>(null);

    return createElement(
      "div",
      null,
      triggerMounted
        ? createElement("button", { ref: triggerRef, type: "button" }, "更多")
        : null,
      createElement(
        "div",
        {
          ref: fallbackRef,
          tabIndex: -1,
          "aria-label": "讲解播放区",
        },
        "播放器控制条",
      ),
      createElement(RegenConfirmDialog, {
        open,
        onCancel: () => setOpen(false),
        onConfirm: () => {
          onConfirmSpy();
          setTriggerMounted(false);
          setOpen(false);
        },
        returnFocusRef: triggerRef,
        fallbackFocusRef: fallbackRef,
      }),
    );
  }

  await act(async () => {
    root.render(createElement(RemoveHarness));
  });

  const dialog1 = container.querySelector('[role="dialog"][aria-modal="true"]');
  expect(dialog1).not.toBeNull();
  const confirmBtn1 = Array.from(dialog1!.querySelectorAll("button")).find(
    (b) => b.textContent === "确定重新生成",
  )!;

  await act(async () => {
    confirmBtn1.click();
  });

  expect(onConfirmSpy).toHaveBeenCalledTimes(1);
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  const fallbackEl1 = container.querySelector('[aria-label="讲解播放区"]');
  expect(fallbackEl1).not.toBeNull();
  expect(document.activeElement).toBe(fallbackEl1);
  expect((document.activeElement as HTMLElement).getAttribute("aria-label")).toBe("讲解播放区");
  expect(document.activeElement).not.toBe(document.body);

  function HiddenHarness() {
    const [open, setOpen] = useState(true);
    const [hidden, setHidden] = useState(false);
    const triggerRef = useRef<HTMLButtonElement | null>(null);
    const fallbackRef = useRef<HTMLDivElement | null>(null);

    return createElement(
      "div",
      null,
      createElement(
        "button",
        {
          ref: triggerRef,
          type: "button",
          style: hidden ? { display: "none" } : undefined,
        },
        "更多",
      ),
      createElement(
        "div",
        {
          ref: fallbackRef,
          tabIndex: -1,
          "aria-label": "讲解播放区",
        },
        "播放器控制条",
      ),
      createElement(RegenConfirmDialog, {
        open,
        onCancel: () => setOpen(false),
        onConfirm: () => {
          setHidden(true);
          setOpen(false);
        },
        returnFocusRef: triggerRef,
        fallbackFocusRef: fallbackRef,
      }),
    );
  }

  await act(async () => {
    root.render(createElement(HiddenHarness));
  });

  const dialog2 = container.querySelector('[role="dialog"][aria-modal="true"]');
  expect(dialog2).not.toBeNull();
  const confirmBtn2 = Array.from(dialog2!.querySelectorAll("button")).find(
    (b) => b.textContent === "确定重新生成",
  )!;

  await act(async () => {
    confirmBtn2.click();
  });

  expect(container.querySelector('[role="dialog"]')).toBeNull();
  const fallbackEl2 = container.querySelector('[aria-label="讲解播放区"]');
  expect(fallbackEl2).not.toBeNull();
  expect(document.activeElement).toBe(fallbackEl2);
  expect((document.activeElement as HTMLElement).getAttribute("aria-label")).toBe("讲解播放区");
  expect(document.activeElement).not.toBe(document.body);

  const { readFileSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  const pageSource = readFileSync(
    resolve(process.cwd(), "app/problem/[slug]/page.tsx"),
    "utf8",
  );
  expect(pageSource).toContain('aria-label="讲解播放区"');
  expect(pageSource).not.toMatch(/aria-label=\{[^}]*讲解播放区/);
});

