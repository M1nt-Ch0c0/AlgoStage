// @vitest-environment happy-dom
import { act, createElement, type MouseEvent as ReactMouseEvent, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { usePointerActivate } from "../lib/ask/use-pointer-activate";

let root: Root;
let container: HTMLDivElement;

function Harness({ onActivate }: { onActivate: () => void }) {
  const handlers = usePointerActivate(onActivate);
  const [label, setLabel] = useState("idle");
  return createElement(
    "button",
    {
      type: "button",
      "data-activate": "",
      onPointerDown: handlers.onPointerDown,
      onPointerMove: handlers.onPointerMove,
      onPointerUp: handlers.onPointerUp,
      onPointerCancel: handlers.onPointerCancel,
      onClick: (event: ReactMouseEvent<HTMLButtonElement>) => {
        handlers.onClick(event);
        setLabel("clicked");
      },
    },
    label,
  );
}

function button(): HTMLButtonElement {
  const el = container.querySelector<HTMLButtonElement>("[data-activate]");
  if (!el) throw new Error("button missing");
  return el;
}

function pointer(
  type: string,
  init: PointerEventInit & { clientX?: number; clientY?: number },
) {
  return new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, isPrimary: true, ...init });
}

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
  vi.restoreAllMocks();
});

async function mount(onActivate: () => void) {
  await act(async () => {
    root.render(createElement(Harness, { onActivate }));
  });
}

describe("usePointerActivate", () => {
  test("pointerdown then pointerup inside activates once, and the following click does not", async () => {
    const action = vi.fn();
    await mount(action);
    const el = button();
    vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 40,
      bottom: 20,
      width: 40,
      height: 20,
      toJSON() {
        return {};
      },
    });

    await act(async () => {
      el.dispatchEvent(pointer("pointerdown", { pointerId: 1, clientX: 10, clientY: 8 }));
      el.dispatchEvent(pointer("pointerup", { pointerId: 1, clientX: 12, clientY: 9 }));
    });
    expect(action).toHaveBeenCalledTimes(1);

    await act(async () => {
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
    });
    expect(action).toHaveBeenCalledTimes(1);
  });

  test("a drag past 10px does not activate", async () => {
    const action = vi.fn();
    await mount(action);
    const el = button();
    vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 80,
      bottom: 40,
      width: 80,
      height: 40,
      toJSON() {
        return {};
      },
    });

    await act(async () => {
      el.dispatchEvent(pointer("pointerdown", { pointerId: 1, clientX: 10, clientY: 10 }));
      el.dispatchEvent(pointer("pointermove", { pointerId: 1, clientX: 10, clientY: 22 }));
      el.dispatchEvent(pointer("pointerup", { pointerId: 1, clientX: 10, clientY: 22 }));
    });
    expect(action).toHaveBeenCalledTimes(0);
  });

  test("pointerup outside the button does not activate", async () => {
    const action = vi.fn();
    await mount(action);
    const el = button();
    vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 40,
      bottom: 20,
      width: 40,
      height: 20,
      toJSON() {
        return {};
      },
    });

    await act(async () => {
      el.dispatchEvent(pointer("pointerdown", { pointerId: 1, clientX: 10, clientY: 18 }));
      el.dispatchEvent(pointer("pointerup", { pointerId: 1, clientX: 10, clientY: 22 }));
    });
    expect(action).toHaveBeenCalledTimes(0);
  });

  test("pointercancel does not activate", async () => {
    const action = vi.fn();
    await mount(action);
    const el = button();

    await act(async () => {
      el.dispatchEvent(pointer("pointerdown", { pointerId: 1, clientX: 10, clientY: 8 }));
      el.dispatchEvent(pointer("pointercancel", { pointerId: 1, clientX: 10, clientY: 8 }));
      el.dispatchEvent(pointer("pointerup", { pointerId: 1, clientX: 10, clientY: 8 }));
    });
    expect(action).toHaveBeenCalledTimes(0);
  });

  test("a keyboard click with detail 0 activates once", async () => {
    const action = vi.fn();
    await mount(action);
    const el = button();

    await act(async () => {
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 0 }));
    });
    expect(action).toHaveBeenCalledTimes(1);
  });
});
