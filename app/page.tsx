import Link from "next/link";
import { ArrowRight, Map as MapIcon } from "lucide-react";
import { DemoBoard } from "@/components/landing/demo-board";
import { GestureCards } from "@/components/landing/gesture-cards";
import AiSetupPrompt from "@/components/settings/ai-setup-prompt";
import { HOT100, HOT100_CATEGORIES } from "@/lib/content/hot100";
import { EFFECT_WHITELIST } from "@/lib/teaching/types";

/* 一堂课的四个环节（真实顺序：备课 → 上课 → 练习 → 复习） */
const LESSON_FLOW = [
  {
    name: "备课",
    desc: "老师先把这道题吃透，想好分几步讲，每一步要指给你看哪里。",
  },
  {
    name: "上课",
    desc: "跟着光走就行。哪一步没听懂，暂停一下，倒回去再听一遍。",
  },
  {
    name: "练习",
    desc: "听懂了就自己上手写。卡住也别急，提示一级一级给，不会直接把答案甩给你。",
  },
  {
    name: "复习",
    desc: "做对的题，过几天老师会再考你一次，就挑你快要忘的时候。（即将上线）",
  },
];

/* 第一次来，按这个顺序走 */
const GET_STARTED = [
  { title: "先听一节试试", desc: "打开「两数之和」，跟着光走一遍，看看这种上课方式合不合你胃口。", href: "/problem/two-sum" },
  { title: "接上你的 AI", desc: "在设置里填上你自己的 API Key，老师就能给其余的题备课了。", href: "/settings" },
  { title: "挑下一题", desc: "回到路线图，按章节一题一题往下学。", href: "/roadmap" },
];

