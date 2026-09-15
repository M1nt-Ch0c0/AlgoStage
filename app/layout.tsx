import type { Metadata } from "next";
import { SiteNav } from "@/components/site-nav";
import "./globals.css";

export const metadata: Metadata = {
  title: "Spotlight · 聚光算法导师",
  description:
    "像老师站在黑板前讲课一样学算法 —— AI 讲到哪，聚光灯打到哪。纯本地运行，填入 API Key 即可开课。",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN" data-theme="dark">
      <body className="flex min-h-screen flex-col antialiased">
        <SiteNav />
        <main className="flex-1">{children}</main>
      </body>
    </html>
  );
}
