/**
 * ArrayVisualizer · 数组可视化器（docs/02 §4.10，VizFrame.type === 'array'）
 * 纯函数组件 state → SVG，所有位置/颜色变化走 motion spring；
 * highlight 格子发光；scan/指针是上方悬浮小旗标（VizFrame.captions），
 * spring 的自然过冲带来惯性摆动。节点带 data-viz-node="a{index}" 供锚点解析。
 */
"use client";

import { AnimatePresence, motion } from "motion/react";
import type { VizFrame } from "@/lib/teaching/types";

export interface ArrayVizState {
  values: number[];
  highlight?: number[];
  map?: Record<string, number>;
  scan?: number;
  hit?: boolean;
}

const CELL = 48;
const GAP = 8;
const STRIDE = CELL + GAP;
const PAD = 12;
const FLAG_H = 26;

const SPRING = { type: "spring", stiffness: 300, damping: 24 } as const;

function flagIndex(nodeId: string): number | null {
  const m = /^a(\d+)$/.exec(nodeId);
  return m ? Number(m[1]) : null;
}

export default function ArrayVisualizer({ frame }: { frame?: VizFrame }) {
  if (!frame || frame.type !== "array") return null;
  const state = (frame.state ?? {}) as Partial<ArrayVizState>;
  const values = state.values ?? [];
  const highlight = new Set(state.highlight ?? []);
  const scan = state.scan ?? -1;
  const hit = state.hit === true;
  const mapEntries = Object.entries(state.map ?? {});
  const captions = frame.captions ?? [];

  const glowColor = hit ? "var(--color-beam-mint)" : "var(--color-beam-gold)";
  const svgW = values.length * STRIDE - GAP + PAD * 2;
  const svgH = CELL + PAD * 2 + FLAG_H;

  return (
    <div className="flex flex-wrap items-start gap-4">
      <svg
        width={svgW}
        height={svgH}
        className="overflow-visible"
        role="img"
        aria-label="数组可视化"
      >
        {/* 格子 */}
        {values.map((v, i) => {
          const on = highlight.has(i);
          const scanned = i === scan;
          return (
            <motion.g
              key={i}
              data-viz-node={`a${i}`}
              initial={false}
              animate={{ x: PAD + i * STRIDE, y: PAD + FLAG_H }}
              transition={SPRING}
            >
              <motion.rect
                width={CELL}
                height={CELL}
                rx={8}
                initial={{
                  fill: "var(--color-board-800)",
                  stroke: "var(--color-board-600)",
                }}
                animate={{
                  fill: on
                    ? `color-mix(in srgb, ${glowColor} 22%, var(--color-board-800))`
                    : "var(--color-board-800)",
                  stroke: on ? glowColor : scanned ? "var(--color-beam-cyan)" : "var(--color-board-600)",
                }}
                transition={SPRING}
                strokeWidth={on || scanned ? 2 : 1}
                style={
                  on
                    ? { filter: `drop-shadow(0 0 8px color-mix(in srgb, ${glowColor} 55%, transparent))` }
                    : undefined
                }
              />
              <text
                x={CELL / 2}
                y={CELL / 2 + 1}
                textAnchor="middle"
                dominantBaseline="middle"
                className="fill-chalk-100 font-mono text-sm"
              >
                {v}
              </text>
              <text
                x={CELL / 2}
                y={CELL + 14}
                textAnchor="middle"
                className="fill-chalk-500 font-mono text-[10px]"
              >
                {i}
              </text>
            </motion.g>
          );
        })}

        {/* 指针小旗标（captions：i / seen[7]=0 …） */}
        <AnimatePresence>
          {captions.map((c) => {
            const idx = flagIndex(c.nodeId);
            if (idx === null || idx >= values.length) return null;
            const w = Math.max(22, c.text.length * 8 + 12);
            return (
              <motion.g
                key={`${c.nodeId}:${c.text}`}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0, x: PAD + idx * STRIDE + CELL / 2 }}
                exit={{ opacity: 0, y: 6, transition: { duration: 0.15 } }}
                transition={SPRING}
              >
                <rect
                  x={-w / 2}
                  y={0}
                  width={w}
                  height={18}
                  rx={9}
                  className="fill-board-700"
                  stroke="var(--color-beam-cyan)"
                  strokeWidth={1}
                />
                <text
                  x={0}
                  y={9}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  className="fill-beam-cyan font-mono text-[10px]"
                >
                  {c.text}
                </text>
                {/* 旗杆小三角指向格子 */}
                <path
                  d={`M -3 20 L 3 20 L 0 ${FLAG_H - 2} Z`}
                  fill="var(--color-beam-cyan)"
                />
              </motion.g>
            );
          })}
        </AnimatePresence>
      </svg>

      {/* 哈希表小面板 */}
      {mapEntries.length > 0 && (
        <div className="rounded-xl border border-board-700 bg-board-800/70 px-3 py-2 backdrop-blur">
          <div className="mb-1 font-mono text-[10px] tracking-wide text-chalk-500">map</div>
          <div className="flex flex-col gap-1">
            <AnimatePresence initial={false}>
              {mapEntries.map(([k, idx]) => (
                <motion.div
                  key={k}
                  initial={{ opacity: 0, scale: 0.8 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.8, transition: { duration: 0.15 } }}
                  transition={SPRING}
                  className="flex items-center gap-2 font-mono text-xs"
                >
                  <span className="rounded bg-board-700 px-1.5 py-0.5 text-beam-cyan">{k}</span>
                  <span className="text-chalk-500">→</span>
                  <span className="text-chalk-100">[{idx}]</span>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        </div>
      )}
    </div>
  );
}
