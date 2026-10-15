# AlgoStage · 算法讲台

> 像老师站在黑板前讲课一样学算法 —— AI 讲到哪，聚光灯打到哪。

![讲课演示：舞台压暗 + 聚光灯 + 粉笔圈选 + 字幕](docs/assets/demo.gif)

AlgoStage 是一个**纯本地运行**的 LeetCode Hot 100 AI 学习系统：内置代码 playground、会讲课的 AI 导师（边讲边在页面上高亮当前位置、带华丽特效）、个人学习数据与看板。只需填入你自己的 **API Key + Model Name** 即可开始，无需任何服务器。

## 特性

- 🎯 **教鞭特效讲解**：AI 输出结构化讲解脚本，前端逐步播放 —— 聚光灯、粉笔划线、注意力涟漪、舞台压暗……讲到哪行代码，光就打在哪行
- 💻 **本地 Playground + 浏览器判题**：Monaco 编辑器；JS/TS 与 Python（Pyodide）在浏览器 Worker 中真实判题；JS/TS 提交时由服务端隔离复判。
- 🤖 **BYOK 内嵌 Agent**：填 API Key + model name 即用，基于 Vercel AI SDK，OpenAI / DeepSeek / Claude / Gemini 等几十家模型即插即用
- 📊 **个人看板**：刷题热力图、知识点掌握度、提示消耗、SM-2 间隔复习队列，全部存在本地 SQLite
- 🧩 **长期主义架构**：题目源、模型、特效、可视化器全部插件化，换数据源/换模型/加特效不动主框架
- 🔓 **开源合规**：不内置 LeetCode 题面原文，元数据 + 运行时客户端直取，见 [内容合规策略](docs/05-content-license.md)

## 快速开始

开发和验证请使用 **Node.js 22**（最低 22.12）；也支持 Node.js 24+。

```bash
npm ci                        # 按 package-lock.json 安装，与 CI 一致
cp .env.example .env          # 可选：也可以启动后在设置页填 API Key（见下方三步）
npm run db:push && npm run db:seed   # 初始化本地 SQLite + 灌入 Hot 100
npm run dev                   # http://localhost:3000
```

想先看看效果：打开 <https://demo.m1ntch0c0.com/algostage>，选「两数之和」，这道题自带内置讲解（含全部特效），不需要 API Key。

> 公共实例使用默认的 Docker Compose 部署，关闭了服务器 API Key（`ALGOSTAGE_DISABLE_SERVER_KEY=true`）：服务器不保存、不使用任何 API Key，设置页不能修改服务器设置。你在设置页填的 API Key 只保存在你这台浏览器里，每次讲课和提示请求时带上，只用于当次请求，不会存到服务器；可随时点「清除本机 API Key」。想长期用自己的 API Key，建议按下面的步骤自托管。

其余题目都要先配好 API Key 才能讲解和要提示。在设置页按三步填写：

1. **接口地址**：先选服务商，再填对应地址。OpenAI 兼容服务留空时使用 `https://api.openai.com/v1`；Anthropic、Google 留空使用官方接口。
2. **API Key**：填写与上面接口地址同一来源的 API Key，来源混用会被拒绝。
3. **模型名**：推荐 `gpt-6.1-sol`（设置页默认值）。较弱模型可能无法完成教案或正确调用教学工具，失败时请重试或更换模型。

保存前可以先点「测试连接」，确认能连上。

讲解通过五种教学工具逐步生成，收到步骤即可播放；只有完整教案校验成功才保存缓存。较弱模型可能无法完成讲解或正确调用工具，失败时建议重试或切换到 `gpt-6.1-sol`。备课总上限为 240 秒，非法工具参数最多重试该次调用 2 次，已完成步骤会保留。

