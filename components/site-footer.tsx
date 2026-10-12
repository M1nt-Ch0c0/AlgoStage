"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function SiteFooter() {
  const pathname = usePathname();
  // 学习页是满屏讲台，不放页脚
  if (pathname.startsWith("/problem/")) return null;

  return (
    <footer className="border-t border-board-700/50">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-6 text-xs text-chalk-500 sm:px-6">
        <p>
          <span className="chalk mr-2 text-base text-chalk-300">AlgoStage</span>
          学习记录只留在你的电脑上 · 开源免费
        </p>
        <nav className="flex gap-4">
          <Link href="/roadmap" className="hover:text-chalk-100">
            路线图
          </Link>
          <a
            href="https://github.com/M1nt-Ch0c0/AlgoStage"
            className="hover:text-chalk-100"
            target="_blank"
            rel="noreferrer"
          >
            GitHub · MIT
          </a>
        </nav>
      </div>
    </footer>
  );
}
