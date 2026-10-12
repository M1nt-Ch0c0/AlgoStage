"use client";

import { apiPath } from "@/lib/runtime";
import Link from "next/link";
import { useEffect, useId, useMemo, useState } from "react";
import { motion } from "motion/react";
import { ArrowRight, Check, Search } from "lucide-react";
import { HOT100_CATEGORIES } from "@/lib/content/hot100";
import type { ProblemMeta } from "@/lib/content/types";
import {
  DIFFICULTY_DOT,
  DIFFICULTY_LABEL,
  DIFFICULTY_TEXT,
  isSolved,
  patternLabel,
} from "@/lib/content/pattern-labels";
import { PageHeader } from "@/components/ui/page-header";

type RoadmapProblem = ProblemMeta & { status: string };

const DIFF_FILTERS = [
  { id: "all", label: "全部难度" },
  { id: "easy", label: "简单" },
  { id: "medium", label: "中等" },
  { id: "hard", label: "困难" },
] as const;

const STATUS_FILTERS = [
  { id: "all", label: "全部" },
  { id: "todo", label: "未开始" },
  { id: "learning", label: "学习中" },
  { id: "solved", label: "已攻克" },
] as const;

function matchesStatus(p: RoadmapProblem, f: string) {
  if (f === "all") return true;
  if (f === "solved") return isSolved(p.status);
  if (f === "learning") return p.status === "learning";
  return !isSolved(p.status) && p.status !== "learning";
}

/** 章节徽章：六边形，按攻克比例从下往上填金色 */
function HexBadge({ done, total, active }: { done: number; total: number; active: boolean }) {
  const frac = total === 0 ? 0 : done / total;
  const id = `hex${useId().replace(/:/g, "")}`;
  const hex = "M12 1.8 21 7v10l-9 5.2L3 17V7z";
  return (
    <svg viewBox="0 0 24 24" className="size-6 shrink-0" aria-hidden="true">
      <defs>
        <clipPath id={id}>
          <rect x="0" y={24 - 24 * frac} width="24" height={24 * frac} />
        </clipPath>
      </defs>
      <path d={hex} fill="var(--color-board-800)" />
      <path d={hex} fill="var(--color-beam-gold)" clipPath={`url(#${id})`} opacity={frac === 1 ? 1 : 0.75} />
      <path
        d={hex}
        fill="none"
        stroke={active || frac === 1 ? "var(--color-beam-gold)" : "var(--color-chalk-700)"}
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ProblemTile({ p, delay }: { p: RoadmapProblem; delay: number }) {
  const solved = isSolved(p.status);
  const learning = p.status === "learning";
  return (
    <motion.li
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1], delay }}
    >
      <Link
        href={`/problem/${p.slug}`}
        className={`group flex h-full flex-col gap-2 rounded-xl border px-4 py-3 transition-colors ${
          solved
            ? "border-beam-gold/40 bg-beam-gold/[0.06] hover:border-beam-gold/70"
            : "border-board-700/70 bg-board-900/70 hover:border-board-600 hover:bg-board-800/80"
        }`}
      >
        <div className="flex items-center justify-between gap-2 text-xs">
          <span className="font-mono text-chalk-500 tabular-nums">#{p.number}</span>
          <span className={`flex items-center gap-1.5 ${DIFFICULTY_TEXT[p.difficulty]}`}>
            <span className={`size-1.5 rounded-full ${DIFFICULTY_DOT[p.difficulty]}`} />
            {DIFFICULTY_LABEL[p.difficulty]}
          </span>
        </div>
        <p className="text-[15px] leading-snug font-medium text-chalk-100 group-hover:text-chalk-100">
          {p.title}
        </p>
        <div className="mt-auto flex items-center justify-between gap-2 pt-1">
          <span className="truncate text-xs text-chalk-500">
            {p.patterns.slice(0, 2).map(patternLabel).join(" · ")}
          </span>
          {solved ? (
            <span className="flex shrink-0 items-center gap-1 text-xs text-beam-gold">
              <Check size={13} strokeWidth={2.5} />
              已攻克
            </span>
          ) : learning ? (
            <span className="flex shrink-0 items-center gap-1.5 text-xs text-beam-cyan">
              <span className="size-1.5 animate-pulse rounded-full bg-beam-cyan" />
              学习中
            </span>
          ) : (
            <ArrowRight
              size={14}
              className="shrink-0 text-chalk-700 transition-all group-hover:translate-x-0.5 group-hover:text-chalk-300"
            />
          )}
        </div>
      </Link>
    </motion.li>
  );
}

