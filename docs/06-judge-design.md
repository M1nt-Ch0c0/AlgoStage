# 06 · 判题分层设计（JudgeBackend）

> playground 的判题能力设计。核心思想：**判题后端是可插拔接口，默认纯本地，重能力按需 opt-in**。
> 本设计是"教学 Agent"的前置拼图——Agent 的 `runCode` 工具直接消费 JudgeBackend。

## 0. 设计前提：威胁模型

本系统是**单用户本地应用**：用户在自己机器上运行自己（或 AI 为自己）写的代码。
因此**不需要** LeetCode 式的多租户安全沙箱（防陌生人恶意代码、资源计费、判题集群），
只需要：① 死循环/爆内存不卡死整机；② 判题结果正确可信；③ 编译错误/运行错误反馈清晰。

## 1. 分层总览

```
学习页 playground
   │  语言 tab（JS / Python / C++ / Java）
   ▼
JudgeRouter（按语言 + 用户设置路由）
   │
   ├── browser-sandbox   【默认·内置】JS + Python，零依赖，断网可用
   ├── native-local      【默认·内置】C++ + Java，用本机 g++/javac
   ├── judge0-docker     【opt-in 插件】全语言 + 强隔离，需 Docker
   └── leetcode-remote   【opt-in 插件】官方判题，需 LEETCODE_SESSION cookie（灰色，docs/05）
```

原则：**默认两个内置实现覆盖四语言，clone 即用**；后两者是设置页显式开启的插件。

## 2. JudgeBackend 接口契约（插件点⑥）

```ts
// lib/judge/types.ts
export type JudgeLanguage = "javascript" | "python" | "cpp" | "java";

export type Verdict = "AC" | "WA" | "TLE" | "RE" | "CE";

export interface JudgeCaseResult {
  caseId: number;
  verdict: Verdict;
  runtimeMs?: number;
  /** WA 时三栏展示：输入 / 期望 / 你的输出 */
  input?: string;
  expected?: string;
  actual?: string;
  stderr?: string;
}

export interface JudgeResult {
  verdict: Verdict;              // 汇总：全过 = AC，否则取第一个非 AC
  compileOutput?: string;        // CE 时的编译器输出
  cases: JudgeCaseResult[];
  backend: string;               // 实际执行的后端名（UI 角标展示）
}

export interface JudgeBackend {
  name: string;
  languages: JudgeLanguage[];
  /** 可用性探测：native-local 检测编译器、judge0 检测服务、leetcode 检测 cookie */
  available(): Promise<{ ok: boolean; reason?: string }>;
  judge(input: {
    slug: string;
    code: string;
    language: JudgeLanguage;
    problem: ProblemJudgingSpec;   // 见 §3
  }): Promise<JudgeResult>;
}
```

注册方式同其他插件点：`lib/judge/registry.ts` 维护 `Map<string, JudgeBackend>`，
`JudgeRouter` 按 `(language, 用户设置的 backend 偏好)` 选实现，不可用时降级并提示。

## 3. 判题规格（ProblemJudgingSpec）

升级现有 `TestCase`（docs/04），从"字符串对"升级为结构化判题规格：

```ts
export interface ProblemJudgingSpec {
  /** 入口函数/方法名（harness 调它） */
  entryPoint: string;                    // 'twoSum'
  /** 各语言的驱动代码模板（拼在用户代码后） */
  drivers: Partial<Record<JudgeLanguage, string>>;
  cases: JudgeCase[];
  timeLimitMs: number;                   // 默认 2000
}

export interface JudgeCase {
  args: unknown[];                       // 结构化参数，如 [[2,7,11,15], 9]
  expected: unknown;
  /** special judge：多个合法答案的题（如最小覆盖子串）逐题提供；缺省深比较 */
  validate?: "exact" | "sorted-array" | "any-valid-substring" | ...;
}
```

- 沿袭 LeetCode 的"harness 调函数"模式：用户只写函数，驱动代码读用例、调用、比对。
- 数组类答案默认 `sorted-array`（`[0,1]`/`[1,0]` 同对）；Hot 100 中需 special judge 的题 ≤10 道，种子数据逐题补齐。
- 现有 `lib/content/local-source.ts` 的 `testCases: {input, expected}` 迁移为本规格。

## 4. 各后端实现要点

### 4.1 browser-sandbox（默认，JS + Python）

