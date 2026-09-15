# 03 · 讲解脚本协议（TeachingScript）

> 本协议是"AI 讲到哪、光打到哪"的数据基础：AI 不输出自由文本，而输出**结构化的教案**——有序步骤数组，每步声明"讲什么（文案）、指哪里（高亮目标）、放什么特效"。前端播放器照本宣科地演。

## 1. 顶层结构

```ts
interface TeachingScript {
  problemSlug: string;            // 'two-sum'
  mode: 'lecture' | 'review';     // 讲课 / 评审（hint/interview 走轻量协议，见 §5）
  language: 'zh' | 'en';
  solutionLanguage: 'typescript' | 'python';
  steps: TeachingStep[];          // 有序，播放器按下标推进
}

interface TeachingStep {
  id: string;                     // 's1'
  narration: string;              // 讲解文案（markdown 子集：内联 code、加粗）
  targets: EffectTarget[];        // 本步指向哪里（可多个，主焦点在第一个）
  effects: EffectCall[];          // 本步放什么特效
  viz?: VizFrame;                 // 本步的可视化状态快照（可选）
  awaitNarration?: boolean;       // 默认 true：字幕打完才自动进下一步
  dwellMs?: number;               // 字幕后额外停留（默认 800ms）
}
```

## 2. EffectTarget · 指向哪里

```ts
type EffectTarget =
  | { kind: 'code-line'; start: number; end?: number }        // 黑板代码行区间
  | { kind: 'code-token'; line: number; match: string }       // 行内某标识符（粉笔圈选用）
  | { kind: 'statement'; blockId: string }                    // 讲义题面段落锚点
  | { kind: 'viz-node'; nodeId: string }                      // 可视化节点
  | { kind: 'dom'; selector: string };                        // 逃生舱：任意 DOM
```

统一由 `lib/anchors.ts` 解析为屏幕坐标/Monaco 区间，特效组件不关心来源。

## 3. EffectCall · 放什么特效

```ts
interface EffectCall {
  effect: string;                 // EffectRegistry 里的注册名
  targetIndex?: number;           // 作用于 targets 的第几个（默认 0）
  color?: 'gold' | 'cyan' | 'violet' | 'rose' | 'mint';
  intensity?: 'whisper' | 'normal' | 'shout';
  params?: Record<string, unknown>; // 特效自定义参数（如粉笔的 shape: 'circle'）
}
```

**AI 可用的特效白名单**（写进系统 prompt，对应 02 文档 §4）：

| 特效名 | 教学手势 | 典型参数 |
|---|---|---|
| `spotlight-beam` | 看这里（持续高亮本步焦点） | color |
| `laser-pointer` | 视线从这里移到那里 | — |
| `chalk-underline` | 这个词关键 | shape: 'line' \| 'circle' |
| `focus-dim` | 只看这段 | — |
| `attention-ripple` | 顺便注意 | — |
| `comparison-split` | 正误对比 | params: { wrongCode, rightCode } |

未在白名单内的特效名，播放器直接忽略（容错）。

## 4. VizFrame · 可视化快照

```ts
interface VizFrame {
  type: string;                   // 'array' | 'linked-list' | 'tree' | 'graph' | ...
  state: unknown;                 // 由对应 Visualizer 的 schema 决定（每帧全量，任意跳转）
  captions?: { nodeId: string; text: string }[]; // 节点旁的小旗标（i / j / slow）
}
```

每帧携带完整状态（不依赖上一帧），因此播放器可任意前进/后退/跳转——回放模型借鉴 Python Tutor 与 algo-vis。

## 5. 生成与流式传输

### 生成（Server 侧）

- 输入：题目元数据 + 自产参考题解 + 教学模式 prompt（`lib/agent/modes/lecture.ts`）。
- 要求模型**只输出 TeachingScript JSON**（AI SDK `streamObject` + zod schema 强约束，借鉴 Pydantic AI 的结构化输出思路）。
- 校验失败自动重试一次；二次失败降级为"静态讲解"（无特效的纯字幕步骤）。

### 流式（Server → 浏览器）

- AI SDK data parts：每完成一个 `step` 推一个 `data-step` 事件，播放器**边收边播**（第一步到达即可开讲，不用等整份教案）。
- 脚本整体完成后落库缓存（`LectureScriptCache`，键 = slug + model + solutionLanguage + mode）。

### 系统 prompt 要点（lecture 模式）

1. 角色：循循善诱的算法老师，讲 intuition 先于讲代码；七段式蓝图（直觉→符号→公式→流程→误区→调试→总结，借鉴 algo-vis）只做参考不强制。
2. 每步 narration ≤ 60 字（字幕条容量），一步只讲一个意思。
3. 每步必须给 targets；特效从白名单选，`spotlight-beam` 是默认手势，其余按教学意图点缀（一场课 focus-dim ≤ 2 次，避免压抑）。
4. 行号必须基于给定的参考题解原文，不得编造。
5. 绝不在 lecture 模式直接否定学生；review 模式才允许指出错误。

## 6. 轻量协议：提示阶梯（hint 模式）

5 级渐进提示（借鉴 algo-sensei），不生成完整脚本，每次请求只升一级：

```
L1 观察：引导重读题目关键条件      L2 模式：点出所属算法模式
L3 方向：给出数据结构/思路选择      L4 技巧：关键实现技巧
L5 骨架：伪代码框架（仍不给完整答案）
```

每级消耗写入 `HintUsage` 表，是看板"独立性"指标的数据源。提示也可以携带 `targets` 做高亮，但特效只用 `attention-ripple`（弱引导）。

## 7. 示例（两数之和 · 节选）

```json
{
  "problemSlug": "two-sum",
  "mode": "lecture",
  "language": "zh",
  "solutionLanguage": "typescript",
  "steps": [
    {
      "id": "s1",
      "narration": "暴力解是两层循环 O(n²)。关键洞察：对每个数，我们只想知道**它的另一半在哪**——这是查找问题，查找就该想到哈希表。",
      "targets": [{ "kind": "statement", "blockId": "constraint-1" }],
      "effects": [{ "effect": "chalk-underline", "params": { "shape": "circle" } }]
    },
    {
      "id": "s2",
      "narration": "所以我们一边遍历，一边把见过的数存进 `map`：键是数值，值是下标。",
      "targets": [{ "kind": "code-line", "start": 3, "end": 4 }],
      "effects": [{ "effect": "spotlight-beam" }, { "effect": "laser-pointer" }],
      "viz": { "type": "array", "state": { "values": [2,7,11,15], "map": {"2":0}, "scan": 1 }, "captions": [{ "nodeId": "a1", "text": "i" }] }
    }
  ]
}
```
