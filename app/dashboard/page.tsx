"use client";

import { apiPath } from "@/lib/runtime";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { animate, motion } from "motion/react";
import { ArrowRight } from "lucide-react";
import { HOT100_CATEGORIES } from "@/lib/content/hot100";
import type { ProblemMeta } from "@/lib/content/types";
import { isSolved, patternLabel } from "@/lib/content/pattern-labels";
import { PageHeader, Panel } from "@/components/ui/page-header";

interface DashboardData {
  heatmap: Record<string, number>;
  mastery: Record<string, number>;
  streak: number;
  acCount: number;
  totalSubmissions: number;
  independence: number;
  reviewDue: number;
}

type ProblemWithStatus = ProblemMeta & { status: string };

const EASE = [0.22, 1, 0.36, 1] as const;

/* ---------- 数字翻滚（docs/02 §4.9） ---------- */

function CountUp({ value, decimals = 0 }: { value: number; decimals?: number }) {
  const [display, setDisplay] = useState(0);
  useEffect(() => {
    const controls = animate(0, value, {
      duration: 1.2,
      ease: EASE,
      onUpdate: (v) => setDisplay(v),
    });
    return () => controls.stop();
  }, [value]);
  return <>{display.toFixed(decimals)}</>;
}

/* ---------- 热力图（GitHub 风格，粉笔金单色阶） ---------- */

const CELL = 11;
const GAP = 3;
const WEEK_DAYS = 7;
const LABEL_W = 22;

function heatColor(count: number): string {
  if (count <= 0) return "var(--color-board-800)";
  if (count <= 2) return "color-mix(in srgb, var(--color-beam-gold) 35%, var(--color-board-800))";
  if (count <= 5) return "color-mix(in srgb, var(--color-beam-gold) 65%, var(--color-board-800))";
  return "var(--color-beam-gold)";
}

function Heatmap({ heatmap }: { heatmap: Record<string, number> }) {
  const { weeks, monthLabels } = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const start = new Date(today);
    start.setDate(start.getDate() - 364);
    start.setDate(start.getDate() - start.getDay()); // 对齐到周日

    const weeks: { key: string; count: number }[][] = [];
    const monthLabels: { week: number; label: string }[] = [];
    const cursor = new Date(start);
    let lastMonth = -1;
    while (cursor <= today) {
      const week: { key: string; count: number }[] = [];
      const m = cursor.getMonth();
      for (let d = 0; d < WEEK_DAYS; d++) {
        const key = cursor.toISOString().slice(0, 10);
        week.push({ key, count: cursor <= today ? (heatmap[key] ?? 0) : -1 });
        cursor.setDate(cursor.getDate() + 1);
      }
      if (m !== lastMonth) {
        // 第一列若只露出几天就不标月份，避免和下一个月份挤在一起
        if (weeks.length > 0 || cursor.getDate() > 7) monthLabels.push({ week: weeks.length, label: `${m + 1}月` });
        lastMonth = m;
      }
      weeks.push(week);
    }
    return { weeks, monthLabels };
  }, [heatmap]);

  const width = LABEL_W + weeks.length * (CELL + GAP) + 16; // +16：末尾月份文字
  const height = 18 + WEEK_DAYS * (CELL + GAP);

  return (
    <div>
      <div className="overflow-x-auto pb-1">
        <svg width={width} height={height} className="block" role="img" aria-label="近一年每天的学习次数">
          {monthLabels.map((m) => (
            <text key={`${m.week}-${m.label}`} x={LABEL_W + m.week * (CELL + GAP)} y={10} className="fill-chalk-500" fontSize={10}>
              {m.label}
            </text>
          ))}
          {["一", "三", "五"].map((d, i) => (
            <text key={d} x={0} y={18 + (1 + i * 2) * (CELL + GAP) + CELL - 2} className="fill-chalk-700" fontSize={9}>
              {d}
            </text>
          ))}
          {weeks.map((week, wi) =>
            week.map((day, di) =>
              day.count < 0 ? null : (
                <rect
                  key={day.key}
                  x={LABEL_W + wi * (CELL + GAP)}
                  y={18 + di * (CELL + GAP)}
                  width={CELL}
                  height={CELL}
                  rx={2.5}
                  fill={heatColor(day.count)}
                >
                  <title>
                    {day.key} · {day.count > 0 ? `${day.count} 次提交` : "没有提交"}
                  </title>
                </rect>
              ),
            ),
          )}
        </svg>
      </div>
      <div className="mt-2 flex items-center justify-end gap-1 text-[11px] text-chalk-500">
        少
        {[0, 1, 3, 6].map((c) => (
          <span key={c} className="inline-block size-[11px] rounded-[2.5px]" style={{ background: heatColor(c) }} />
        ))}
        多
      </div>
    </div>
  );
}

