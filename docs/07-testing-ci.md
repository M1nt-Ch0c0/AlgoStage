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

客户端上报 AC 会被拒绝，不产生任何写入。`POST /api/judge` 根据服务端内置用例在独立 Node 进程中复跑 JS/TS，只有真实 AC 才能设置 solved；Python 暂返回“服务端无法判定”，不会记录 AC。`lib/progress.ts` 在同一事务中记录提交、保持 solved/mastered 状态，并按 docs/04 的简版 SM-2 更新复习卡（AC 5 分、失败 2 分；失败回到一天后）。无用例的题和讲解上报不会创建复习卡。

`tests/progress.test.ts`、`tests/progress-judge.test.ts` 覆盖客户端伪造 AC、服务端 AC/WA/RE/TLE、solved/mastered 不降级、首次 solvedAt 保留，以及看板/题目列表/到期复习的实际数据库读取。`tests/judge-server.test.ts` 在前 20 题上复跑服务端用例，并验证超时、输出限制和进程隔离；`tests/judge-persistence.test.ts` 验证控件以服务端判定为准及 Python 无法持久化 AC 的提示。无需假模型的 API 测试使用 `createFixture({ modelServer: false })`，数据库仍是独立临时 SQLite。

共享 `node_modules` 的 worktree 可用 `npm test -- --configLoader=runner` 避免配置加载器在依赖目录生成临时文件；测试缓存写到本 worktree 的 `.next/cache/vitest`。禁止监听端口的环境无法运行需要本地假模型 HTTP 服务的测试，但上述 S9-11 回归不依赖监听端口。

Playwright 测试生产 Demo 构建，覆盖首页、题面和 Monaco 编辑器、内置讲解的播放/暂停/代码高亮，以及其他题目的 Demo 限制。运行前按上面的环境变量构建，确保公开开关编译进客户端。服务器自动创建、初始化、seed 并清理临时数据库，清空模型配置，禁止复用已有服务；浏览器只允许访问本机。默认端口 4173，冲突时可用 `E2E_PORT=4174 npm run test:e2e`。失败截图和 trace 位于 `test-results/`，HTML 报告位于 `playwright-report/`。

GitHub Actions 在 Node 22 上运行 `npm ci`、lint、typecheck、带覆盖率的完整测试、生产 Demo build 和 Chromium 冒烟测试，上传测试报告。独立 Docker job 运行 `docker build`，不登录镜像仓库、不推送镜像。
