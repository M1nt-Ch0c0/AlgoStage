export interface CodeEditorHandle {
  getLineRangeForClientBox(top: number, bottom: number): { startLine: number; endLine: number } | null;
  getLinesText(startLine: number, endLine: number): string;
  getFullText(): string;
}

const registry = new Map<Element, CodeEditorHandle>();

export function registerCodeEditor(el: HTMLElement, handle: CodeEditorHandle): () => void {
  registry.set(el, handle);
  return () => {
    if (registry.get(el) === handle) {
      registry.delete(el);
    }
  };
}

export function getCodeEditorHandle(el: Element): CodeEditorHandle | undefined {
  let curr: Element | null = el;
  while (curr) {
    const handle = registry.get(curr);
    if (handle) return handle;
    curr = curr.parentElement;
  }
  return undefined;
}

let codeMissNotice: string | null = null;
const noticeListeners = new Set<() => void>();

export function setAskCodeMissNotice(text: string | null): void {
  if (codeMissNotice === text) return;
  codeMissNotice = text;
  for (const listener of noticeListeners) {
    listener();
  }
}

export function getAskCodeMissNotice(): string | null {
  return codeMissNotice;
}

export function subscribeAskCodeMissNotice(cb: () => void): () => void {
  noticeListeners.add(cb);
  return () => {
    noticeListeners.delete(cb);
  };
}

export function resetCodeEditorRegistry(): void {
  registry.clear();
  codeMissNotice = null;
  noticeListeners.clear();
}
