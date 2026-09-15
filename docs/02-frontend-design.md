# 02 · 前端设计文档（核心）

> 本文档是 AlgoStage 的最高优先级文档。项目的灵魂是"**像老师站在黑板前讲课**"——老师的手指到哪，学生的眼睛就跟到哪。前端的一切设计都服务于这个瞬间。

## 0. 设计哲学：讲台隐喻（The Podium Metaphor）

整个学习页就是一个讲台。每个 UI 元素都映射到真实课堂的物件：

| 课堂物件 | UI 映射 | 设计含义 |
|---|---|---|
| 黑板 | 代码编辑器（Monaco） | 深色、哑光、粉笔字质感，是视觉的绝对中心 |
| 教案 | 讲解脚本（TeachingScript） | AI 生成的有序步骤，决定"先讲什么后讲什么" |
| 教鞭/手指 | **聚光灯特效系统** | 当前讲解位置的视觉引导，必须华丽、无法忽视 |
| 粉笔 | 高亮笔迹（划线/圈选/下划线） | 在黑板和讲义上留下的标记，有手写质感 |
| 讲课声 | 字幕式讲解文案（打字机出现） | 底部字幕条，语音是二期可选 |
| 讲义 | 题面卡片 | 可被聚光灯照亮、被粉笔圈画 |
| 课堂练习 | 本地 Playground | 学生随时上台自己写 |
| 成绩单 | 个人看板 | 课后的沉淀与回顾 |

设计三原则：

1. **注意力即特效**：任何时候用户的视线都必须被引导到唯一焦点。AI 讲解时，非焦点区域压暗（Focus Dim），焦点区域发光（Spotlight）。
2. **动效有物理感**：所有运动遵守缓动物理（spring / ease-out-expo），拒绝线性匀速。光会呼吸，粉笔会抖动，涟漪会衰减。
3. **动效有叙事**：动效不是装饰，是讲解的一部分。每种特效对应一种教学意图（"看这里"、"记住这个"、"对比一下"、"你做对了"）。

## 1. 技术选型（前端）

| 层 | 选型 | 理由 |
|---|---|---|
| 框架 | Next.js App Router + React 19 + TS | 全栈一体、本地单进程、生态最大 |
| 样式 | Tailwind CSS v4（CSS-first 配置） | token 即 CSS 变量，主题切换零成本 |
| 组件基座 | shadcn/ui 风格 copy-in 组件 | 源码进仓库，改特效自由度最高（assistant-ui 同款模式） |
| 动效 | Motion（framer-motion 后继） | spring 物理、layout 动画、SVG path 动画（粉笔字迹全靠它） |
| 编辑器 | Monaco Editor | deltaDecorations 是"教鞭"的工业级载体 |
| 代码运行 | 浏览器沙箱 iframe（JS）+ Pyodide（Python，二期） | 纯本地，无服务器 |
| 状态 | Zustand（播放器/设置）+ React Query（数据） | 播放器是高频状态机，必须脱离 React 渲染热路径 |
| 可视化 | 自研 Visualizer 组件（SVG + Motion） | 数组/链表/树/图，每题一个可视化器插件 |

## 2. 视觉语言

### 2.1 主题：Chalkboard Dark（默认）/ Paper Light

暗色主题是主战场——聚光灯在黑暗中才最亮。

**Chalkboard Dark 设计 token（CSS 变量，Tailwind v4 `@theme` 内定义）：**

```css
@theme {
  /* 黑板底色：不是纯黑，是带绿意的深灰，像真正的黑板 */
  --color-board-950: #0b0f0e;
  --color-board-900: #111716;
  --color-board-800: #1a2220;
  --color-board-700: #263231;

  /* 粉笔色阶 */
  --color-chalk-100: #f4f1e8;   /* 主文字：暖白粉笔 */
  --color-chalk-300: #cfc9b8;
  --color-chalk-500: #8f887a;

  /* 聚光灯光谱（特效专用，高饱和荧光系） */
  --color-beam-gold: #ffd166;    /* 教鞭主光：暖金 */
  --color-beam-cyan: #4cc9f0;    /* 变量/数据高亮 */
  --color-beam-violet: #b388ff;  /* 重点强调 */
  --color-beam-rose: #ff5d8f;    /* 警告/常见错误 */
  --color-beam-mint: #52e0a4;    /* 正确/通过 */

  /* 功能色 */
  --color-accent: #ffd166;
  --color-success: #52e0a4;
  --color-danger: #ff5d8f;
}
```

