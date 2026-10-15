"use client";

import { useRef, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";

type Point = { pointerId: number };

function primaryButton(event: ReactPointerEvent<HTMLButtonElement>): boolean {
  return event.button === 0 && event.isPrimary !== false;
}

function pointInside(target: HTMLButtonElement, x: number, y: number): boolean {
  const box = target.getBoundingClientRect();
  return x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
}

/**
 * Activate a button on pointer release only when the release point is still
 * inside the button. A move that leaves the button, or pointercancel, kills
 * the gesture. The click that follows a pointer activation is swallowed.
 * Keyboard activation (click with detail 0 from Enter or Space) runs once.
 */
export function usePointerActivate(action: () => void) {
  const origin = useRef<Point | null>(null);
  const armed = useRef(false);
  const suppressClick = useRef(false);
  const actionRef = useRef(action);
  actionRef.current = action;

  const clear = () => {
    origin.current = null;
    armed.current = false;
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!primaryButton(event)) return;
    origin.current = { pointerId: event.pointerId };
    armed.current = true;
    suppressClick.current = false;
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const start = origin.current;
    if (!start || !armed.current || event.pointerId !== start.pointerId) return;
    if (!pointInside(event.currentTarget, event.clientX, event.clientY)) clear();
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const start = origin.current;
    if (!start || !armed.current || event.pointerId !== start.pointerId) return;
    const inside = pointInside(event.currentTarget, event.clientX, event.clientY);
    clear();
    if (!inside) return;
    suppressClick.current = true;
    actionRef.current();
  };

  const onPointerCancel = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const start = origin.current;
    if (!start || event.pointerId !== start.pointerId) return;
    clear();
  };

  const onClick = (event: ReactMouseEvent<HTMLButtonElement>) => {
    if (suppressClick.current && event.detail > 0) {
      suppressClick.current = false;
      event.preventDefault();
      return;
    }
    suppressClick.current = false;
    if (event.detail !== 0) return;
    actionRef.current();
  };

  return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onClick };
}
