# Changelog

## [0.2.1] - 未发布

### 新增
- 没配 Key 时的提示：落地页显示「两数之和可以直接看 AI 讲解。其他题需要先在设置页填入你自己的 API Key。」；除两数之和外的题目页显示「这道题的 AI 讲解需要你自己的 API Key。」，附「去设置」和「先看两数之和」；配好 Key 后提示消失。
- 【待合入】讲解默认不自动翻页：每步播完提示「按空格继续」并高亮下一步；焦点在输入框或编辑器时空格和 → 不翻页；自动播放开关默认关，刷新、换题后保留。
- 【待合入】讲完后的结束面板：主按钮「下一题」（按路线图顺序，最后一题换成「回路线图」），次按钮「重播」「回路线图」；「重新生成」收进更多菜单并需二次确认。

### 修复
- 备课时显示「备课中」，不再显示满格的「1/1」进度。
- 49 题示例表格自动换行，不再截断或横向滚动。
- 设置页 base URL 输入框改用普通字体，`https://` 显示正常、不错位。
- Key 掩码只显示后 4 位。
- 推荐模型三处统一为 `gpt-6.1-sol`（代码默认值、设置页、README），已加测试锁定。
- 【待合入，随 A1】换题后不残留上一题的可视化。

### 部署
- Docker 镜像改用 `algostage` 用户（UID/GID `1001:1001`）非 root 运行，只有 `/app/.next`、`/app/data`、`/data` 归该用户所有。
- 启动前检查数据目录（`DATA_DIR`，镜像内为 `/data`）是否可写；不可写时输出当前 UID 和一次性修复命令并退出，不在应用容器内执行 `chown`。

### 升级说明
- 由旧版（root 运行）容器创建的数据卷归 root 所有，升级前必须先改属主：停止旧容器并备份数据库（含 `-wal` / `-shm`），执行一次 `docker run --rm -v algostage-data:/data alpine chown -R 1001:1001 /data`，再切换新镜像。不处理则容器启动时报 `Error: data directory /data is not writable (uid 1001).` 并退出。详见 [部署说明](deploy/README.md#升级至-021非-root-运行)。

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
