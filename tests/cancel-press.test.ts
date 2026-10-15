// @vitest-environment happy-dom
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  eventHitsAskCancel,
  listenCancelPress,
  pointHitsAskCancel,
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
});

describe("listenCancelPress", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  test("records pointerdown and pointerup on 取消 with event.timeStamp, and ignores other targets", () => {
    const cancel = button();
    const other = document.createElement("button");
    document.body.append(other);
    const onDown = vi.fn();
    const onUp = vi.fn();
    const onCancel = vi.fn();
    const stop = listenCancelPress(document, { onDown, onUp, onCancel });

    other.dispatchEvent(pointer("pointerdown", other, 10));
    cancel.dispatchEvent(pointer("pointerdown", cancel, 40));
    cancel.dispatchEvent(pointer("pointerup", cancel, 90));
    cancel.dispatchEvent(pointer("pointercancel", cancel, 91));

    expect(onDown).toHaveBeenCalledTimes(1);
    expect(onDown.mock.calls[0]?.[0].timeStamp).toBe(40);
    expect(onUp).toHaveBeenCalledTimes(1);
    expect(onUp.mock.calls[0]?.[0].timeStamp).toBe(90);
    expect(onCancel).toHaveBeenCalledTimes(1);

    stop();
    document.dispatchEvent(pointer("pointerdown", cancel, 120));
    expect(onDown).toHaveBeenCalledTimes(1);
  });
});
