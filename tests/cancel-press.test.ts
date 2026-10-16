// @vitest-environment happy-dom
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  eventHitsAskCancel,
  listenCancelPress,
  pointHitsAskCancel,
  pressTargetsAskCancel,
  type CancelPressEvent,
} from "../lib/ask/cancel-press";

function button(): HTMLButtonElement {
  const el = document.createElement("button");
  el.setAttribute("data-ask-cancel", "");
  el.textContent = "取消";
  document.body.append(el);
  return el;
}

function pointer(type: string, target: EventTarget, timeStamp: number): PointerEvent {
  const event = new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    pointerId: 1,
    clientX: 4,
    clientY: 6,
  });
  Object.defineProperty(event, "timeStamp", { value: timeStamp });
  Object.defineProperty(event, "target", { configurable: true, value: target });
  return event;
}

describe("eventHitsAskCancel", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  test("matches the button and a child inside it, and ignores other targets", () => {
    const cancel = button();
    const child = document.createElement("span");
    cancel.append(child);
    const other = document.createElement("button");
    document.body.append(other);

    expect(eventHitsAskCancel(pointer("pointerdown", cancel, 1) as unknown as CancelPressEvent)).toBe(true);
    expect(eventHitsAskCancel(pointer("pointerdown", child, 2) as unknown as CancelPressEvent)).toBe(true);
    expect(eventHitsAskCancel(pointer("pointerdown", other, 3) as unknown as CancelPressEvent)).toBe(false);
  });

  test("pointHitsAskCancel is true only inside the button box", () => {
    const cancel = button();
    vi.spyOn(cancel, "getBoundingClientRect").mockReturnValue({
      x: 10,
      y: 20,
      left: 10,
      top: 20,
      right: 50,
      bottom: 40,
      width: 40,
      height: 20,
      toJSON() {
        return {};
      },
    });
    expect(pointHitsAskCancel(document, 12, 22)).toBe(true);
    expect(pointHitsAskCancel(document, 9, 22)).toBe(false);
    expect(pointHitsAskCancel(document, 12, 41)).toBe(false);
  });

  test("matches a composedPath entry when target itself is not the button", () => {
    const cancel = button();
    const event = {
      timeStamp: 1,
      button: 0,
      pointerId: 1,
      clientX: 0,
      clientY: 0,
      target: document.body,
      composedPath: () => [document.body, cancel],
    } satisfies CancelPressEvent;
    expect(eventHitsAskCancel(event)).toBe(true);
  });

  test("pressTargetsAskCancel is the target closest() check and ignores a path-only hit", () => {
    const cancel = button();
    const child = document.createElement("span");
    cancel.append(child);
    const other = document.createElement("button");
    document.body.append(other);

    expect(pressTargetsAskCancel(pointer("pointerdown", cancel, 1) as unknown as CancelPressEvent)).toBe(true);
    expect(pressTargetsAskCancel(pointer("pointerdown", child, 2) as unknown as CancelPressEvent)).toBe(true);
    expect(pressTargetsAskCancel(pointer("pointerdown", other, 3) as unknown as CancelPressEvent)).toBe(false);
    const pathOnly = {
      timeStamp: 4,
      button: 0,
      pointerId: 1,
      clientX: 0,
      clientY: 0,
      target: document.body,
      composedPath: () => [document.body, cancel],
    } satisfies CancelPressEvent;
    expect(pressTargetsAskCancel(pathOnly)).toBe(false);
    expect(pressTargetsAskCancel({ ...pathOnly, target: null })).toBe(false);
  });
});

describe("listenCancelPress", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  test("records pointerdown on 取消 with event.timeStamp and pointerId, and ignores other targets", () => {
    const cancel = button();
    const other = document.createElement("button");
    document.body.append(other);
    const onDown = vi.fn();
    const added: Array<{ type: string; capture: boolean; passive: boolean }> = [];
    const realAdd = document.addEventListener.bind(document);
    vi.spyOn(document, "addEventListener").mockImplementation((type, listener, options) => {
      const opts = typeof options === "object" && options != null ? options : { capture: options === true };
      if (type === "pointerdown" || type === "pointerup" || type === "pointercancel") {
        added.push({
          type,
          capture: opts.capture === true,
          passive: "passive" in opts && opts.passive === true,
        });
      }
      realAdd(type, listener as EventListener, options);
    });
    const stop = listenCancelPress(document, { onDown });

    expect(added).toEqual([{ type: "pointerdown", capture: true, passive: true }]);

    other.dispatchEvent(pointer("pointerdown", other, 10));
    const down = pointer("pointerdown", cancel, 40);
    cancel.dispatchEvent(down);
    cancel.dispatchEvent(pointer("pointerup", cancel, 90));
    cancel.dispatchEvent(pointer("pointercancel", cancel, 91));

    expect(onDown).toHaveBeenCalledTimes(1);
    expect(onDown.mock.calls[0]?.[0].timeStamp).toBe(40);
    expect(onDown.mock.calls[0]?.[0].pointerId).toBe(1);
    expect(down.defaultPrevented).toBe(false);

    stop();
    document.dispatchEvent(pointer("pointerdown", cancel, 120));
    expect(onDown).toHaveBeenCalledTimes(1);
  });

  test("with the listener attached, the button's pointerdown, pointerup, and click still fire", () => {
    const cancel = button();
    const fired: string[] = [];
    cancel.addEventListener("pointerdown", () => {
      fired.push("pointerdown");
    });
    cancel.addEventListener("pointerup", () => {
      fired.push("pointerup");
    });
    cancel.addEventListener("click", () => {
      fired.push("click");
    });

    let lastSeen: { timeStamp: number; pointerId: number; cancelHit: boolean } | null = null;
    const stop = listenCancelPress(document, {
      onDown: (event) => {
        // The production handler stores the hit and the pointerId.
        // timeStamp is kept for timing logs and is not the decision.
        lastSeen = {
          timeStamp: event.timeStamp,
          pointerId: event.pointerId,
          cancelHit: pressTargetsAskCancel(event),
        };
      },
    });

    const down = pointer("pointerdown", cancel, 40);
    const up = pointer("pointerup", cancel, 90);
    const click = pointer("click", cancel, 91);
    const preventDefault = vi.spyOn(down, "preventDefault");
    const stopPropagation = vi.spyOn(down, "stopPropagation");
    const setPointerCapture = vi.spyOn(cancel, "setPointerCapture");

    expect(cancel.dispatchEvent(down)).toBe(true);
    expect(cancel.dispatchEvent(up)).toBe(true);
    expect(cancel.dispatchEvent(click)).toBe(true);

    expect(fired).toEqual(["pointerdown", "pointerup", "click"]);
    expect(down.defaultPrevented).toBe(false);
    expect(up.defaultPrevented).toBe(false);
    expect(click.defaultPrevented).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(stopPropagation).not.toHaveBeenCalled();
    expect(setPointerCapture).not.toHaveBeenCalled();
    expect(lastSeen).toEqual({ timeStamp: 40, pointerId: 1, cancelHit: true });

    stop();
  });
});
