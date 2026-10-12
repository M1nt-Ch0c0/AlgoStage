import type { Metadata } from "next";
import Script from "next/script";
import { Caveat, Inter, JetBrains_Mono, Long_Cang } from "next/font/google";
import { SiteNav } from "@/components/site-nav";
import { SiteFooter } from "@/components/site-footer";
import { DemoBanner } from "@/components/demo-banner";
import { THEME_BOOT_SCRIPT } from "@/lib/theme";
import "./globals.css";

// next/font 在构建时把字体下载到本地，运行时不访问 Google（符合"纯本地"）
const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const jetbrains = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains",
  display: "swap",
});
const caveat = Caveat({
  subsets: ["latin"],
  weight: ["400", "600"],
  variable: "--font-caveat",
  display: "swap",
});
// 中文手写板书字体：字库按 unicode-range 分片，按需加载，不预载
const longCang = Long_Cang({
  weight: "400",
  subsets: ["latin"],
  variable: "--font-longcang",
  display: "swap",
  preload: false,
});

export const metadata: Metadata = {
  title: "AlgoStage · 算法讲台",
  description:
    "像老师站在黑板前讲课一样学算法。老师讲到哪，光就照到哪。",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="zh-CN"
      data-theme="dark"
      suppressHydrationWarning
      className={`${inter.variable} ${jetbrains.variable} ${caveat.variable} ${longCang.variable}`}
    >
      <head>
        {/* beforeInteractive：随服务端 HTML 下发、首帧前执行，React 不会再报 script 标签警告 */}
        <Script id="theme-boot" strategy="beforeInteractive">
          {THEME_BOOT_SCRIPT}
        </Script>
      </head>
      <body className="flex min-h-screen flex-col antialiased">
        <DemoBanner />
        <SiteNav />
        <main className="flex-1">{children}</main>
        <SiteFooter />
      </body>
    </html>
  );
}
