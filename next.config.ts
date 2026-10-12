import type { NextConfig } from "next";

// 部署在子路径（如 https://demo.example.com/a1）时设置 NEXT_PUBLIC_BASE_PATH=/a1
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || undefined;

const nextConfig: NextConfig = {
  reactStrictMode: true,
  basePath,
  // SQLite 驱动含原生模块，由 Node 在服务端加载。
  serverExternalPackages: ["@prisma/adapter-better-sqlite3", "better-sqlite3"],
};

export default nextConfig;