export default function LandingPage() {
  const counts = new Map<string, number>();
  for (const p of HOT100) counts.set(p.category, (counts.get(p.category) ?? 0) + 1);

  return (
    <div className="mx-auto max-w-6xl px-4 sm:px-6">
      {/* ── 首屏：论点 + 正在上课的黑板 ── */}
      <section className="grid grid-cols-1 items-center gap-x-12 gap-y-12 pt-12 pb-20 sm:pt-16 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:pt-20">
        <div>
          <p className="font-mono text-[11px] tracking-[0.14em] text-chalk-500 uppercase">
            LeetCode 热题 100 · 一题一堂课
          </p>
          <h1 className="chalk mt-4 text-[3.4rem] leading-[1.05] text-chalk-100 sm:text-7xl">
            老师讲到哪，
            <br />
            <span className="text-beam-gold">光</span>就照到哪。
          </h1>
          <p className="mt-6 max-w-[34rem] text-[16px] leading-7 text-chalk-300">
            刷题最难的往往不是写代码，而是看不懂别人为什么这么想。AlgoStage 请来一位 AI 老师，站在黑板前一步步讲给你听：讲到哪一行，光就照到哪一行；关键的地方，用粉笔给你划出来。
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Link
              href="/problem/two-sum"
              className="group inline-flex items-center gap-2 rounded-full bg-beam-gold px-6 py-3 text-sm font-semibold text-on-accent transition-transform duration-200 hover:scale-[1.03] active:scale-95"
              style={{ filter: "drop-shadow(0 0 16px color-mix(in srgb, var(--color-beam-gold) 35%, transparent))" }}
            >
              听第一堂课：两数之和
              <ArrowRight size={16} className="transition-transform group-hover:translate-x-0.5" />
            </Link>
            <Link
              href="/roadmap"
              className="inline-flex items-center gap-2 rounded-full border border-board-600 px-5 py-3 text-sm text-chalk-300 transition-colors hover:border-chalk-500 hover:text-chalk-100"
            >
              <MapIcon size={15} />
              看路线图
            </Link>
          </div>
          <div className="mt-5 max-w-[34rem]">
            <AiSetupPrompt />
          </div>
          <dl className="mt-10 grid max-w-sm grid-cols-3 gap-4 border-t border-board-700/60 pt-5">
            {[
              { k: "道题", v: HOT100.length },
              { k: "个章节", v: HOT100_CATEGORIES.length },
              { k: "种教学手势", v: EFFECT_WHITELIST.length },
            ].map((s) => (
              <div key={s.k}>
                <dt className="sr-only">{s.k}</dt>
                <dd>
                  <span className="font-mono text-2xl text-chalk-100 tabular-nums">{s.v}</span>
                  <span className="ml-1 text-xs text-chalk-500">{s.k}</span>
                </dd>
              </div>
            ))}
          </dl>
        </div>

        <DemoBoard />
      </section>

      {/* ── 六种教学手势 ── */}
      <section className="border-t border-board-700/50 py-20" aria-labelledby="gestures">
        <div className="mb-10 max-w-2xl">
          <h2 id="gestures" className="chalk text-4xl text-chalk-100 sm:text-5xl">
            六种教学手势
          </h2>
          <p className="mt-2 text-[15px] leading-7 text-chalk-500">
            好老师讲课，手和粉笔都不会闲着。AlgoStage 把这些小动作搬到了屏幕上，每一下都是在帮你看清重点。把鼠标移到卡片上看看。
          </p>
        </div>
        <GestureCards />
      </section>

      {/* ── 一堂课怎么上 ── */}
      <section className="border-t border-board-700/50 py-20" aria-labelledby="flow">
        <h2 id="flow" className="chalk text-4xl text-chalk-100 sm:text-5xl">
          一堂课怎么上
        </h2>
        <ol className="mt-10 grid gap-x-8 gap-y-10 sm:grid-cols-2 lg:grid-cols-4">
          {LESSON_FLOW.map((s, i) => (
            <li key={s.name} className="relative">
              <div className="flex items-center gap-3">
                <span className="chalk flex size-10 shrink-0 items-center justify-center rounded-full border border-chalk-500/50 text-2xl text-beam-gold">
                  {i + 1}
                </span>
                <h3 className="text-lg font-semibold text-chalk-100">{s.name}</h3>
                {i < LESSON_FLOW.length - 1 && (
                  <span className="hidden h-px flex-1 border-t border-dashed border-chalk-700 lg:block" aria-hidden="true" />
                )}
              </div>
              <p className="mt-3 text-sm leading-6 text-chalk-500">{s.desc}</p>
            </li>
          ))}
        </ol>
      </section>

      {/* ── 课程表 ── */}
      <section className="border-t border-board-700/50 py-20" aria-labelledby="syllabus">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h2 id="syllabus" className="chalk text-4xl text-chalk-100 sm:text-5xl">
              课程表
            </h2>
            <p className="mt-2 text-[15px] text-chalk-500">
              按 LeetCode 热题 100 的章节排课，从哈希一路讲到动态规划，由浅入深。
            </p>
          </div>
          <Link href="/roadmap" className="inline-flex items-center gap-1.5 text-sm text-beam-gold hover:underline">
            打开完整路线图 <ArrowRight size={14} />
          </Link>
        </div>
        <ol className="mt-8 grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-board-700/60 bg-board-700/60 sm:grid-cols-3 lg:grid-cols-6">
          {HOT100_CATEGORIES.map((c, i) => (
            <li key={c} className="bg-board-900">
              <Link
                href={`/roadmap#chapter-${i + 1}`}
                className="flex h-full flex-col gap-1 px-4 py-4 transition-colors hover:bg-board-800"
              >
                <span className="font-mono text-[11px] text-chalk-700 tabular-nums">
                  第 {i + 1} 章
                </span>
                <span className="chalk text-2xl leading-tight text-chalk-100">{c}</span>
                <span className="text-xs text-chalk-500">{counts.get(c) ?? 0} 题</span>
              </Link>
            </li>
          ))}
          <li className="flex flex-col justify-center bg-board-900 px-4 py-4 text-xs leading-5 text-chalk-500">
            共 {HOT100.length} 题
            <br />
            每题都能开课
          </li>
        </ol>
      </section>

      {/* ── 你的电脑就是教室 ── */}
      <section className="grid items-center gap-10 border-t border-board-700/50 py-20 lg:grid-cols-2" aria-labelledby="setup">
        <div>
          <h2 id="setup" className="chalk text-4xl text-chalk-100 sm:text-5xl">
            你的电脑，就是教室
          </h2>
          <p className="mt-3 max-w-[30rem] text-[15px] leading-7 text-chalk-500">
            做过的题、学习记录，都只留在你自己的电脑上，哪儿也不去。第一课「两数之和」老师已经备好了，打开就能听。想听其余 99 道题，在设置里接上你常用的 AI 就行，DeepSeek、Claude、Gemini 都可以。
          </p>
        </div>
        <div className="board-surface board-frame rounded-xl p-[6px]">
          <ol className="flex flex-col gap-5 px-6 py-6">
            {GET_STARTED.map((s, i) => (
              <li key={s.title} className="flex gap-4">
                <span className="chalk flex size-9 shrink-0 items-center justify-center rounded-full border border-chalk-500/50 text-xl text-beam-gold">
                  {i + 1}
                </span>
                <div className="min-w-0">
                  <Link href={s.href} className="chalk text-2xl leading-tight text-chalk-100 hover:text-beam-gold">
                    {s.title}
                  </Link>
                  <p className="mt-0.5 text-sm leading-6 text-chalk-500">{s.desc}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>
    </div>
  );
}
