# 05 · 开源内容合规策略

Spotlight 要以 MIT 协议在 GitHub 公开发布并大力宣传，因此**仓库本体不得包含任何第三方受版权保护的内容**。策略如下：

## 一、LeetCode 题面：不内置，运行时客户端直取

- LeetCode 题面文字版权归 LeetCode 所有，**算法思想不受保护，文字表达受保护**。
- 仓库只内置**元数据**：题号、标题、slug、难度、标签、模式分类、前置知识（这些是事实性信息 + 自研编排，可自由发布）。
- 完整题面在**运行时由用户本地客户端直接请求 LeetCode 公开 GraphQL API** 获取（与官方生态插件 [vscode-leetcode](https://github.com/LeetCode-OpenSource/vscode-leetcode) 相同的做法）：
  - 请求从用户机器发出，不经过任何中间服务器；
  - 获取的内容只缓存在用户本地，不进入仓库、不再分发；
  - 拉取失败时降级显示元数据 + 跳转链接。

## 二、可选内容包：AI 改写版题面（独立仓库）

- 另设独立内容仓库（如 `spotlight-content`），存放**用我们自己的话重述**的题面（AI 初稿 + 人工校对），以 CC-BY-4.0 发布。
- 主仓库通过 `ProblemSource` 插件接口可选接入，不硬绑定。

## 三、参考题解与讲解脚本：全部自产

| 内容 | 来源策略 | 理由 |
|---|---|---|
| 参考题解代码 | 自写 + AI 生成 + 人工校对 | doocs/leetcode 为 CC-BY-SA-4.0（传染性），直接引入会污染主仓库 License；Hot 100 参考实现都很短，自产成本可控 |
| 讲解脚本（教案） | AI 基于自产题解生成 + 少量精品人工打磨 | 自有版权，可随 MIT 发布 |
| 数据结构示意图/动画 | 自绘（SVG/CSS 动效） | hello-algo 内容为 CC 系（含 NC），不可直接取用 |

## 四、参考项目的 License 边界（2026-09 核实）

| 项目 | License | 可以做什么 |
|---|---|---|
| algorithm-visualizer | **MIT** | 可复用代码片段（保留版权声明） |
| CopilotKit / Vercel AI SDK / assistant-ui | MIT / Apache-2.0 | 作为依赖引用，无顾虑 |
| ChatTutor | **AGPL-3.0** | 只学思路（tool 驱动 UI 的模式），**不复制代码** |
| datawhalechina/algo-vis | **无 License** | 法律上 = 保留所有权利，只参考架构思路 |
| hello-algo | 混合（内容 CC 系） | 只学内容组织方式 |
| doocs/leetcode | CC-BY-SA-4.0 | 不引入；仅人工参考解题思路后自写 |

## 五、自查清单（每次发布前）

- [ ] 仓库内无 LeetCode 题面原文（搜几个标志性句子验证）
- [ ] 无 doocs/hello-algo 的文本或图片
- [ ] 无 AGPL 项目的复制代码
- [ ] 第三方依赖的 License 与 MIT 兼容
- [ ] README 致谢与数据来源声明完整
