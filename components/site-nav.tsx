"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "motion/react";

const LINKS = [
  { href: "/roadmap", label: "路线图" },
  { href: "/dashboard", label: "看板" },
  { href: "/review", label: "复习" },
  { href: "/settings", label: "设置" },
] as const;

export function SiteNav() {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-50 border-b border-board-700/40 bg-board-950/70 backdrop-blur-md">
      <nav className="mx-auto flex h-14 max-w-6xl items-center justify-between px-6">
        <Link href="/" className="group flex items-baseline gap-2">
          <span className="font-chalk text-2xl text-chalk-100 transition-colors group-hover:text-beam-gold [text-shadow:0_0_12px_rgba(244,241,232,0.25)]">
            AlgoStage
          </span>
          <span className="hidden text-xs text-chalk-500 sm:inline">
            · 算法讲台
          </span>
        </Link>

        <ul className="flex items-center gap-1 sm:gap-2">
          {LINKS.map((link) => {
            const active =
              pathname === link.href || pathname.startsWith(link.href + "/");
            return (
              <li key={link.href}>
                <Link
                  href={link.href}
                  className={`relative block px-3 py-2 text-sm transition-colors ${
                    active ? "text-chalk-100" : "text-chalk-500 hover:text-chalk-300"
                  }`}
                >
                  {link.label}
                  {active && (
                    <motion.span
                      layoutId="nav-underline"
                      className="absolute inset-x-2 -bottom-0.5 h-[2px] origin-left -rotate-[0.6deg] rounded-full bg-beam-gold"
                      style={{
                        filter: "drop-shadow(0 0 4px rgba(255, 209, 102, 0.6))",
                      }}
                      transition={{ type: "spring", stiffness: 380, damping: 32 }}
                    />
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </header>
  );
}