使用环境变量 API Key 时，请同时填写 `AI_BASE_URL`，并按服务商配置 `AI_PROVIDER`；设置页可单独覆盖模型名，接口地址和 API Key 必须保持同一来源。设置页只保存实际修改的字段；保存新 API Key 时请同时填写对应接口地址和服务商，来源混用会被拒绝，不会发出模型请求。

### 服务器 API Key 与接口地址（v0.2.1）

| 环境变量 | 默认值 | 可选值 | 作用 |
| --- | --- | --- | --- |
| `ALGOSTAGE_DISABLE_SERVER_KEY` | `false` | `true`/`false`、`on`/`off`、`1`/`0`、`yes`/`no`（不区分大小写） | 设为开启时，服务器不保存、不使用服务器 API Key，设置页不能修改服务器设置，讲课和提示请求需自带 API Key。`deploy/compose.yaml` 设为 `true`。设置页提示「API Key 只保存在你这台浏览器里，不会存到服务器。」，讲课和提示请求自动带上，可点「清除本机 API Key」。 |
| `ALGOSTAGE_ALLOW_PRIVATE_BASE_URL` | `true` | 同上 | 关闭时拒绝内网、本机和保留地址的接口地址。默认允许，方便自托管连接本机或内网模型；`deploy/compose.yaml` 设为 `false`。 |