**Paper Light**：米纸底 `#faf7f0`，墨色文字 `#1c2321`，光束色不变（投影在白墙上依然清晰）。

### 2.2 质感三件套

1. **噪点颗粒**：全局叠一层 `opacity: 0.03` 的 SVG 噪点，消除纯色的塑料感，像粉笔灰落在黑板上。
2. **粉笔字效**：讲解标题用手写风格字体（如 `Caveat` / 中文 `Zhi Mang Xing` 或 `Long Cang`），关键板书文字带 `text-shadow` 微光晕。
3. **玻璃拟态**：浮层（AI 面板、字幕条、设置抽屉）用 `backdrop-blur` + 半透明板色，浮在黑板之上。

### 2.3 字体

| 用途 | 字体栈 |
|---|---|
| UI 正文 | Inter / `PingFang SC` / `Noto Sans SC` |
| 代码 | `JetBrains Mono` / `Maple Mono NF` |
| 板书标题（手写感） | Caveat + `Zhi Mang Xing` |

### 2.4 栅格与圆角

- 8px 基准栅格；卡片圆角 `12px`，浮层 `16px`，标签 `999px`。
- 页面最大宽度 `1600px`，学习页三栏比例 `讲义 3 : 黑板 5 : AI 导师 4`（可拖拽调整）。

## 3. 动效系统总览

### 3.1 架构：特效注册表（EffectRegistry）

所有"教鞭特效"是可插拔插件，通过统一 contract 注册。**这是长期主义的关键：加一种新特效 = 写一个组件 + 注册一行，不碰播放器主逻辑。**

```ts
// lib/effects/types.ts
interface EffectProps {
  target: EffectTarget;      // 指向哪里（代码行区间 / DOM 锚点 / 可视化节点）
  color?: BeamColor;         // 光谱中的哪一种光
  intensity?: 'whisper' | 'normal' | 'shout'; // 教学语气强度
  onDone?: () => void;       // 特效播完回调（播放器用它推进节奏）
}

interface EffectPlugin {
  name: string;              // 'spotlight-beam' | 'chalk-underline' | ...
  component: React.FC<EffectProps>;
  defaultDuration: number;   // ms
}

// lib/effects/registry.ts
export const effectRegistry = new Map<string, EffectPlugin>();
export function registerEffect(plugin: EffectPlugin) { ... }
```

### 3.2 特效统一挂载层：`<EffectStage>`

一个覆盖在学习页最上层的透明舞台（`pointer-events: none`），所有特效在这里渲染。它订阅播放器的 `currentStep`，读取该步声明的 `effects[]`，从注册表取出组件逐个挂载。

```
学习页
├── 讲义区（题面）          ← 可被照亮/圈画
├── 黑板上（Monaco）        ← 可被照亮/划线/glyph 指针
├── 可视化区                ← 节点可被照亮/连线动画
├── AI 导师面板（字幕+对话）
└── <EffectStage />         ← 透明特效层（光束/涟漪/礼花）
```

### 3.3 动效性能纪律

- 只动 `transform` / `opacity`；发光用 `filter: drop-shadow` 或预渲染的 radial-gradient，**不用会触发重绘的 box-shadow 动画**。
- Monaco 行高亮走 `deltaDecorations`（编辑器内渲染，零 React 开销）；DOM 侧特效走 Motion 的 `useAnimate`。
- 同一时刻场上活跃特效 ≤ 3 个，旧的自动退场（exit 动画 200ms）。
- `prefers-reduced-motion: reduce` 时全局降级为"静态高亮 + 淡入"，见 §7。

## 4. 核心特效清单（本项目的灵魂）

> 每种特效 = 一种教学手势。命名、视觉、实现要点如下。特效的视觉打磨优先级高于一切功能。

### 4.1 Spotlight Beam · 聚光灯光束 ⭐（招牌特效）

