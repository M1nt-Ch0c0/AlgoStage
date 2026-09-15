"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { animate, motion } from "motion/react";

interface DashboardData {
  heatmap: Record<string, number>;
  mastery: Record<string, number>;
  streak: number;
  acCount: number;
  totalSubmissions: number;
  independence: number;
  reviewDue: number;
}

/* ---------- 数字翻滚（docs/02 §4.9） ---------- */

function CountUp({
  value,
  suffix = "",
  decimals = 0,
}: {
  value: number;
  suffix?: string;
  decimals?: number;
}) {
  const [display, setDisplay] = useState(0);
  useEffect(() => {
    const controls = animate(0, value, {
      duration: 1.4,
      ease: [0.22, 1, 0.36, 1],
      onUpdate: (v) => setDisplay(v),
    });
    return () => controls.stop();
  }, [value]);
  return (
    <span>
      {display.toFixed(decimals)}
      {suffix}
    </span>
  );
}

/* ---------- 热力图（GitHub 风格，粉笔色阶） ---------- */

const CELL = 11;
const GAP = 3;
const WEEK_DAYS = 7;

function heatColor(count: number): string {
  if (count <= 0) return "var(--color-board-800)";
  if (count <= 2)
    return "color-mix(in srgb, var(--color-beam-gold) 30%, var(--color-board-800))";
  if (count <= 5)
    return "color-mix(in srgb, var(--color-beam-gold) 60%, var(--color-board-800))";
  return "var(--color-beam-gold)";
}

function Heatmap({ heatmap }: { heatmap: Record<string, number> }) {
  const { weeks, monthLabels } = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const start = new Date(today);
    start.setDate(start.getDate() - 364);
    start.setDate(start.getDate() - start.getDay()); // 对齐到周日

    const weeks: { date: Date; key: string; count: number }[][] = [];
    const monthLabels: { week: number; label: string }[] = [];
    const cursor = new Date(start);
    let lastMonth = -1;
    while (cursor <= today) {
      const week: { date: Date; key: string; count: number }[] = [];
      for (let d = 0; d < WEEK_DAYS; d++) {
        const key = cursor.toISOString().slice(0, 10);
        week.push({
          date: new Date(cursor),
          key,
          count: cursor <= today ? (heatmap[key] ?? 0) : -1,
        });
        cursor.setDate(cursor.getDate() + 1);
      }
      const wi = weeks.length;
      const m = week[0].date.getMonth();
      if (m !== lastMonth) {
        monthLabels.push({ week: wi, label: `${m + 1}月` });
        lastMonth = m;
      }
      weeks.push(week);
    }
    return { weeks, monthLabels };
  }, [heatmap]);

  let dayIndex = 0;

  return (
    <div className="overflow-x-auto pb-2">
      <svg
        width={weeks.length * (CELL + GAP) + GAP}
        height={WEEK_DAYS * (CELL + GAP) + GAP + 18}
        className="block"
      >
        {monthLabels.map((m) => (
          <text
            key={`${m.week}-${m.label}`}
            x={GAP + m.week * (CELL + GAP)}
            y={10}
            className="fill-chalk-500"
            fontSize={9}
          >
            {m.label}
          </text>
        ))}
        {weeks.map((week, wi) =>
          week.map((day, di) => {
            if (day.count < 0) return null;
            const idx = dayIndex++;
            return (
              <motion.rect
                key={day.key}
                x={GAP + wi * (CELL + GAP)}
                y={18 + GAP + di * (CELL + GAP)}
                width={CELL}
                height={CELL}
                rx={2.5}
                fill={heatColor(day.count)}
                initial={{ scale: 0, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{
                  type: "spring",
                  stiffness: 400,
                  damping: 24,
                  delay: 0.15 + idx * 0.0035,
                }}
                style={{ transformBox: "fill-box", transformOrigin: "center" }}
              >
                <title>
                  {day.key} · {day.count} 次活动
                </title>
              </motion.rect>
            );
          }),
        )}
      </svg>
      <div className="mt-2 flex items-center justify-end gap-1 text-[10px] text-chalk-500">
        少
        {[0, 1, 3, 6].map((c) => (
          <span
            key={c}
            className="inline-block size-[11px] rounded-[2.5px]"
            style={{ background: heatColor(c) }}
          />
        ))}
        多
      </div>
    </div>
  );
}

/* ---------- 统计卡片 ---------- */

function GlassCard({
  title,
  children,
  delay = 0,
  className = "",
}: {
  title: string;
  children: React.ReactNode;
  delay?: number;
  className?: string;
}) {
  return (
    <motion.section
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1], delay }}
      className={`rounded-2xl border border-board-700/50 bg-board-900/50 p-5 backdrop-blur-md ${className}`}
    >
      <h2 className="mb-4 text-sm text-chalk-500">{title}</h2>
      {children}
    </motion.section>
  );
}

function StatValue({
  value,
  suffix,
  decimals,
}: {
  value: number;
  suffix?: string;
  decimals?: number;
}) {
  return (
    <p className="font-mono text-3xl text-chalk-100">
      <CountUp value={value} suffix={suffix} decimals={decimals} />
    </p>
  );
}

