"use client";

import { useEffect, useState } from "react";

/**
 * `(pointer: coarse)` 是否匹配。服务端与首帧默认 false（细指针），
 * 挂载后再读 matchMedia，并监听后续变化。
 */
export function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(pointer: coarse)");
    setCoarse(mq.matches);
    const onChange = (event: MediaQueryListEvent) => setCoarse(event.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  return coarse;
}
