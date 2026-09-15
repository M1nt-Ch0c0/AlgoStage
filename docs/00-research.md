# 00 · 调研报告：站在哪些巨人肩膀上

> 调研时间：2026-09。Star 数经 GitHub API 实时核实。

## 核心结论

**"AI 教学 + 刷题平台" 是空白区。** 高 Star 的算法学习仓库全都不带 AI；带 AI 的刷题工具 Star 普遍 < 300，且都是侧边栏问答形态。**没有一个产品做到"像老师讲课一样，边讲边在页面上高亮当前位置并带特效"** —— 这正是 Spotlight 的主打卖点。

## 一、内容层（题库、题解、学习路径）

| 项目 | Star | 借鉴点 |
|---|---|---|
| [krahets/hello-algo](https://github.com/krahets/hello-algo) | 130k | 动画图解 + 一键运行的内容形态；一题多语言 tab 的组织方式 |
| [labuladong/fucking-algorithm](https://github.com/labuladong/fucking-algorithm) | 136k | "框架思维/套路"的叙事方式，适合作为 AI 讲解的内容骨架 |
| [youngyangyang04/leetcode-master](https://github.com/youngyangyang04/leetcode-master)（代码随想录） | 62.5k | 按知识脉络排序的刷题路线 |
| [doocs/leetcode](https://github.com/doocs/leetcode) | 36.6k | 全题库规整多语言题解（CC-BY-SA-4.0，仅作参考，不直接引入，见 05 文档） |
| [seanprashad/leetcode-patterns](https://github.com/seanprashad/leetcode-patterns) | 13.7k | Pattern-based 题单组织 |

## 二、AI 教学层（最大差异化机会）

| 项目 | Star | 借鉴点 |
|---|---|---|
| [karanb192/algo-sensei](https://github.com/karanb192/algo-sensei) | 273 | **5 级渐进提示**（观察→模式→方向→技巧→伪代码）；Tutor/Hint/Review/Interview 模式路由；纯 prompt 即可实现导师人格 |
| [JushBJJ/Mr.-Ranedeer-AI-Tutor](https://github.com/JushBJJ/Mr.-Ranedeer-AI-Tutor) | 29.6k | 可配置教学人格 + 课程状态机，纯 prompt 实现 |
| [HugeCatLab/ChatTutor](https://github.com/HugeCatLab/ChatTutor) | 1.3k | **把"高亮/教具操作"建模为 Agent 的 tool call 驱动 UI**（AGPL，只学思路不抄代码）；BYOK 多 provider 配置 |
| [plastic-labs/tutor-gpt](https://github.com/plastic-labs/tutor-gpt) | 931 | 学习者画像驱动个性化教学；Next.js + Supabase 全栈参考 |
| [Philip-Cao-9527/code-note-helper](https://github.com/Philip-Cao-9527/code-note-helper) | 275 | 结构化复盘笔记 + 艾宾浩斯复习队列 + BYOK 产品形态验证 |
| 商业产品：Khanmigo / ChatGPT Study Mode / NeetCode / AlgoMonster | — | 苏格拉底式提问、难度自适应、知识点依赖树路线图、"错误 vs 正确"代码对比、"特征→模式"识别卡片 |

## 三、可视化 / Playground 层

| 项目 | Star / License | 借鉴点 |
|---|---|---|
| [algorithm-visualizer](https://github.com/algorithm-visualizer/algorithm-visualizer) | 48.7k / **MIT** | 代码逐行执行 ↔ 动画同步的 tracer 架构；可放心参考 |
| [pgbovine/OnlinePythonTutor](https://github.com/pgbovine/OnlinePythonTutor) | 数千 | **执行 trace 回放模型**：每步 = 行号 + 变量快照，前端纯回放，任意前进/后退/跳转 |
| [datawhalechina/algo-vis](https://github.com/datawhalechina/algo-vis) | 新项目 / **无 License（只学思路）** | Hot 100 步骤帧协议（每帧全状态）、播放控制、七段式教学蓝图 |
| [VisuAlgo](https://visualgo.net) | 非开源 | e-Lecture 讲课模式：自动播放 + 讲解文案 + 高亮，证明预编排在教学场景更可控 |
| [microsoft/monaco-editor](https://github.com/microsoft/monaco-editor) | 43k | `deltaDecorations` 行级高亮/glyph，工业级"讲解指针"载体 |
| [judge0](https://github.com/judge0/judge0) | 4.4k | 多语言判题沙箱（本项目一期不用，走浏览器内执行保持纯本地） |

**关键机制结论**：教学场景选**预编排步骤帧**而非运行时插桩 —— 每步绑定讲解文案、代码行号、特效类型，叙事可控、无需执行用户代码。step→行号映射表是"高亮联动"的数据基础。

## 四、Agent / LLM 框架层

| 项目 | Star | 结论 |
|---|---|---|
| [vercel/ai](https://github.com/vercel/ai)（AI SDK） | 26.7k | **选定**：provider 字符串 + env Key 即满足 BYOK；流式 data parts 天然支持"边讲边高亮" |
| [CopilotKit/CopilotKit](https://github.com/CopilotKit/CopilotKit) | 37.4k | 生成式 UI / action 闭环的成熟参考；[OpenGenerativeUI](https://github.com/CopilotKit/OpenGenerativeUI) 示例与本场景几乎一致 |
| [ag-ui-protocol/ag-ui](https://github.com/ag-ui-protocol/ag-ui) | 15.9k | agent↔前端事件协议范本：custom event 携带 stepId + highlight 目标 |
| [assistant-ui/assistant-ui](https://github.com/assistant-ui/assistant-ui) | 12.1k | shadcn 模式 copy-in 聊天组件，改造自由度最高 |
| [pydantic/pydantic-ai](https://github.com/pydantic/pydantic-ai) | 19.9k | 强类型结构化输出的思路：讲解脚本 = 结构化 JSON 而非自由文本 |
| [langgenius/dify](https://github.com/langgenius/dify) | 155k | 只借鉴模型配置 UX（填 Key 即用），不作底座 |
| [pipecat-ai/pipecat](https://github.com/pipecat-ai/pipecat) | 15.5k | 二期语音讲解可选：同步控制帧做语音与高亮对齐 |

## 五、Spotlight 的能力组合（差异化公式）

```
algo-sensei 的 5 级渐进提示（教学法内核）
+ VisuAlgo/algo-vis 的预编排步骤帧（叙事载体）
+ Monaco decorations + Motion 特效（教鞭表现力，本项目原创重点）
+ AI SDK 的 BYOK 与流式 data parts（链路）
+ code-note-helper 的复盘笔记 + SM-2 复习（留存闭环）
= 会讲课、会指黑板、会安排复习的 AI 算法老师
```
