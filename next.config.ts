import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // sshfs 网关拒绝解析 .next 内的 ../ symlink（见 AGENTS.md），
  // 强制将 prisma 打包进 bundle 而非外置，绕过外部化产生的链接
  transpilePackages: ["@prisma/client", "prisma"],
};

export default nextConfig;