- **教学意图**："现在看这里。" —— 老师的手指按在黑板某一行。
- **视觉**：目标代码行背后浮起一层暖金色辉光，光从行的中心向两侧羽化衰减（radial-gradient 拉宽成椭圆）；光的亮度以 2.4s 周期缓慢"呼吸"（opacity 0.55↔0.8）；行左缘有一条 2px 的实色光柱，像光束的边缘。
- **Monaco 实现**：`deltaDecorations` 注入 `className: 'beam-line'` + `isWholeLine: true`；呼吸用 CSS `@keyframes` 动画 background 的 opacity，不触发编辑器重排。
- **增强**：首次落光时有 150ms 的"开灯"入场（光从 0 扩散到全宽，带轻微 overshoot spring），讲解推进时光束**滑动迁移**到下一行（`transition: top .35s cubic-bezier(.22,1,.36,1)`），绝不瞬移。

### 4.2 Laser Pointer · 激光教鞭

- **教学意图**：引导视线长距离移动 —— "刚才在讲哈希表，现在看循环这里"。
- **视觉**：一个发光的虚拟教鞭点（金色光点 + 拖尾彗尾）沿**贝塞尔曲线**从上一焦点飞到新焦点，飞行 450ms，落点处炸开一圈小涟漪。飞行路径避开直线，带 15% 弧度的"手腕感"。
- **实现**：`<EffectStage>` 内的 Motion 组件，起止坐标由 `EffectTarget` 锚点解析（代码行 → Monaco `getScrolledVisiblePosition`；DOM 元素 → `getBoundingClientRect`）。彗尾用一串延迟跟帧的光点（6 个，各延迟 30ms，scale 递减）。

### 4.3 Chalk Underline / Circle · 粉笔划线与圈选 ⭐

- **教学意图**："这个词很关键"（划线）/"这个条件看仔细"（圈选）。
- **视觉**：一条暖白色粉笔迹沿目标文本/代码 token 下方**手绘画出**——不是直线，是带 ±1.5px 随机抖动的微波浪，端点有粉笔起笔/收笔的粗细变化；画完极轻微地闪烁一次，像粉笔灰落定。圈选则是绕目标画一个不完美闭合的椭圆（起点终点差 8% 不闭合，更真实）。
- **实现**：预生成目标包围盒的 SVG path，Motion 的 `pathLength` 从 0→1 动画；抖动在 path 生成时烘焙进去（`rough.js` 风格的扰动算法，自绘 200 行内可搞定，不引依赖）。颜色默认可用 `--color-beam-violet` 以区别于金色光束。

### 4.4 Focus Dim · 舞台压暗

- **教学意图**："别的都别看，只看这里。"
- **视觉**：除焦点区域外，整个学习页蒙上一层 `rgba(6,10,9,0.55)` 的暗纱，焦点区域通过 `clip-path` 开孔保持明亮；暗纱 300ms 淡入，开孔位置随讲解步骤平滑迁移（开孔是圆角矩形，迁移时形状也在插值变化）。
- **实现**：`<EffectStage>` 内全屏 div + `clip-path: path(...)` 或四个遮罩块拼出开孔；开孔坐标与 Spotlight Beam 共用同一锚点解析器。
- **使用节制**：仅在"细讲一段代码"的步骤使用，讲解段落切换时解除，避免用户长期处在压抑的暗场里。

### 4.5 Attention Ripple · 注意力涟漪

- **教学意图**：轻提醒 —— "顺便注意下这个"，比光束弱一档。
- **视觉**：目标元素四周荡开 2~3 圈与光谱同色的圆角矩形波纹（从元素轮廓向外 scale 1.0→1.15、opacity 0.6→0，每圈间隔 200ms）。
- **实现**：绝对定位的 3 个描边 div，`@keyframes ripple`；DOM 锚点通用，代码行/题面段落/可视化节点通吃。

### 4.6 Typewriter Narration · 板书打字机

- **教学意图**：讲解文案本身是"说出来的话"，要有声音感（无语音版）。
- **视觉**：底部字幕条内文案逐字出现（15~30 字/秒，随语速设置），光标是一个发光的粉笔小竖线；讲到代码标识符时，该词以 `JetBrains Mono` + 金色高亮内联渲染；句子结束时光标轻跳一下。
- **实现**：字幕组件按 token 切分讲解文本（markdown 内联 code 已解析），用 `useAnimationFrame` 推进；与播放器步骤同步——字幕打完才允许自动播放下一步（除非用户跳过）。

### 4.7 Comparison Split · 正误对比分屏

