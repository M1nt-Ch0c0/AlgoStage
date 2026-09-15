"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { motion } from "motion/react";
import { HOT100_CATEGORIES } from "@/lib/content/hot100";
import type { ProblemMeta } from "@/lib/content/types";

type RoadmapProblem = ProblemMeta & { status: string };

const DIFF_STYLE: Record<string, { label: string; className: string }> = {
  easy: { label: "简单", className: "text-beam-mint border-beam-mint/40" },
  medium: { label: "中等", className: "text-beam-gold border-beam-gold/40" },
  hard: { label: "困难", className: "text-beam-rose border-beam-rose/40" },
};

const DIFF_DOT: Record<string, string> = {
  easy: "bg-beam-mint",
  medium: "bg-beam-gold",
  hard: "bg-beam-rose",
};

function ProblemBadge({
  problem,
  delay,
}: {
  problem: RoadmapProblem;
  delay: number;
}) {
  const solved = problem.status === "solved" || problem.status === "mastered";
  const learning = problem.status === "learning";
  const diff = DIFF_STYLE[problem.difficulty] ?? DIFF_STYLE.medium;

  return (
    <motion.div
      initial={{ scale: 0, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={{
        type: "spring",
        stiffness: 320,
        damping: 22,
        delay,
      }}
      className="relative"
    >
      <motion.div
        animate={learning ? { opacity: [0.55, 1, 0.55] } : undefined}
        transition={
          learning
            ? { duration: 2.4, repeat: Infinity, ease: "easeInOut" }
            : undefined
        }
        className={learning ? "" : solved ? "" : "opacity-40"}
      >
        <Link
          href={`/problem/${problem.slug}`}
          className={`group relative flex items-center gap-2 rounded-xl border bg-board-900/70 px-3 py-2 backdrop-blur-sm transition-transform duration-200 hover:scale-105 ${diff.className}`}
          style={
            solved
              ? { filter: "drop-shadow(0 0 8px rgba(255, 209, 102, 0.45))" }
              : undefined
          }
        >
          <span
            className={`size-1.5 shrink-0 rounded-full ${DIFF_DOT[problem.difficulty] ?? "bg-beam-gold"}`}
          />
          <span className="font-mono text-xs text-chalk-500">
            {problem.number}
          </span>
          <span className="truncate text-sm text-chalk-100">
            {problem.title}
          </span>
          {solved && <span className="ml-auto text-xs text-beam-gold">✓</span>}

          {/* hover 小卡 */}
          <span className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-2 w-52 -translate-x-1/2 translate-y-1 scale-95 rounded-lg border border-board-700/70 bg-board-950/95 p-3 opacity-0 shadow-xl backdrop-blur-md transition-all duration-150 group-hover:translate-y-0 group-hover:scale-100 group-hover:opacity-100">
            <span className="block text-sm text-chalk-100">
              {problem.number}. {problem.title}
            </span>
            <span className="mt-1 block text-xs text-chalk-500">
              难度：{diff.label} ·{" "}
              {solved ? "已攻克" : learning ? "学习中" : "未开始"}
            </span>
            <span className="mt-2 flex flex-wrap gap-1">
              {problem.patterns.map((p) => (
                <span
                  key={p}
                  className="rounded-full border border-board-700 px-2 py-0.5 font-mono text-[10px] text-beam-cyan"
                >
                  {p}
                </span>
              ))}
            </span>
          </span>
        </Link>
      </motion.div>
    </motion.div>
  );
}

export default function RoadmapPage() {
  const [problems, setProblems] = useState<RoadmapProblem[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    fetch("/api/problems")
      .then((r) => r.json())
      .then((d) => setProblems(d.problems))
      .catch(() => setError(true));
  }, []);

  const chapters = useMemo(() => {
    if (!problems) return [];
    const byCategory = new Map<string, RoadmapProblem[]>();
    for (const p of problems) {
      const list = byCategory.get(p.category) ?? [];
      list.push(p);
      byCategory.set(p.category, list);
    }
    const ordered = [
      ...HOT100_CATEGORIES,
      ...[...byCategory.keys()].filter(
        (c) => !(HOT100_CATEGORIES as readonly string[]).includes(c),
      ),
    ];
    return ordered
      .filter((c) => byCategory.has(c))
      .map((c) => ({
        name: c,
        problems: byCategory.get(c)!.sort((a, b) => a.order - b.order),
      }));
  }, [problems]);

  const solvedCount =
    problems?.filter((p) => p.status === "solved" || p.status === "mastered")
      .length ?? 0;
  const total = problems?.length ?? 100;
  const pct = total === 0 ? 0 : solvedCount / total;

  return (
    <div className="mx-auto max-w-6xl px-6 pb-24 pt-10">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-chalk text-4xl text-chalk-100">刷题路线图</h1>
          <p className="mt-1 text-sm text-chalk-500">
            17 个章节 · 100 道题 · 从哈希到多维 DP，一关一关点亮
          </p>
        </div>
        <div className="w-full max-w-xs">
          <div className="mb-1.5 flex justify-between text-xs text-chalk-500">
            <span>已攻克</span>
            <span className="font-mono text-beam-gold">
              {solvedCount}/{total}
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-board-800">
            <motion.div
              className="h-full w-full origin-left rounded-full bg-gradient-to-r from-beam-gold/70 to-beam-gold"
              initial={{ scaleX: 0 }}
              animate={{ scaleX: pct }}
              transition={{ duration: 1, ease: [0.22, 1, 0.36, 1], delay: 0.2 }}
              style={{
                filter: "drop-shadow(0 0 6px rgba(255, 209, 102, 0.4))",
              }}
            />
          </div>
        </div>
      </header>

      {error && (
        <p className="mt-16 text-center text-sm text-beam-rose">
          路线图加载失败，请确认 dev server 已启动（npm run dev）。
        </p>
      )}

      {!problems && !error && (
        <div className="mt-16 space-y-4">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-24 animate-pulse rounded-2xl border border-board-700/40 bg-board-900/50"
            />
          ))}
        </div>
      )}

      <div className="mt-10 space-y-10">
        {chapters.map((chapter, ci) => {
          const chapterSolved = chapter.problems.filter(
            (p) => p.status === "solved" || p.status === "mastered",
          ).length;
          return (
            <motion.section
              key={chapter.name}
              initial={{ opacity: 0, y: 24 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{
                duration: 0.5,
                ease: [0.22, 1, 0.36, 1],
                delay: 0.08 * ci,
              }}
            >
              <div className="mb-3 flex items-baseline gap-3">
                <span className="font-mono text-xs text-chalk-700">
                  {String(ci + 1).padStart(2, "0")}
                </span>
                <h2 className="font-chalk text-2xl text-chalk-100">
                  {chapter.name}
                </h2>
                <span className="text-xs text-chalk-500">
                  {chapterSolved}/{chapter.problems.length}
                </span>
                <span className="h-px flex-1 self-center bg-board-700/50" />
              </div>
              <div className="flex flex-wrap gap-2">
                {chapter.problems.map((p, pi) => (
                  <ProblemBadge
                    key={p.slug}
                    problem={p}
                    delay={Math.min(0.08 * ci + 0.03 * pi, 1.2)}
                  />
                ))}
              </div>
            </motion.section>
          );
        })}
      </div>
    </div>
  );
}
