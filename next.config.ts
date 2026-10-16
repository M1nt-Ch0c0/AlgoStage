import type { NextConfig } from "next";

// 部署在子路径（如 https://demo.example.com/a1）时设置 NEXT_PUBLIC_BASE_PATH=/a1
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || undefined;

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // An unset NEXT_PUBLIC_ value is not inlined, so the capture stall block
  // would survive a release build as a runtime read. Empty strings are
  // inlined and the block is dropped. A hook build sets both in the
  // environment, and config env does not override an existing value.
  env: {
    NEXT_PUBLIC_ASK_TEST_BUILD: process.env.NEXT_PUBLIC_ASK_TEST_BUILD ?? "",
    NEXT_PUBLIC_ASK_TEST_STALL_MS: process.env.NEXT_PUBLIC_ASK_TEST_STALL_MS ?? "",
  },
  async headers() {
    return [{ source: "/judge/:path*", headers: [
      { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
      { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
    ] }];
  },
  basePath,
  // SQLite 驱动含原生模块，由 Node 在服务端加载。
  serverExternalPackages: ["@prisma/adapter-better-sqlite3", "better-sqlite3"],
};

export default nextConfig;