接口地址只接受 http(s)，不跟随重定向。服务器 API Key 只会发往服务器配置的接口地址；改用其他接口地址时需要同时填你自己的 API Key。详见 [deploy/README.md](deploy/README.md#环境变量自托管)。

### 常见错误

| 错误码 | 什么时候出现 | 怎么处理 |
| --- | --- | --- |
| `UPSTREAM_AUTH`（HTTP 400） | 提示、讲课或测试连接时模型服务返回 401/403，`retryable: false`，不会自动重试；服务端文案「API Key 无效或没有权限」。讲课和提示区显示「API Key 无效或没有权限，去设置页检查一下就能开讲。」，只有「去设置」按钮；设置页在 API Key 输入框下显示红字「API Key 无效或没有权限」，不放按钮。 | 到设置页检查 API Key 是否正确、有没有该模型的权限，并确认 API Key 和接口地址来自同一家服务。 |
| `NO_BYOK`（HTTP 400） | 没填 API Key 就点了「开始讲课」、要提示或提问（公共实例等关闭服务器 API Key 的部署）。和题目页上方的「这道题的 AI 讲解需要你自己的 API Key。」提示不同，这是点击后的报错。讲课、提示和提问统一显示「老师还没接上 AI，先去设置里填自己的 Key。」，只有「去设置」按钮。不显示「重试讲课」。 | 到设置页填入你自己的 API Key。 |
| `BYOK_KEY_REQUIRED`（HTTP 400） | 用了与服务器配置不同的接口地址，但没有填自己的 API Key，提示「用自定义接口地址时，需要同时填你自己的 API Key」。 | 在设置页同时填写该接口地址对应的 API Key。 |
| `BASE_URL_INVALID`（HTTP 400） | 接口地址格式不对（不是 http(s)、缺少主机等）。设置页在接口地址输入框下显示红字「接口地址格式不对，要以 http:// 或 https:// 开头」；讲课和提示区显示「接口地址格式不对，要以 http:// 或 https:// 开头，去设置页改一下就能开讲。」，带「去设置」按钮。 | 改成以 `http://` 或 `https://` 开头的完整地址。 |
| `BASE_URL_NOT_ALLOWED`（HTTP 400） | 仅在 `ALGOSTAGE_ALLOW_PRIVATE_BASE_URL` 关闭时（如 Docker 默认部署），接口地址指向内网、本机或保留地址。设置页在接口地址输入框下显示红字「接口地址只支持公网 http(s) 地址」；讲课和提示区显示「接口地址只支持公网 http(s) 地址，去设置页改一下就能开讲。」，只有「去设置」按钮，不显示「重试讲课」。 | 改用公网接口地址；自托管需要连本机或内网模型时，在可信环境中把该开关设为 `true`。 |
| `UPSTREAM_ERROR`（HTTP 502） | 连不上模型服务，或部署者在 `AI_BASE_URL` 里配了不合法或指向内网的地址（此时不发起出站请求）；服务端文案「AI 服务暂时连不上，请稍后再试。」。讲课和提示区只有「重试」，不带「去设置」。 | 稍后重试；自托管请检查环境变量 `AI_BASE_URL`。 |

讲课流开始后，NDJSON 错误事件只含 `type: "error"`、`code`、`retryable`；第一个步骤之前的失败仍返回真实的 HTTP 错误响应。

### 圈选提问（v0.3）

讲课中途可以对讲台上的内容向老师追问，回答挂在**当前这一步下面**，不会增加总步数，也不会改时间线进度。

1. 点字幕卡上的 **「圈选提问」**（讲课会自动暂停）。
2. **拖框**圈选字幕、代码或可视化，或用捷径 **「当前字幕」 / 「当前步骤」 / 「可视化整块」**。提示：「拖动画框，或点一下选中；双指可滚动」。
3. 在面板里输入问题（最多 300 字），或点快捷句「这一步在做什么？」「为什么这样写？」「换个例子讲讲」，再点 **「提问」**。
4. 等待时会看到「老师在想…已等待 N 秒」，可取消。回答出现在当前步下，带 **「你问的」** 标签；可折叠、可 **「播放回答」**，或 **「回到这一步」** 停在原位置。

**什么时候不能问（按钮置灰，仍可见）：**

| 情况 | 提示 |
| --- | --- |
| 正在备课 | 备课完成后可以提问 |
| 内置「两数之和」讲解 | 生成讲课后就可以提问 |
| 这节课没完整缓存 | 这节课没讲完，重新生成后就可以提问 |
| 当前步被标为不可问 | 这一步暂时不能提问，重新生成这节课后就可以了 |
| 上一条回答还在生成或播放 | 上一个问题还在回答，答完再问 |

Esc 或 **「退出圈选」** 可退出画选并恢复讲课。换步会丢掉未发送的草稿；同一步内点「取消」会保留选区和草稿。

**隐私：** 公开实例上，提问与回答只存在你这台浏览器（`localStorage`），服务器不保存提问内容；清除站点数据后回答会丢失。提问仍走你配置的 API Key（与讲课相同的 BYOK / 服务器 Key 规则）。

**重新生成：** 若本课已有提问，确认框会写「重新生成会清掉当前教案，确定吗？你问过的 N 个问题会被清掉」。

验证命令：`npm run lint`、`npm run typecheck`、`npm test`、`npm run test:e2e`、`npm run build`。

## 从旧版本升级

```bash
npm ci
npm run db:push
```

v0.2.0 给 `Submission` 加了 `judgedBy`。保留旧库却不跑 `db:push` 时，学习看板会 500。补列不丢记录。Docker 启动会自动 `db push`。

## 判题

- 覆盖：Hot 100 前 20 题；2 秒超时；输出超 32 KiB → RE；支持 `class Solution`；Python 打开题目页预热。
- JS/TS：浏览器先跑 → `/api/judge` 服务端复判 → 仅服务端 AC 写进度。
- Python：服务端不可判，接受浏览器 AC（`judgedBy: client`）。
- 已 solved 不因 WA/RE/TLE 或重听课退回 learning。
- 构建自动 `build:judge`；`/judge/*` 需 COOP/COEP（Next 已加）。
- 可选环境变量 `JUDGE_MAX_CONCURRENCY`（默认 4，最大 64，按进程计）。

## Docker 自托管

```bash
docker buildx build --build-arg BASE_PATH=/algostage -t algostage:0.3.1 --load .
# 或
ALGOSTAGE_IMAGE_TAG=0.3.1 docker compose -f deploy/compose.yaml up -d --no-build --wait
```

需自备 API Key。镜像内 `DATA_DIR=/data`，数据库为 `/data/algostage.db`（挂载数据卷 `algostage-data`）；本地非 Docker 运行时默认用 `.env` 里的 `DATABASE_URL`（`file:./algostage.db`）。详见 [deploy/README.md](deploy/README.md)。

容器以非 root 用户 `algostage`（UID/GID `1001:1001`）运行。从 0.2.1 之前的版本升级时，旧数据卷归 root 所有，需先停旧容器、按 [deploy/README.md](deploy/README.md#升级至-021非-root-运行) 把数据卷备份到源码目录之外（如 `~/algostage-backups/`），再执行一次：

```bash
docker run --rm -v algostage-data:/data alpine chown -R 1001:1001 /data
```

不处理时容器启动会报 `Error: data directory /data is not writable (uid 1001).` 并退出。

> 不要把备份放在源码目录里（会被打进镜像或误提交）：`.gitignore`、`.dockerignore` 只忽略 `prisma/*.db`，不覆盖备份包和 `-wal`/`-shm` 文件。

## 版本说明

- `v0.2.0-alpha.2` 指向 `7fd9024`。
- `v0.2.0-alpha.3`（Pre-release）指向 `32ad289`，在 alpha.2 基础上只修了 Docker 入口（Prisma 7 的 `db push` 去掉 `--skip-generate`）；该 tag 中 `package.json` 仍写 `0.2.0-alpha.1`。
- 当前版本为 v0.3.1：`package.json`、`deploy/compose.yaml` 镜像标签和 CHANGELOG 均为 `0.3.1`。

## 子路径 + nginx

构建时设 `NEXT_PUBLIC_BASE_PATH`。讲解流 `application/x-ndjson`，需关代理缓冲（应用已发 `X-Accel-Buffering: no`）；`/algostage/api/lecture` 独立 location，读超时 300 秒。

## 提示超时

`.env` 可设 `HINT_TIMEOUT_MS`（默认 60000）。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/00-research.md](docs/00-research.md) | 竞品与开源项目调研（站在哪些巨人肩膀上） |
| [docs/01-architecture.md](docs/01-architecture.md) | 总体架构与插件化扩展点（骨架设计） |
| [docs/02-frontend-design.md](docs/02-frontend-design.md) | **前端设计文档（核心）**：视觉语言、动效系统、特效清单、页面设计 |
| [docs/03-teaching-protocol.md](docs/03-teaching-protocol.md) | 讲解脚本协议：AI 如何描述"讲什么、指哪里、放什么特效" |
| [docs/04-data-model.md](docs/04-data-model.md) | 数据模型与看板指标 |
| [docs/05-content-license.md](docs/05-content-license.md) | 开源内容合规策略 |
| [docs/06-judge-design.md](docs/06-judge-design.md) | 判题分层设计：JudgeBackend 插件点与四个后端（浏览器沙箱/本机编译器/Judge0/LeetCode 远程） |

## 技术栈

Next.js (App Router) · TypeScript · Tailwind CSS v4 · Motion (Framer Motion) · Monaco Editor · Vercel AI SDK · Prisma + SQLite · Zustand

## 致谢与参考

[krahets/hello-algo](https://github.com/krahets/hello-algo) · [algorithm-visualizer](https://github.com/algorithm-visualizer/algorithm-visualizer) (MIT) · [doocs/leetcode](https://github.com/doocs/leetcode) · [karanb192/algo-sensei](https://github.com/karanb192/algo-sensei) · [HugeCatLab/ChatTutor](https://github.com/HugeCatLab/ChatTutor) · [CopilotKit](https://github.com/CopilotKit/CopilotKit) · [LeetCode-OpenSource/vscode-leetcode](https://github.com/LeetCode-OpenSource/vscode-leetcode)

## License

MIT（代码）。题目内容来源与合规说明见 [docs/05-content-license.md](docs/05-content-license.md)。
