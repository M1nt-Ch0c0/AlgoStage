"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { PageHeader } from "@/components/ui/page-header";
import { isSolved } from "@/lib/content/pattern-labels";
import { apiPath, IS_DEMO } from "@/lib/runtime";

interface ReviewCard {
  id: string;
  problemSlug: string;
  title: string;
  number?: number;
  status: string;
}

export default function ReviewPage() {
  const [cards, setCards] = useState<ReviewCard[] | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    fetch(apiPath("/api/review"), { signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error("复习记录加载失败");
        setCards((await response.json()).cards);
      })
      .catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, []);
  return (
    <div className="mx-auto max-w-3xl px-4 pt-10 pb-24 sm:px-6">
      <PageHeader eyebrow="间隔复习" title="复习队列" desc="这里列出已经到期的题。重新判题后，会根据结果安排下次复习。" />
      {error && <p role="alert" className="mt-10 text-beam-rose">复习记录没加载出来，请刷新重试。</p>}
      {!cards && !error && <p role="status" className="mt-10 text-chalk-500">正在加载复习记录…</p>}
      {cards?.length === 0 && <div className="mt-10 rounded-2xl border border-dashed border-board-600 px-6 py-12 text-center">
        <p className="chalk text-3xl text-chalk-300">今天没有到期的复习题</p>
        <p className="mt-2 text-sm text-chalk-500">判题后会安排复习，做对的题会逐渐延长间隔。{IS_DEMO ? "体验版不记录学习进度，复习安排需要装到自己电脑上使用。" : ""}</p>
        <Link href="/roadmap" className="mt-6 inline-block text-beam-cyan">去路线图练习 →</Link>
      </div>}
      {cards && cards.length > 0 && <ul className="mt-10 flex flex-col gap-3">
        {cards.map(card => <li key={card.id} className="flex items-center justify-between gap-4 rounded-xl border border-board-700 bg-board-900 p-5">
          <div>
            <p className="text-chalk-100">{card.number ? `${card.number}. ` : ""}{card.title}</p>
            <p className="mt-1 text-xs text-chalk-500">{isSolved(card.status) ? "已攻克 · 到期复习" : "学习中 · 再练一次"}</p>
          </div>
          <Link href={`/judge/${card.problemSlug}`} className="shrink-0 text-sm text-beam-cyan">开始复习 →</Link>
        </li>)}
      </ul>}
    </div>
  );
}