- **教学意图**："看看错误写法错在哪"（NeetCode 式对比）。
- **视觉**：黑板裂成左右两半（layout 动画，spring），左红右绿两块微光底，错误写法那侧有粉笔画的"×"，正确那侧画"✓"（都是 pathLength 手绘动画）；中间一道粉笔竖线分隔。
- **实现**：Monaco 的 diff editor 太重，直接两个只读 code block + Motion layout。

### 4.8 Confetti AC · 通关礼花

- **教学意图**："你做对了！" ——  playground 全部测试通过时。
- **视觉**：从运行按钮位置喷出粉笔色纸屑（不是俗气的彩虹，是板色系 + 金色），重力下坠 + 旋转 + 风摆，1.8s 后自然消散；同时看板热力图上对应格子"点亮"开花（见 §6 看板）。
- **实现**：轻量自研 canvas 粒子（<150 行），不引 canvas-confetti 依赖，保证纸屑配色与质感统一。

### 4.9 Progress Bloom · 进度生长

- **教学意图**：看板上的正反馈。
- **视觉**：掌握度雷达图从中心"生长"展开（各轴 scale 0→1，stagger 80ms）；热力图格子按时间顺序逐个绽放（scale 0→1 + 光晕衰减）； streak 数字翻滚计数（odometer 效果）。
- **实现**：SVG + Motion stagger；数字翻滚用 Motion 的 `animate` 插值。

### 4.10 Viz Step · 可视化联动

- **教学意图**：数据结构动画与讲解同步 —— 讲到"指针右移"，数组上的指针箭头就滑过去。
- **视觉**：每个 Visualizer（数组/链表/树/图/栈队列）接收当前 step 的状态快照，节点位置/颜色变化全部走 spring；被讲解点名的节点叠加 Spotlight Beam 同款辉光；指针元素（`i`、`j`、`slow/fast`）是悬浮的小旗标，移动时带惯性摆动。
- **实现**：步骤帧协议（见 03 文档）每帧携带完整 viz 状态，Visualizer 是纯函数组件 `state → SVG`，动画交给 Motion layout。

## 5. 页面设计

### 5.1 路由与信息架构

```
/                    Landing（品牌 + 一句话演示：自动播放一段 10 秒讲解特效秀）
/roadmap             刷题路线图（知识点依赖树，Hot 100 挂载其上）
/problem/[slug]      学习页（核心战场）
/dashboard           个人看板
/review              复习队列（SM-2）
/settings            设置（BYOK、外观、特效强度）
```

### 5.2 Landing：10 秒特效秀

首屏不是功能罗列，而是一段**自动播放的迷你讲解**：微缩版学习页在中央，聚光灯亮起、粉笔划线、字幕打字机念出"两数之和，我们从哈希表讲起……"，10 秒循环。访客第一眼就明白这个产品是干什么的。下方才是特性卡片（每张卡片 hover 时有对应的迷你特效演示）。

### 5.3 Roadmap 路线图

- 知识点依赖树横向展开（数组/哈希 → 双指针 → 滑动窗口 → … → DP），节点是六边形徽章，已完成的发金光、进行中的呼吸、未解锁的 40% 透明。
- 树连线用 SVG 贝塞尔，初次进入时线条有"粉笔画出"的入场动画（stagger）。
- 每个节点 hover 弹出迷你卡片：题目数、掌握度、最近一次学习，点击入题。

### 5.4 学习页 `/problem/[slug]`（核心）

```
┌──────────────────────────────────────────────────────────┐
│ 顶栏：题目标题 · 难度徽章 · 模式标签 · [开始讲课] [提示] [运行] │
├──────────┬───────────────────────────┬───────────────────┤
│ 讲义      │ 黑板（Monaco）             │ AI 导师面板        │
│ 题面卡片   │ ┌─────────────────────┐ │ · 字幕条（打字机）   │
│ 可被圈画   │ │ 代码 + 光束/划线/glyph│ │ · 对话历史         │
│           │ └─────────────────────┘ │ · [提示阶梯 Lv1-5]  │
│ 可视化区   │ playground 控制台        │ · 输入框           │
│ (数组动画)  │ 输入/输出/测试结果        │                   │
├──────────┴───────────────────────────┴───────────────────┤
│ 讲解播放器控制条：◀ ▶ ⏸ · 步骤 3/12 · 时间线 · 速度 · 特效开关 │
└──────────────────────────────────────────────────────────┘
```

