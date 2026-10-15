"use client";

import { useRef, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";

const MOVE_THRESHOLD_PX = 10;

type Point = { pointerId: number; x: number; y: number };

function primaryButton(event: ReactPointerEvent<HTMLButtonElement>): boolean {
  return event.button === 0 && event.isPrimary !== false;
}

function movedPast(from: Point, x: number, y: number): boolean {
  return Math.hypot(x - from.x, y - from.y) > MOVE_THRESHOLD_PX;
}

function pointInside(target: HTMLButtonElement, x: number, y: number): boolean {
  const box = target.getBoundingClientRect();
  return x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
}

/**
 * Activate a button on pointer release inside the control, not on click.
 * A following click from the same gesture is ignored. Keyboard activation
 * (click with detail 0) still runs. Touch scroll that fires pointercancel,
 * or a move past 10px, drops the gesture.
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
    origin.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    armed.current = true;
    suppressClick.current = false;
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const start = origin.current;
    if (!start || !armed.current || event.pointerId !== start.pointerId) return;
    if (movedPast(start, event.clientX, event.clientY)) clear();
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const start = origin.current;
    if (!start || !armed.current || event.pointerId !== start.pointerId) return;
    const inside = pointInside(event.currentTarget, event.clientX, event.clientY);
    const stayed = !movedPast(start, event.clientX, event.clientY);
    clear();
    if (!inside || !stayed) return;
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
