/**
 * Capture-phase pointerdown listener for 取消, attached before capture starts.
 * It records a cancel flag when the press target is inside [data-ask-cancel]
 * (`(event.target as Element | null)?.closest?.('[data-ask-cancel]')`), plus
 * the pointerId. event.timeStamp is kept for timing logs only and is not the
 * cancel decision. It does not stop the event, prevent its default, or
 * capture the pointer. The button's own pointerdown, pointer capture,
 * data-pressed, pointerup, and slide-off handling run unchanged and own the
 * hold: release on the button cancels, a slide-off sends.
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
};

type Listened = Pick<Document, "addEventListener" | "removeEventListener">;

/** Capture-phase, passive. Never stopPropagation, preventDefault, or setPointerCapture. */
const LISTEN_OPTIONS: AddEventListenerOptions = { capture: true, passive: true };

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
 * The cancel decision. A press counts only when its target is an element
 * inside [data-ask-cancel]. A non-element target, or a target outside the
 * button, is not a cancel. composedPath is not consulted: a press that only
 * reaches the button through a shadow path is not this flag.
 */
export function pressTargetsAskCancel(event: CancelPressEvent): boolean {
  const target = event.target as Element | null;
  return target?.closest?.(ASK_CANCEL_SELECTOR) != null;
}

/**
 * Listen for pointerdown in the capture phase so a press queued during the
 * capture long task is recorded as a hit on 取消 before encode and fetch.
 * Records only. Returns the remover. Calling it twice is safe.
 */
export function listenCancelPress(doc: Listened, handlers: CancelPressHandlers): () => void {
  let removed = false;

  const onDown = (event: Event) => {
    const pointer = event as unknown as CancelPressEvent;
    if (!pressTargetsAskCancel(pointer)) return;
    handlers.onDown(pointer);
  };

  doc.addEventListener("pointerdown", onDown, LISTEN_OPTIONS);

  return () => {
    if (removed) return;
    removed = true;
    doc.removeEventListener("pointerdown", onDown, LISTEN_OPTIONS);
  };
}