/* ---------- 统计格 ---------- */

function Stat({
  label,
  value,
  unit,
  note,
}: {
  label: string;
  value: React.ReactNode;
  unit: string;
  note?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1 bg-board-900 px-5 py-4">
      <span className="text-xs text-chalk-500">{label}</span>
      <span className="font-mono text-3xl text-chalk-100 tabular-nums">
        {value}
        <span className="ml-1 font-sans text-sm text-chalk-500">{unit}</span>
      </span>
      {note && <span className="text-xs text-chalk-700">{note}</span>}
    </div>
  );
}

/* ---------- 横向进度条（细条、圆头、从左生长） ---------- */

function ProgressRow({
  label,
  value,
  max,
  right,
  delay,
  href,
}: {
  label: string;
  value: number;
  max: number;
  right: string;
  delay: number;
  href?: string;
}) {
  const frac = max === 0 ? 0 : value / max;
  const inner = (
    <>
      <span className="w-24 shrink-0 truncate text-sm text-chalk-300">{label}</span>
      <span className="relative h-2 flex-1 overflow-hidden rounded-full bg-board-800">
        {frac > 0 && (
          <motion.span
            className="absolute inset-y-0 left-0 rounded-full bg-beam-gold"
            initial={{ width: 0 }}
            animate={{ width: `${frac * 100}%` }}
            transition={{ duration: 0.8, ease: EASE, delay }}
          />
        )}
      </span>
      <span className="w-14 shrink-0 text-right font-mono text-xs text-chalk-500 tabular-nums">{right}</span>
    </>
  );
  return href ? (
    <Link href={href} className="-mx-2 flex items-center gap-3 rounded-lg px-2 py-1 transition-colors hover:bg-board-800/70">
      {inner}
    </Link>
  ) : (
    <div className="flex items-center gap-3 py-1">{inner}</div>
  );
}

/* ---------- 页面 ---------- */