function Flame() {
  return (
    <motion.svg
      viewBox="0 0 24 24"
      className="size-6 text-beam-gold"
      fill="currentColor"
      animate={{ scale: [1, 1.12, 1], opacity: [0.85, 1, 0.85] }}
      transition={{ duration: 1.8, repeat: Infinity, ease: "easeInOut" }}
      style={{ filter: "drop-shadow(0 0 8px rgba(255, 209, 102, 0.5))" }}
    >
      <path d="M12 2c1 4-3 5-3 9a4.5 4.5 0 0 0 9 0c0-2-1-3.5-2-4.5.2 1.5-.5 2.5-1.5 2.5C14 7 13.5 4 12 2zm0 15.5a2.5 2.5 0 0 1-2.5-2.5c0-1.5 1-2.3 2.5-4 1.5 1.7 2.5 2.5 2.5 4a2.5 2.5 0 0 1-2.5 2.5z" />
    </motion.svg>
  );
}

/* ---------- 页面 ---------- */

export default function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    fetch("/api/dashboard")
      .then((r) => r.json())
      .then(setData)
      .catch(() => setError(true));
  }, []);

  const masteryTop = useMemo(() => {
    if (!data) return [];
    return Object.entries(data.mastery)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8);
  }, [data]);

  const isEmpty = data !== null && data.totalSubmissions === 0;

  return (
    <div className="mx-auto max-w-6xl px-6 pb-24 pt-10">
      <header>
        <h1 className="font-chalk text-4xl text-chalk-100">个人看板</h1>
        <p className="mt-1 text-sm text-chalk-500">
          课后的沉淀与回顾——每一次 AC 都会在这里开花
        </p>
      </header>

      {error && (
        <p className="mt-16 text-center text-sm text-beam-rose">
          看板数据加载失败，请确认 dev server 已启动。
        </p>
      )}

      {!data && !error && (
        <div className="mt-10 grid gap-4">
          <div className="h-56 animate-pulse rounded-2xl border border-board-700/40 bg-board-900/50" />
          <div className="grid gap-4 sm:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <div
                key={i}
                className="h-28 animate-pulse rounded-2xl border border-board-700/40 bg-board-900/50"
              />
            ))}
          </div>
        </div>
      )}

      {data && (
        <div className="mt-8 space-y-4">
          {/* 统计卡片 */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <GlassCard title="连续学习" delay={0}>
              <div className="flex items-center gap-3">
                <Flame />
                <StatValue value={data.streak} suffix=" 天" />
              </div>
            </GlassCard>
            <GlassCard title="累计 AC" delay={0.08}>
              <StatValue value={data.acCount} suffix=" 题" />
              <p className="mt-1 text-xs text-chalk-700">
                共提交 {data.totalSubmissions} 次
              </p>
            </GlassCard>
            <GlassCard title="独立性（无提示 AC 占比）" delay={0.16}>
              <StatValue
                value={Math.round(data.independence * 100)}
                suffix="%"
              />
              <p className="mt-1 text-xs text-chalk-700">越少靠提示越高</p>
            </GlassCard>
            <GlassCard title="今日待复习" delay={0.24}>
              <StatValue value={data.reviewDue} suffix=" 张" />
              <Link
                href="/review"
                className="mt-1 inline-block text-xs text-beam-cyan hover:underline"
              >
                进入复习队列 →
              </Link>
            </GlassCard>
          </div>

          {/* 热力图 */}
          <GlassCard title="学习热力 · 近一年" delay={0.3}>
            {isEmpty ? (
              <div className="flex h-40 flex-col items-center justify-center gap-2 text-center">
                <p className="font-chalk text-2xl text-chalk-500">
                  黑板还空着
                </p>
                <p className="text-sm text-chalk-700">
                  去{" "}
                  <Link href="/roadmap" className="text-beam-gold hover:underline">
                    路线图
                  </Link>{" "}
                  写下第一行粉笔字，格子就会亮起来
                </p>
              </div>
            ) : (
              <Heatmap heatmap={data.heatmap} />
            )}
          </GlassCard>

          {/* 掌握度 */}
          <GlassCard title="知识点掌握度 · Top 8" delay={0.38}>
            {masteryTop.length === 0 ? (
              <div className="flex h-32 flex-col items-center justify-center gap-2 text-center">
                <p className="font-chalk text-2xl text-chalk-500">
                  还没有掌握度数据
                </p>
                <p className="text-sm text-chalk-700">
                  攻克任意题目后，这里会生长出第一根条形
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {masteryTop.map(([pattern, score], i) => (
                  <div key={pattern} className="flex items-center gap-3">
                    <span className="w-32 shrink-0 truncate font-mono text-xs text-chalk-300">
                      {pattern}
                    </span>
                    <div className="h-3 flex-1 overflow-hidden rounded-full bg-board-800">
                      <motion.div
                        className="h-full origin-left rounded-full bg-gradient-to-r from-beam-cyan/70 to-beam-cyan"
                        initial={{ scaleX: 0 }}
                        animate={{ scaleX: Math.max(0.02, score) }}
                        transition={{
                          duration: 0.8,
                          ease: [0.22, 1, 0.36, 1],
                          delay: 0.45 + i * 0.08,
                        }}
                      />
                    </div>
                    <span className="w-12 shrink-0 text-right font-mono text-xs text-beam-cyan">
                      {Math.round(score * 100)}%
                    </span>
                  </div>
                ))}
              </div>
            )}
          </GlassCard>
        </div>
      )}
    </div>
  );
}
