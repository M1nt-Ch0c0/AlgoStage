import type { NextConfig } from "next";

// 部署在子路径（如 https://demo.example.com/a1）时设置 NEXT_PUBLIC_BASE_PATH=/a1
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || undefined;

const nextConfig: NextConfig = {
  reactStrictMode: true,
  basePath,
  // sshfs 网关拒绝解析 .next 内的 ../ symlink（见 AGENTS.md），
  // 强制将 prisma 打包进 bundle 而非外置，绕过外部化产生的链接
  transpilePackages: ["@prisma/client", "prisma"],
};

export default nextConfig;
