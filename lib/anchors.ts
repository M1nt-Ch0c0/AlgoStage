/**
 * EffectTarget → 屏幕坐标 解析器（docs/02 §3.2、docs/03 §2）
 * 特效组件不关心目标来源，统一从这里拿坐标。
 */
import type { EffectTarget } from "@/lib/teaching/types";

export interface ResolvedAnchor {
  /** 屏幕坐标（viewport 坐标系，供 fixed 定位的 EffectStage 使用） */
  rect: DOMRect;
}

/** Monaco 黑板注册的行坐标查询函数：输入 1-based 行号区间，返回覆盖该区间的 rect */
export type CodeLineResolver = (
  start: number,
  end: number,
) => DOMRect | null;

let codeLineResolver: CodeLineResolver | null = null;

/** 由 CodeEditor 挂载时调用 */
export function registerCodeLineResolver(resolver: CodeLineResolver | null) {
  codeLineResolver = resolver;
}

/** 惰性构造：模块可能在 SSR（无 DOM）环境加载 */
function fallbackRect(): DOMRect {
  return typeof DOMRect === "undefined"
    ? ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 } as DOMRect)
    : new DOMRect(0, 0, 0, 0);
}

export function resolveAnchor(target: EffectTarget): DOMRect {
  switch (target.kind) {
    case "code-line": {
      const rect = codeLineResolver?.(target.start, target.end ?? target.start);
      return rect ?? fallbackRect();
    }
    case "code-token": {
      // 一期简化为整行锚点；token 级定位（Monaco 查 match 列区间）二期实现
      const rect = codeLineResolver?.(target.line, target.line);
      return rect ?? fallbackRect();
    }
    case "statement": {
      const el = document.querySelector(`[data-statement="${target.blockId}"]`);
      return el?.getBoundingClientRect() ?? fallbackRect();
    }
    case "viz-node": {
      const el = document.querySelector(`[data-viz-node="${target.nodeId}"]`);
      return el?.getBoundingClientRect() ?? fallbackRect();
    }
    case "dom": {
      const el = document.querySelector(target.selector);
      return el?.getBoundingClientRect() ?? fallbackRect();
    }
  }
}
