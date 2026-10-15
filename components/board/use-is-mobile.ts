"use client";

import { useEffect, useState } from "react";

/**
 * `(max-width: 639px)` 是否匹配。服务端默认 false。
 * 客户端首帧即时读取 matchMedia，并监听后续变化。
 */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
    return window.matchMedia("(max-width: 639px)").matches;
  });

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(max-width: 639px)");
    setIsMobile(mq.matches);
    const onChange = (event: MediaQueryListEvent) => setIsMobile(event.matches);
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);

  return isMobile;
}