- **隔离**：Web Worker 执行用户代码（死循环不卡页面；单判题 Worker 可 `terminate()`）。无恶意代码场景，不需要禁用 fetch 等能力。
- **JS 判题**：Worker 内 `new Function(userCode + driver)`，逐用例调用、深比较/validate；每条用例可独立计时。
- **超时**：主线程 `setTimeout(timeLimitMs)` 未收到结果即 `terminate()` → TLE。
- **Python**：Pyodide（WASM CPython，~10MB 首载，IndexedDB 缓存）；接口与 JS 版一致——Worker 内 `pyodide.runPython` 执行 userCode + driver，逐用例比对。首载体验：设置页预热 + 学习页懒加载进度条。
- **工作量估计**：JS 版判题器 ≈150 行；Pyodide 版另 ≈150 行 + 首载 UI。

### 4.2 native-local（默认，C++ / Java）

本地后端（Next.js route handler，`runtime = "nodejs"`）spawn 本机编译器：

1. **检测**：`available()` 执行 `g++ --version` / `javac -version`；缺失时该语言 tab 置灰并给安装提示（`apt install g++` 等）。
2. **编译**：临时目录写源文件 → `g++ -O2 -std=c++17 main.cpp` / `javac Main.java`，编译输出进 `compileOutput`（CE 回报）。
3. **运行**：`timeout` + `prlimit`（CPU 秒数 / 地址空间上限）；Linux 上探测到 `unshare` 则叠加 `unshare -rn`（免 root 断网 + 独立命名空间），没有则降级仅 rlimit。
4. **判题**：编译产物 + driver（C++ 的 main 读 JSON 用例调用用户函数；Java 同构），逐用例跑、比对、收集 stdout/stderr。
5. **清理**：判题结束删临时目录。

用例传入方式：驱动代码内嵌 JSON 用例（Hot 100 用例都很小），避免 stdin 协议复杂度。

### 4.3 judge0-docker（opt-in 插件）

- 设置页填 Judge0 地址（自托管 `localhost:2358` 或公共 CE 实例 + API Key）。
- 实现只是 HTTP 客户端：POST `/submissions?base64_encoded=true&wait=true`，语言 ID 映射。
- 价值：强隔离 + 60+ 语言（Go/Rust/C#…）；成本：要求 Docker，不做默认。

### 4.4 leetcode-remote（opt-in 插件）

- 设置页填 `LEETCODE_SESSION` cookie（沿用 docs/05 已规划的 leetcode-live 题面源的凭证）。
- Run 走 `POST /problems/<slug>/interpret_solution/`（对应网页"Run Code"）；Submit 走 `/submit/` + 轮询（可选开关，会计入用户真实提交记录，默认关）。
- 必须在设置页明示：**非官方端点、可能限流/失效/触发验证码，仅供个人低频使用**。

## 5. 与系统其余部分的衔接

- **教学 Agent**：`runCode` 工具 = 调 `JudgeRouter.judge()`，结果回灌对话（"你这段代码在第 3 个用例 WA 了，输入是…"）。Agent 改完代码（`editCode`）可直接复跑。
- **看板**：判题结果写 `Submission`（verdict/runtimeMs/backend），AC 触发 Confetti + SM-2 复习卡（现有 `/api/progress` 逻辑不变，只需把 mock 换成真判题）。
- **UI**：编辑器顶部语言 tab（4 语言 × 题解模板）；结果面板三栏展示（输入/期望/你的输出）+ CE 高亮编译输出；后端角标（`browser` / `native` / `judge0` / `leetcode`）。
- **设置页**：JudgeBackend 偏好（auto / browser / native / judge0 / leetcode）+ 各后端可用性指示灯。

## 6. 实施顺序

| 里程碑 | 内容 | 验收 |
|---|---|---|
| M1 | JudgeBackend 接口 + 注册表 + 用例规格迁移 + browser-sandbox(JS) | two-sum 真判题 AC/WA/TLE |
| M2 | native-local（C++/Java）+ 语言 tab + CE/RE 反馈 | 四语言跑通 Hot 100 任意 3 题 |
| M3 | Pyodide Python | Python 判题 + 首载体验 |
| M4 | judge0 / leetcode-remote 插件 | 设置页切换后端生效 |
| M5 | Agent `runCode` 工具接入 | 追问中 AI 自主跑代码并解读结果 |

M1-M3 是"默认体验"，M4-M5 按需推进，互不阻塞。
