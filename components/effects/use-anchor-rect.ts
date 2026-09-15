/**
 * 锚点响应式解析：EffectTarget → viewport DOMRect。
 * 监听窗口 resize / 滚动 / Monaco 内部滚动（'algostage:anchor-refresh' 自定义事件，
 * 由 CodeEditor 在 onDidScrollChange 时派发）重新解析。
 *
 * 注意：lib/anchors 模块顶层实例化 DOMRect（浏览器专属），
 * 因此这里动态 import，保证 SSR 期间不加载该模块。
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { EffectTarget } from "@/lib/teaching/types";

export const ANCHOR_REFRESH_EVENT = "algostage:anchor-refresh";

type AnchorsModule = typeof import("@/lib/anchors");

export function useAnchorRect(target: EffectTarget): DOMRect | null {
  const [rect, setRect] = useState<DOMRect | null>(null);
  const modRef = useRef<AnchorsModule | null>(null);

  const resolve = useCallback(() => {
    const m = modRef.current;
    if (!m) return;
    const r = m.resolveAnchor(target);
    // 未命中的锚点是 0 尺寸 fallback，视为 null（特效容错不渲染）
    setRect(r.width === 0 && r.height === 0 ? null : r);
    // target 是每次渲染新对象，用其序列化值做依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(target)]);

  useEffect(() => {
    let alive = true;
    import("@/lib/anchors").then((m) => {
      if (!alive) return;
      modRef.current = m;
      resolve();
    });
    // 首帧布局可能未就绪，下一帧再解析一次
    const raf = requestAnimationFrame(resolve);
    window.addEventListener("resize", resolve);
    window.addEventListener("scroll", resolve, true);
    window.addEventListener(ANCHOR_REFRESH_EVENT, resolve);
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resolve);
      window.removeEventListener("scroll", resolve, true);
      window.removeEventListener(ANCHOR_REFRESH_EVENT, resolve);
    };
  }, [resolve]);

  return rect;
}
