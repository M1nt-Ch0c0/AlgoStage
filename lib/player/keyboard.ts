/** 焦点在输入控件、可编辑区或 Monaco 内时不抢快捷键（happy-dom 未必实现 isContentEditable）。 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  return (
    target.closest('[contenteditable=""],[contenteditable="true"],.monaco-editor') !== null
  );
}