export default function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [problems, setProblems] = useState<ProblemWithStatus[] | null>(null);
  const [error, setError] = useState(false);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    Promise.all(["/api/dashboard", "/api/problems"].map((path) =>
      fetch(apiPath(path)).then((r) => r.ok ? r.json() : undefined),
    ))
      .then(([d, p]) => {
        if (!d || !p) { setUnavailable(true); return; }
        setData(d);
        setProblems(p.problems);
      })
      .catch(() => setError(true));
  }, []);

  const chapters = useMemo(() => {
    if (!problems) return [];
    return HOT100_CATEGORIES.map((c, i) => {
      const list = problems.filter((p) => p.category === c);
      return { index: i + 1, name: c, total: list.length, solved: list.filter((p) => isSolved(p.status)).length };
    });
  }, [problems]);

  const masteryTop = useMemo(() => {
    return Object.entries(data?.mastery ?? {})
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8);
  }, [data]);

  if (unavailable) {
    return (
      <div className="mx-auto max-w-6xl px-4 pt-10 pb-24 sm:px-6">
        <PageHeader eyebrow="成绩单" title="个人看板" desc="体验版没有学习看板" />
      </div>
    );
  }

  const nextUp = problems?.slice().sort((a, b) => a.order - b.order).find((p) => !isSolved(p.status));
  const isEmpty = data?.totalSubmissions === 0;

  return (
    <div className="mx-auto max-w-6xl px-4 pt-10 pb-24 sm:px-6">
      <PageHeader
        eyebrow="成绩单"
        title="个人看板"
        desc="你的学习记录都在这里。每做对一道题，这里就亮一点。"
        aside={
          nextUp && (
            <Link
              href={`/problem/${nextUp.slug}`}
              className="flex items-center gap-2 rounded-full bg-beam-gold px-5 py-2.5 text-sm font-semibold text-on-accent transition-transform hover:scale-[1.03]"
            >
              下一课：{nextUp.number}. {nextUp.title}
              <ArrowRight size={15} />
            </Link>
          )
        }
      />

      {error && (
        <p className="mt-16 text-center text-sm text-beam-rose">
          学习记录没加载出来，刷新一下试试。还不行的话，关掉 AlgoStage 重新打开。
        </p>
      )}

      {!data && !error && (
        <div className="mt-10 grid gap-4">
          <div className="h-28 animate-pulse rounded-2xl bg-board-900/70" />
          <div className="h-56 animate-pulse rounded-2xl bg-board-900/70" />
        </div>
      )}

      {data && (
        <div className="mt-8 flex flex-col gap-4">
          {/* 四个关键数 */}
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.45, ease: EASE }}
            className="grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-board-700/60 bg-board-700/60 lg:grid-cols-4"
          >
            <Stat label="连续学习" value={<CountUp value={data.streak} />} unit="天" note={data.streak > 0 ? "保持住，明天见" : "今天交一次就开始计数"} />
            <Stat
              label="已攻克"
              value={<CountUp value={data.acCount} />}
              unit={`/ ${problems?.length ?? 100} 题`}
              note={`共提交 ${data.totalSubmissions} 次`}
            />
            <Stat
              label="独立性"
              value={<CountUp value={Math.round(data.independence * 100)} />}
              unit="%"
              note="没看提示就做对的比例"
            />
            <Stat
              label="今日待复习"
              value={<CountUp value={data.reviewDue} />}
              unit="张"
              note={
                <Link href="/review" className="text-beam-cyan hover:underline">
                  进入复习队列 →
                </Link>
              }
            />
          </motion.div>

          {/* 热力图 */}
          <Panel
            title="学习热力 · 近一年"
            desc={isEmpty ? "这里还空着。做对第一道题，日历就会亮起第一格。" : "每一格是一天，那天练得越多，格子越亮。"}
          >
            <Heatmap heatmap={data.heatmap} />
          </Panel>

          <div className="grid gap-4 lg:grid-cols-2">
            {/* 章节进度 */}
            <Panel title="章节进度" desc="每一章做对了几道，一眼就能看清。点一行可以直接去那一章。">
              <div className="flex flex-col">
                {chapters.map((c, i) => (
                  <ProgressRow
                    key={c.name}
                    label={c.name}
                    value={c.solved}
                    max={c.total}
                    right={`${c.solved}/${c.total}`}
                    delay={0.2 + i * 0.03}
                    href={`/roadmap#chapter-${c.index}`}
                  />
                ))}
              </div>
            </Panel>

            {/* 掌握度 */}
            <Panel title="知识点掌握度" desc="同一类题做对得越多、看提示越少，分数就越高。">
              {masteryTop.length === 0 ? (
                <div className="flex min-h-48 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-board-600 px-6 text-center">
                  <p className="chalk text-3xl text-chalk-500">还没有掌握度数据</p>
                  <p className="text-sm text-chalk-700">做对一道题，它用到的知识点就会出现在这里。</p>
                </div>
              ) : (
                <div className="flex flex-col">
                  {masteryTop.map(([pattern, score], i) => (
                    <ProgressRow
                      key={pattern}
                      label={patternLabel(pattern)}
                      value={score}
                      max={1}
                      right={`${Math.round(score * 100)} 分`}
                      delay={0.3 + i * 0.05}
                    />
                  ))}
                </div>
              )}
            </Panel>
          </div>
        </div>
      )}
    </div>
  );
}
