/**
 * 运行形态（构建时由环境变量决定，客户端与服务端通用）
 *  - NEXT_PUBLIC_BASE_PATH：部署在子路径下时的前缀，如 "/a1"（需与 next.config.ts 的 basePath 一致）
 */
export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

/** 给站内 API 路径补上子路径前缀（fetch 不会自动加 basePath） */
export function apiPath(path: string): string {
  return `${BASE_PATH}${path}`;
}

export const REPO_URL = "https://github.com/M1nt-Ch0c0/AlgoStage";
