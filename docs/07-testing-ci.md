# 测试与 CI（S11）

使用 Node 22（`.nvmrc`）和 Python 3；所有新增开发依赖均锁定确切版本。

```bash
npm ci
npm run lint
npm run typecheck
npm test
npm run test:coverage
NEXT_PUBLIC_ALGOSTAGE_DEMO=1 NEXT_PUBLIC_BASE_PATH= npm run build
npx playwright install --with-deps chromium
npm run test:e2e
```

`npm test` 使用 Vitest。迁移前的 Node 测试基线为 **180 条**（20 条顶层测试，含 160 条判题子测试），原测试文件保持不变。`tests/support/node-test.ts` 将现有的两个 `node:test` 签名适配到 Vitest：普通测试直接注册，判题矩阵在收集阶段发现子测试，并单独保留父测试的断言结果。子测试并发上限为 2，每个子测试都会执行和计数；新测试直接从 `vitest` 导入。本次另加 10 条核心模块测试，总数为 190。

测试文件用独立 fork 隔离，文件之间顺序运行，避免环境变量和 Prisma 单例相互污染。API 测试使用临时 SQLite 与本地假模型服务，判题矩阵使用本地构建的 Worker 和真实 Pyodide，不需要 API Key。

`npm run test:coverage` 使用 V8，对 schema、provider/request、讲课路由（含缓存键）、local-source、anchors、判题模块及进度写入路由设置**逐文件** statements/branches/functions/lines 均不低于 60% 的门槛，包括未导入的目标文件。报告在 `coverage/index.html` 和 `coverage/lcov.info`。判题 Worker 的协议与输出限制测试直接执行源模块，真实 Worker 矩阵继续验证终止、超时及两种语言的全部判题结果。

当前分支没有独立的 SM-2 复习计算模块；现有实现仅在 AC 后创建次日到期的复习卡。这部分由 `tests/core-data.test.ts` 验证并纳入进度路由覆盖率。后续接入完整 SM-2 时，应将实际模块加入 `vitest.config.ts` 的覆盖范围，不能将本报告理解成完整 SM-2 算法已通过覆盖率验收。

Playwright 测试生产 Demo 构建，覆盖首页、题面和 Monaco 编辑器、内置讲解的播放/暂停/代码高亮，以及其他题目的 Demo 限制。运行前按上面的环境变量构建，确保公开开关编译进客户端。服务器自动创建、初始化、seed 并清理临时数据库，清空模型配置，禁止复用已有服务；浏览器只允许访问本机。默认端口 4173，冲突时可用 `E2E_PORT=4174 npm run test:e2e`。失败截图和 trace 位于 `test-results/`，HTML 报告位于 `playwright-report/`。

GitHub Actions 在 Node 22 上运行 `npm ci`、lint、typecheck、带覆盖率的完整测试、生产 Demo build 和 Chromium 冒烟测试，上传测试报告。独立 Docker job 运行 `docker build`，不登录镜像仓库、不推送镜像。