function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: readonly { id: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div role="group" aria-label={label} className="flex rounded-full border border-board-700/70 bg-board-900/70 p-0.5">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          aria-pressed={value === o.id}
          onClick={() => onChange(o.id)}
          className={`rounded-full px-3 py-1 text-xs transition-colors ${
            value === o.id ? "bg-board-700 text-chalk-100" : "text-chalk-500 hover:text-chalk-300"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export default function RoadmapPage() {
  const [problems, setProblems] = useState<RoadmapProblem[] | null>(null);
  const [error, setError] = useState(false);
  const [diff, setDiff] = useState<(typeof DIFF_FILTERS)[number]["id"]>("all");
  const [status, setStatus] = useState<(typeof STATUS_FILTERS)[number]["id"]>("all");
  const [query, setQuery] = useState("");
  const [activeChapter, setActiveChapter] = useState(1);

  useEffect(() => {
    fetch(apiPath("/api/problems"))
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
      ...[...byCategory.keys()].filter((c) => !(HOT100_CATEGORIES as readonly string[]).includes(c)),
    ];
    return ordered
      .filter((c) => byCategory.has(c))
      .map((c, i) => {
        const all = byCategory.get(c)!.sort((a, b) => a.order - b.order);
        return { index: i + 1, name: c, all, solved: all.filter((p) => isSolved(p.status)).length };
      });
  }, [problems]);

  const q = query.trim().toLowerCase();
  const visible = useMemo(
    () =>
      chapters
        .map((ch) => ({
          ...ch,
          problems: ch.all.filter(
            (p) =>
              (diff === "all" || p.difficulty === diff) &&
              matchesStatus(p, status) &&
              (!q || p.title.toLowerCase().includes(q) || String(p.number) === q || p.slug.includes(q)),
          ),
        }))
        .filter((ch) => ch.problems.length > 0),
    [chapters, diff, status, q],
  );

  // 侧栏高亮当前读到的章节
  useEffect(() => {
    if (visible.length === 0) return;
    const els = visible
      .map((ch) => document.getElementById(`chapter-${ch.index}`))
      .filter((el): el is HTMLElement => !!el);
    const io = new IntersectionObserver(
      (entries) => {
        const top = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (top) setActiveChapter(Number(top.target.id.replace("chapter-", "")));
      },
      { rootMargin: "-80px 0px -60% 0px" },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [visible]);

  // 从首页课程表跳来时滚到对应章节
  useEffect(() => {
    if (!problems || !window.location.hash) return;
    document.getElementById(window.location.hash.slice(1))?.scrollIntoView();
  }, [problems]);

  const solvedCount = problems?.filter((p) => isSolved(p.status)).length ?? 0;
  const learningCount = problems?.filter((p) => p.status === "learning").length ?? 0;
  const total = problems?.length ?? 100;
  const nextUp = problems
    ?.slice()
    .sort((a, b) => a.order - b.order)
    .find((p) => !isSolved(p.status));

  return (
    <div className="mx-auto max-w-6xl px-4 pt-10 pb-24 sm:px-6">
      <PageHeader
        eyebrow={`LeetCode 热题 100 · ${HOT100_CATEGORIES.length} 章 · ${total} 题`}
        title="刷题路线图"
        desc="从哈希一路学到动态规划。每章里的题已经按难易排好了，从上往下学最顺手。"
        aside={
          <div className="w-full rounded-2xl border border-board-700/60 bg-board-900/70 p-4 sm:w-80">
            <div className="flex items-baseline justify-between">
              <span className="text-xs text-chalk-500">已攻克</span>
              <span className="font-mono text-sm text-chalk-100 tabular-nums">
                <span className="text-xl text-beam-gold">{solvedCount}</span> / {total}
              </span>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-board-800">
              <motion.div
                className="h-full origin-left rounded-full bg-beam-gold"
                initial={{ scaleX: 0 }}
                animate={{ scaleX: total ? solvedCount / total : 0 }}
                transition={{ duration: 1, ease: [0.22, 1, 0.36, 1], delay: 0.2 }}
              />
            </div>
            <p className="mt-2 text-xs text-chalk-500">学习中 {learningCount} 题</p>
            {nextUp && (
              <Link
                href={`/problem/${nextUp.slug}`}
                className="mt-3 flex items-center justify-between gap-2 rounded-xl bg-beam-gold px-3.5 py-2 text-sm font-semibold text-on-accent transition-transform hover:scale-[1.02]"
              >
                <span className="truncate">
                  {solvedCount === 0 ? "从这里开始" : "下一课"}：{nextUp.number}. {nextUp.title}
                </span>
                <ArrowRight size={15} className="shrink-0" />
              </Link>
            )}
          </div>
        }
      />

      {/* 筛选 */}
      <div className="mt-8 flex flex-wrap items-center gap-3">
        <label className="relative flex min-w-0 flex-1 basis-56 items-center sm:max-w-xs">
          <Search size={14} className="pointer-events-none absolute left-3 text-chalk-500" />
          <span className="sr-only">搜索题目</span>
          <input
            id="roadmap-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜题名或题号"
            className="w-full rounded-full border border-board-700/70 bg-board-900/70 py-1.5 pr-3 pl-8 text-sm text-chalk-100 outline-none placeholder:text-chalk-700 focus:border-beam-gold/60"
          />
        </label>
        <Segmented label="难度" options={DIFF_FILTERS} value={diff} onChange={setDiff} />
        <Segmented label="进度" options={STATUS_FILTERS} value={status} onChange={setStatus} />
      </div>

      {error && (
        <p className="mt-16 text-center text-sm text-beam-rose">
          路线图没加载出来，刷新一下试试。还不行的话，关掉 AlgoStage 重新打开。
        </p>
      )}

      {!problems && !error && (
        <div className="mt-10 grid gap-3 sm:grid-cols-3">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="h-24 animate-pulse rounded-xl bg-board-900/70" />
          ))}
        </div>
      )}

      {problems && (
        <div className="mt-10 grid gap-10 lg:grid-cols-[13rem_1fr]">
          {/* 章节导轨 */}
          <nav aria-label="章节" className="hidden lg:block">
            <ol className="sticky top-20 flex flex-col">
              {chapters.map((ch, i) => {
                const shown = visible.some((v) => v.index === ch.index);
                const active = activeChapter === ch.index;
                return (
                  <li key={ch.name} className="relative">
                    {i < chapters.length - 1 && (
                      <span
                        aria-hidden="true"
                        className="absolute top-7 bottom-[-6px] left-[11.5px] border-l border-dashed border-chalk-700/70"
                      />
                    )}
                    <a
                      href={`#chapter-${ch.index}`}
                      className={`relative flex items-center gap-3 py-1 text-sm transition-colors ${
                        !shown ? "pointer-events-none opacity-35" : active ? "text-chalk-100" : "text-chalk-500 hover:text-chalk-300"
                      }`}
                    >
                      <HexBadge done={ch.solved} total={ch.all.length} active={active} />
                      <span className={`flex-1 truncate ${active ? "font-medium" : ""}`}>{ch.name}</span>
                      <span className="font-mono text-[11px] text-chalk-700 tabular-nums">
                        {ch.solved}/{ch.all.length}
                      </span>
                    </a>
                  </li>
                );
              })}
            </ol>
          </nav>

          {/* 章节内容 */}
          <div className="flex min-w-0 flex-col gap-12">
            {visible.length === 0 && (
              <div className="rounded-2xl border border-dashed border-board-700 px-6 py-16 text-center">
                <p className="chalk text-3xl text-chalk-300">没有符合条件的题</p>
                <button
                  type="button"
                  onClick={() => {
                    setDiff("all");
                    setStatus("all");
                    setQuery("");
                  }}
                  className="mt-4 text-sm text-beam-gold hover:underline"
                >
                  清除筛选
                </button>
              </div>
            )}
            {visible.map((ch, ci) => (
              <section key={ch.name} id={`chapter-${ch.index}`} className="scroll-mt-20" aria-labelledby={`chapter-${ch.index}-title`}>
                <div className="mb-4 flex items-baseline gap-3">
                  <span className="font-mono text-xs text-chalk-700 tabular-nums">第 {ch.index} 章</span>
                  <h2 id={`chapter-${ch.index}-title`} className="chalk text-3xl leading-none text-chalk-100">
                    {ch.name}
                  </h2>
                  <span className="text-xs text-chalk-500 tabular-nums">
                    {ch.solved}/{ch.all.length} 已攻克
                  </span>
                  <span className="h-px flex-1 self-center bg-board-700/60" aria-hidden="true" />
                </div>
                <ul className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(13.5rem,1fr))]">
                  {ch.problems.map((p, pi) => (
                    <ProblemTile key={p.slug} p={p} delay={Math.min(0.04 * ci + 0.02 * pi, 0.6)} />
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
