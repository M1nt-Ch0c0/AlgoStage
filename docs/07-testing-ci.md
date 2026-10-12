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

`npm test` 使用 Vitest。旧版普通 `node:test` 测试通过 `tests/support/node-test.ts` 适配；判题矩阵在收集阶段发现子测试，每条用例独立执行和计数，并发上限为 2。带共享数据库生命周期的工具讲解测试使用 Vitest 的 `beforeAll` / `afterAll`，确保 fixture 在最后一条测试完成后才关闭；新增测试直接从 `vitest` 导入。

测试文件用独立 fork 隔离，文件之间顺序运行，避免环境变量和 Prisma 单例相互污染。API 测试使用临时 SQLite 与本地假模型服务，判题矩阵使用本地构建的 Worker 和真实 Pyodide，不需要 API Key。

`npm run test:coverage` 使用 V8，对 schema、provider/request、讲课路由（含缓存键）、local-source、anchors、判题模块及进度写入路由设置**逐文件** statements/branches/functions/lines 均不低于 60% 的门槛，包括未导入的目标文件。报告在 `coverage/index.html` 和 `coverage/lcov.info`。判题 Worker 的协议与输出限制测试直接执行源模块，真实 Worker 矩阵继续验证终止、超时及两种语言的全部判题结果。

当前分支没有独立的 SM-2 复习计算模块。客户端上报 AC 会被拒绝，也不会生成复习卡；`tests/core-data.test.ts` 与 `tests/progress.test.ts` 验证该边界并纳入进度路由覆盖率。真实判题结果持久化与完整 SM-2 后续接入时，应将实际模块加入覆盖范围。

Playwright 测试生产 Demo 构建，覆盖首页、题面和 Monaco 编辑器、内置讲解的播放/暂停/代码高亮，以及其他题目的 Demo 限制。运行前按上面的环境变量构建，确保公开开关编译进客户端。服务器自动创建、初始化、seed 并清理临时数据库，清空模型配置，禁止复用已有服务；浏览器只允许访问本机。默认端口 4173，冲突时可用 `E2E_PORT=4174 npm run test:e2e`。失败截图和 trace 位于 `test-results/`，HTML 报告位于 `playwright-report/`。

GitHub Actions 在 Node 22 上运行 `npm ci`、lint、typecheck、带覆盖率的完整测试、生产 Demo build 和 Chromium 冒烟测试，上传测试报告。独立 Docker job 运行 `docker build`，不登录镜像仓库、不推送镜像。
