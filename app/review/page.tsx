import Link from "next/link";
import { PageHeader } from "@/components/ui/page-header";

/** 复习卡的三种结局（SM-2 间隔算法：答得越好，下次见面越晚） */
const OUTCOMES = [
  { grade: "忘了", next: "明天", tone: "text-beam-rose" },
  { grade: "想了一会儿", next: "3 天后", tone: "text-beam-gold" },
  { grade: "秒答", next: "1 周后", tone: "text-beam-mint" },
];

export default function ReviewPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 pt-10 pb-24 sm:px-6">
      <PageHeader
        eyebrow="间隔复习"
        title="复习队列"
        desc="做对的题会变成复习卡，在你快要忘的时候再出现。这个功能还在准备中。"
      />

      <div className="mt-10 grid items-center gap-10 rounded-2xl border border-dashed border-board-600 px-6 py-12 sm:grid-cols-[auto_1fr] sm:px-10">
        {/* 一叠索引卡 */}
        <div className="relative mx-auto h-40 w-52" aria-hidden="true">
          <div className="absolute inset-0 translate-x-3 translate-y-3 rotate-[5deg] rounded-xl border border-board-600 bg-board-800" />
          <div className="absolute inset-0 translate-x-1.5 translate-y-1.5 rotate-[2deg] rounded-xl border border-board-600 bg-board-800" />
          <div className="board-surface absolute inset-0 flex flex-col justify-between rounded-xl border border-board-600 p-4 -rotate-[1.5deg]">
            <span className="font-mono text-[10px] text-chalk-500">#1 · 哈希</span>
            <span className="chalk text-2xl text-chalk-100">两数之和</span>
            <span className="text-xs text-chalk-500">还记得补数怎么用吗？</span>
          </div>
        </div>

        <div>
          <p className="chalk text-3xl text-chalk-300">复习卡还在备课中</p>
          <p className="mt-2 text-sm leading-6 text-chalk-500">上线后，这里每天会摆好当天该复习的卡片。翻开一张，想想当时是怎么解的，再告诉老师你还记得多少：</p>
          <ul className="mt-4 flex flex-col gap-1.5 text-sm">
            {OUTCOMES.map((o) => (
              <li key={o.grade} className="flex items-center justify-between gap-4 rounded-lg bg-board-900/80 px-3 py-2">
                <span className={o.tone}>{o.grade}</span>
                <span className="text-chalk-500">下次 {o.next}见</span>
              </li>
            ))}
          </ul>
          <Link
            href="/roadmap"
            className="mt-6 inline-block rounded-full border border-board-600 px-5 py-2 text-sm text-chalk-300 transition-colors hover:border-beam-gold/60 hover:text-beam-gold"
          >
            先去路线图攻克几题 →
          </Link>
        </div>
      </div>
    </div>
  );
}