- **讲课模式**：AI 面板输出讲解脚本（03 文档协议），播放器逐步推进，EffectStage 执行特效，字幕打字机同步念白。用户可随时暂停、回退、追问（追问时播放器挂起，进入对话，完事后"继续上课"）。
- **练习模式**：用户在 Monaco 里自己写，本地沙箱跑测试；AC 触发 Confetti AC；卡住时点提示阶梯（5 级渐进提示，每级消耗记录在案）。
- **评审模式**：提交后 AI 逐行 review 用户代码，review 意见也走特效系统（指到哪行说到哪行）。

### 5.5 Dashboard 看板

四个区块，全部 Progress Bloom 入场：

1. **热力图**（GitHub 风格，365 天，粉笔色阶）；
2. **知识点掌握度雷达图**（按模式分类：双指针/滑窗/DP…，掌握度 = f(AC 数, 提示消耗, 复习正确率)）；
3. **学习统计卡片**：streak、总 AC、提示消耗比（"独立性"指标）、平均卡点时长；
4. **复习队列摘要**：今日待复习 n 张卡片，点击进入 `/review`。

### 5.6 Settings 设置

- **BYOK 卡片**：Provider 下拉（OpenAI 兼容/DeepSeek/Anthropic/Gemini/自定义 baseURL）+ API Key 输入（密码框，仅存本地）+ Model Name + "测一下"按钮（调一次最小请求，打勾动效反馈）。
- **外观**：主题、光束颜色自定义（拾色器直接改 `--color-beam-*`）、字幕语速。
- **特效强度**：三档 `华丽 / 克制 / 极简`——映射到 EffectStage 的全局 filter（华丽=全特效，克制=关 Focus Dim 和 Laser Pointer，极简=只剩静态高亮）。**这个开关本身就是对"动效要有节制"的产品化表达。**

## 6. 组件清单与目录

```
components/
├── ui/                  # shadcn 风格 copy-in 基础件（button/card/dialog/...）
├── effects/             # ⭐ 特效系统（每个特效一个文件）
│   ├── effect-stage.tsx
│   ├── spotlight-beam.tsx
│   ├── laser-pointer.tsx
│   ├── chalk-underline.tsx      # 划线与圈选共用 path 扰动器
│   ├── focus-dim.tsx
│   ├── attention-ripple.tsx
│   ├── confetti-ac.tsx
│   └── progress-bloom.tsx
├── board/               # 黑板区
│   ├── code-editor.tsx          # Monaco 封装：decorations/glyph/滚动跟随
│   ├── narration-bar.tsx        # 字幕打字机
│   └── player-controls.tsx      # 播放器控制条
├── viz/                 # 可视化器插件（array/linked-list/tree/graph/...）
├── tutor/               # AI 导师面板（对话、提示阶梯、评审）
├── dashboard/           # 热力图/雷达图/统计卡
└── landing/             # 首屏特效秀
lib/
├── effects/registry.ts  # 特效注册表
├── player/              # 播放器状态机（Zustand）：step 推进/暂停/回退/追问挂起
└── anchors.ts           # EffectTarget → 屏幕坐标 解析器
```

## 7. 可访问性与降级

- `prefers-reduced-motion: reduce`：全部特效降级为静态高亮 + 150ms 淡入；礼花/涟漪/打字机替换为即时呈现。
- 特效强度设置与系统偏好取更保守者。
- 所有颜色对比度 ≥ WCAG AA（板底 vs 粉笔字 12.6:1）；特效不承载唯一信息——高亮行同时有 glyph margin 图标，色盲用户可辨。
- 键盘可达：播放器全键盘操作（`←/→` 步进、`Space` 暂停、`1-5` 提示阶梯）。

## 8. 动效验收标准（Definition of Done）

一个新特效合入前必须满足：

1. 只动 transform/opacity，Chrome DevTools Performance 录制期间无长任务（>50ms）；
2. 在 2019 年中端机型（或 4x CPU 降速模拟）下稳定 60fps；
3. 有 exit 动画，且不与其他活跃特效视觉打架（同屏 ≤3 个）；
4. `克制`/`极简`档位下有正确的降级表现；
5. 提供 Storybook（或 `/playground/effects` 调试页）独立演示入口。
