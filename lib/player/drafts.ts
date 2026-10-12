/** 每个浏览器标签页独立保存草稿，按题目与语言隔离；参考代码更新不能覆盖草稿。 */
type Language = "typescript" | "python";
const prefix = "algostage:draft:v1:";
const fallback = new Map<string, string>();
function read(key: string): string | null {
  if (fallback.has(key)) return fallback.get(key)!;
  try { return typeof window === "undefined" ? null : window.sessionStorage.getItem(key); }
  catch { return null; }
}
function write(key: string, value: string) {
  try {
    if (typeof window === "undefined") return;
    window.sessionStorage.setItem(key, value);
    fallback.delete(key);
  } catch { fallback.set(key, value); }
}
export function readDraft(slug: string, language: Language) {
  return read(`${prefix}${slug}:${language}`);
}
export function draftLanguage(slug: string): Language {
  return read(`${prefix}${slug}:language`) === "python" ? "python" : "typescript";
}
export function saveDraft(slug: string, language: Language, code: string) {
  write(`${prefix}${slug}:${language}`, code);
  write(`${prefix}${slug}:language`, language);
}
