# 01 · 总体架构（骨架版）

> 本文档刻意保持精简：定方向、定边界、定扩展点。详细模块设计留给后续迭代（与其他 agent 协作时以此为准）。

## 0. 硬性约束（来自产品决策）

1. **纯本地**：单进程跑起来，无任何外部服务依赖；唯一出网请求是用户机器直连模型厂商。
2. **BYOK**：填 API Key + Model Name 即可用，Key 只存本地。
3. **长期主义**：题目源、模型、特效、可视化器、教学模式全部插件化；主框架只做编排。

## 1. 架构总览

```
┌─────────────────────────── 浏览器 ───────────────────────────┐
│ UI 层        React 19 + Tailwind v4 + Motion + Monaco        │
│  ├── 特效系统  EffectRegistry / EffectStage   （插件点 ④）    │
│  ├── 播放器    Player 状态机（Zustand）                      │
│  └── 可视化器  VisualizerRegistry             （插件点 ⑤）    │
├──────────────────────────────────────────────────────────────┤
│ 应用层（Next.js Route Handlers / Server Actions）             │
│  ├── Agent 链路  AI SDK：provider 适配 + 流式 data parts      │
│  │              （插件点 ②：模型 Provider = 字符串切换）       │
│  ├── 教学引擎  TeachingScript 生成/校验/缓存                   │
│  │         教学模式（讲解/提示/评审/面试）= prompt 模块（插件点③）│
│  └── 内容服务  ProblemSource 接口             （插件点 ①）    │
├──────────────────────────────────────────────────────────────┤
│ 数据层        Prisma + SQLite（本地文件 algostage.db）         │
└──────────────────────────────────────────────────────────────┘
        │ 出网仅一条：HTTPS → 用户配置的模型厂商 API
```

## 2. 五个插件点（扩展都从这里进，不动主框架）

### ① ProblemSource · 题目源
```ts
interface ProblemSource {
  list(): Promise<ProblemMeta[]>;              // 元数据：题号/标题/slug/难度/标签/模式/前置
  detail(slug: string): Promise<ProblemDetail>; // 题面（含改写版或运行时拉取结果）
  reference(slug: string): Promise<Solution[]>; // 自产参考题解
}
```
内置实现：`local-seed`（仓库种子数据）· `leetcode-live`（运行时客户端直取公开 GraphQL）· 未来可加 `content-pack`（改写版内容包）、`codeforces` 等。

### ② ModelProvider · 模型
统一走 Vercel AI SDK provider registry：`provider:model` 字符串 + Key，设置页可热改。新模型 = 加一行注册。

### ③ TeachingMode · 教学模式
每种模式 = 一个 prompt 模块 + 输出 schema：`lecture`（讲课脚本）/ `hint`（5 级渐进提示）/ `review`（代码评审）/ `interview`（模拟面试）。新增模式 = `lib/agent/modes/` 下加一个文件并在 `modes.ts` 注册。

### ④ Effect · 特效
见 [02-frontend-design.md §3.1](02-frontend-design.md)。`registerEffect()` 一行接入。

### ⑤ Visualizer · 可视化器
`state → SVG` 纯函数组件，按题目 `vizType` 注册到 `VisualizerRegistry`。新题型 = 新组件 + 一行注册。

### ⑥ JudgeBackend · 判题后端（详见 [06-judge-design.md](06-judge-design.md)）
```ts
interface JudgeBackend {
  name: string;
  languages: JudgeLanguage[];
  available(): Promise<{ ok: boolean; reason?: string }>;
  judge(input): Promise<JudgeResult>;
}
```
四个实现：browser-sandbox（默认，JS/Python 浏览器内）· native-local（默认，C++/Java 本机编译器）· judge0-docker（opt-in）· leetcode-remote（opt-in）。新判题后端 = 实现接口 + 注册一行。

## 3. 目录结构

```
app/                 # Next.js 路由（页面见 02 文档 §5.1）
  api/               # agent 流式接口、problem 内容接口
components/          # 见 02 文档 §6
lib/
  agent/             # BYOK 配置、provider 注册、模式 prompt、脚本生成
  content/           # ProblemSource 实现 + 种子数据
  effects/           # 特效注册表与锚点解析
  player/            # 播放器状态机
  judge/             # JudgeBackend 接口、注册表、四个后端实现（docs/06）
  db/                # Prisma schema、数据访问层（看板指标计算）
docs/                # 本套文档
```

## 4. 关键链路

**AI 讲课**：`设置页 BYOK → /api/lecture 流式请求 → AI 输出 TeachingScript JSON（03 文档）→ 流式 data parts 推给前端 → Player 逐步接收并开始播放 → EffectStage 执行特效`。
脚本带缓存（同题同模型同语言只生成一次，落 SQLite）。

**练习判题**（docs/06）：`Monaco 代码 → JudgeRouter 按语言路由（browser-sandbox / native-local）→ 真判题 → verdict 写库 → 看板更新 + AC 触发 Confetti`。

## 5. 显式不做（一期）

- 多用户/账号体系（本地单档案，预留 User 表字段以便二期扩展）
- 运行时插桩式可视化（用预编排步骤帧，见 00 调研结论）
- 语音讲解（Pipecat 二期可选）
- 多租户安全沙箱（单用户本地场景，见 docs/06 §0；judge0 仅作 opt-in 插件）
