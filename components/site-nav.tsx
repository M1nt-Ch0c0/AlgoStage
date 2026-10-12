"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { Moon, Sun } from "lucide-react";
import { applyTheme, readTheme, type Theme } from "@/lib/theme";

const LINKS = [
  { href: "/roadmap", label: "路线图" },
  { href: "/dashboard", label: "看板" },
  { href: "/review", label: "复习" },
  { href: "/settings", label: "设置" },
] as const;

/** 品牌标：一盏从上往下打的聚光灯，光圈落在一截粉笔字上 */
export function StageMark({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
      <defs>
        <linearGradient id="stage-mark-beam" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--color-beam-gold)" stopOpacity="0.9" />
          <stop offset="1" stopColor="var(--color-beam-gold)" stopOpacity="0.08" />
        </linearGradient>
      </defs>
      <path d="M13 4h6l7 20H6z" fill="url(#stage-mark-beam)" />
      <rect x="12" y="2" width="8" height="4" rx="1.5" fill="var(--color-beam-gold)" />
      <ellipse cx="16" cy="25" rx="11" ry="3" fill="var(--color-beam-gold)" opacity="0.28" />
      <path
        d="M9 25.5c2-.8 4.5-1 7-.6s4.6.4 7-.3"
        fill="none"
        stroke="var(--color-chalk-100)"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("dark");

  useEffect(() => {
    setTheme(readTheme());
    const on = (e: Event) => setTheme((e as CustomEvent<Theme>).detail);
    window.addEventListener("algostage:theme", on);
    return () => window.removeEventListener("algostage:theme", on);
  }, []);

  const next: Theme = theme === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      onClick={() => applyTheme(next)}
      aria-label={next === "light" ? "切换到 Paper Light 浅色主题" : "切换到 Chalkboard Dark 深色主题"}
      title={next === "light" ? "Paper Light" : "Chalkboard Dark"}
      className="flex size-8 items-center justify-center rounded-full text-chalk-500 transition-colors hover:bg-board-800 hover:text-chalk-100"
    >
      {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
    </button>
  );
}

export function SiteNav() {
  const pathname = usePathname();
  const wide = pathname.startsWith("/problem/");

  return (
    <header className="sticky top-0 z-50 border-b border-board-700/50 bg-board-950/80 backdrop-blur-md">
      <nav
        className={`mx-auto flex h-14 items-center justify-between gap-3 px-4 sm:px-6 ${
          wide ? "max-w-[1600px]" : "max-w-6xl"
        }`}
      >
        <Link href="/" className="group flex shrink-0 items-center gap-2" aria-label="AlgoStage 首页">
          <StageMark className="size-7" />
          <span className="chalk hidden text-[1.7rem] leading-none text-chalk-100 transition-colors group-hover:text-beam-gold sm:inline">
            AlgoStage
          </span>
          <span className="hidden text-xs text-chalk-500 md:inline">算法讲台</span>
        </Link>

        <div className="flex items-center gap-1">
          <ul className="flex items-center">
            {LINKS.map((link) => {
              const active = pathname === link.href || pathname.startsWith(link.href + "/");
              return (
                <li key={link.href}>
                  <Link
                    href={link.href}
                    aria-current={active ? "page" : undefined}
                    className={`relative block px-2.5 py-2 text-sm transition-colors sm:px-3 ${
                      active ? "text-chalk-100" : "text-chalk-500 hover:text-chalk-300"
                    }`}
                  >
                    {link.label}
                    {active && (
                      <motion.span
                        layoutId="nav-underline"
                        className="absolute inset-x-2 -bottom-0.5 h-[2px] origin-left -rotate-[0.6deg] rounded-full bg-beam-gold"
                        style={{ filter: "drop-shadow(0 0 4px color-mix(in srgb, var(--color-beam-gold) 60%, transparent))" }}
                        transition={{ type: "spring", stiffness: 380, damping: 32 }}
                      />
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
          <ThemeToggle />
        </div>
      </nav>
    </header>
  );
}
