# Changelog

## Unreleased (0.2.1)

### 变更
- Docker 镜像改用 `algostage`（UID/GID `1001:1001`）非 root 运行；启动前检查数据目录可写性，失败时输出当前 UID 和一次性修复命令，不在应用容器内执行 `chown`。

### 升级须知
- root 拥有的旧数据卷：先停止旧容器并备份数据库，再执行一次 `docker run --rm -v algostage-data:/data alpine chown -R 1001:1001 /data`，最后切换新镜像；详见 [部署说明](deploy/README.md#升级至-021非-root-运行)。

## [0.2.0-alpha.2] - 2026-10-13

### 升级须知
- 更新后先执行 `npm ci` 与 `npm run db:push`（补 `Submission.judgedBy`；不跑则看板可能 500）。Docker 启动会自动 `db push`。
- 若从旧 Demo 数据卷迁移，见 deploy/README「数据卷迁移说明」；勿 `docker compose down -v`。

### 新增
- 浏览器判题（JS/TS、Python）+ JS/TS 服务端复判；前 20 题；`class Solution`；Python 预热。
- 讲解工具调用逐步生成；默认推荐 `gpt-6.1-sol`；备课上限 240 秒。
- 复习页接真实 SM-2；Key 来源徽标；草稿按题/语言保存。
- Docker 自托管、子路径、nginx 流式讲解配置。
- CI：lint、typecheck、Vitest、Playwright、docker build。
- `HINT_TIMEOUT_MS`、`JUDGE_MAX_CONCURRENCY`。

### 变更
- 移除在线体验版（Demo）及 `NEXT_PUBLIC_ALGOSTAGE_DEMO`。
- 已 solved 不因 WA/RE/TLE 或重听课退回 learning。
- Key 与接口地址必须同一来源；安装改用 `npm ci`。
- 部署改为 docker buildx build（服务器用 --allow network.host --network host）+ --load，再 docker compose up --no-build；镜像 tag 由 ALGOSTAGE_IMAGE_TAG 指定，默认取当前版本。

### 修复
- 讲解流代理缓冲关闭与超时透传（见 deploy/README nginx 回归）。
- 拒绝伪造的客户端 JS/TS AC；上游错误不透传。
- Docker 入口：Prisma 7 的 db push 不再使用 --skip-generate。

### 安全与依赖
- Next.js 16.4.0、Prisma 7.10.0；【待定 S13】等 10/14 补丁结论。

## [0.2.0-alpha.1] - 2026-10-12

首个预发布版，含浏览器判题和讲解工具调用。
