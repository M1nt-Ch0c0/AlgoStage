/**
 * 主题切换（Chalkboard Dark / Paper Light）
 * 本机 localStorage 记住选择，app/layout.tsx 的内联脚本在首帧前写入 data-theme，避免闪屏。
 * 设置页「保存」时也会写入 SQLite（与其它设置一起导出）。
 */
export type Theme = "dark" | "light";

export const THEME_STORAGE_KEY = "algostage-theme";

export function readTheme(): Theme {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

export function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // 隐私模式等场景无法写入：本次会话内仍然生效
  }
  window.dispatchEvent(new CustomEvent("algostage:theme", { detail: theme }));
}

/** 首帧前执行的内联脚本（字符串形式注入 <head>） */
export const THEME_BOOT_SCRIPT = `(function(){try{var t=localStorage.getItem("${THEME_STORAGE_KEY}");document.documentElement.dataset.theme=t==="light"?"light":"dark";}catch(e){}})();`;
