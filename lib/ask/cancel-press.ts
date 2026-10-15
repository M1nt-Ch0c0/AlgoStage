/**
 * Capture-phase pointer listeners for 取消, attached before capture starts.
 * A press whose event.timeStamp falls anywhere in [captureStart, sentAt]
 * is recorded even when the event is delivered after the hold wait resolves.
 * The button's own handlers stay; this only feeds the hold and retro-cancel.
 */

export const ASK_CANCEL_SELECTOR = "[data-ask-cancel]";

export type CancelPressEvent = {
  timeStamp: number;
  button: number;
  pointerId: number;
  clientX: number;
  clientY: number;
  target: EventTarget | null;
  composedPath?: () => EventTarget[];
};

export type CancelPressHandlers = {
  onDown: (event: CancelPressEvent) => void;
  onUp: (event: CancelPressEvent) => void;
  onCancel: (event: CancelPressEvent) => void;
};

type Listened = Pick<Document, "addEventListener" | "removeEventListener">;

function pathOf(event: CancelPressEvent): EventTarget[] {
  const nodes: EventTarget[] = [];
  if (typeof event.composedPath === "function") {
    try {
      nodes.push(...event.composedPath());
    } catch {
      // A synthetic event can throw. Target is still checked below.
    }
  }
  if (event.target != null && !nodes.includes(event.target)) nodes.push(event.target);
  return nodes;
}

/** True when the point is inside the live 取消 button. A missing button is outside. */
export function pointHitsAskCancel(doc: Document, clientX: number, clientY: number): boolean {
  const button = doc.querySelector<HTMLElement>(ASK_CANCEL_SELECTOR);
  if (!button) return false;
  const box = button.getBoundingClientRect();
  return clientX >= box.left && clientX <= box.right && clientY >= box.top && clientY <= box.bottom;
}

/** True when the event hit the 取消 button, including a shadow-DOM path. */
export function eventHitsAskCancel(event: CancelPressEvent): boolean {
  for (const node of pathOf(event)) {
    if (!(node instanceof Element)) continue;
    if (node.matches(ASK_CANCEL_SELECTOR)) return true;
    if (node.closest(ASK_CANCEL_SELECTOR) !== null) return true;
  }
  return false;
}

/**
 * Listen in the capture phase so a press is seen before React's bubble
 * handlers, and before a late listener on the button itself is attached.
 * Returns the remover. Calling it twice is safe.
 */
export function listenCancelPress(doc: Listened, handlers: CancelPressHandlers): () => void {
  let removed = false;

  const onDown = (event: Event) => {
    const pointer = event as unknown as CancelPressEvent;
    if (!eventHitsAskCancel(pointer)) return;
    handlers.onDown(pointer);
  };
  const onUp = (event: Event) => {
    const pointer = event as unknown as CancelPressEvent;
    if (!eventHitsAskCancel(pointer)) return;
    handlers.onUp(pointer);
  };
  const onCancel = (event: Event) => {
    const pointer = event as unknown as CancelPressEvent;
    if (!eventHitsAskCancel(pointer)) return;
    handlers.onCancel(pointer);
  };

  doc.addEventListener("pointerdown", onDown, true);
  doc.addEventListener("pointerup", onUp, true);
  doc.addEventListener("pointercancel", onCancel, true);

  return () => {
    if (removed) return;
    removed = true;
    doc.removeEventListener("pointerdown", onDown, true);
    doc.removeEventListener("pointerup", onUp, true);
    doc.removeEventListener("pointercancel", onCancel, true);
  };
}
