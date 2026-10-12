/** 判题契约：浏览器执行用于即时反馈，只有服务端复判可以持久化 AC。 */
export type JudgeLanguage = "typescript" | "javascript" | "python";
export type Verdict = "AC" | "WA" | "RE" | "TLE";
export type Comparison = "exact" | "unordered" | "groups" | "two-sum" | "min-window";
export interface JudgeCase { args: unknown[]; expected: unknown }
export interface ProblemJudgingSpec {
  entryPoints: Record<JudgeLanguage, string[]>;
  parameters?: string[];
  cases: JudgeCase[];
  comparison: Comparison;
  mutatesArg?: number;
  timeLimitMs: number;
}
export interface JudgeCaseResult {
  caseId: number;
  verdict: Verdict;
  runtimeMs: number;
  input: string;
  expected: string;
  actual?: string;
  stderr?: string;
  stdout?: string;
}
export interface JudgeResult {
  verdict: Verdict;
  backend: "browser" | "node";
  cases: JudgeCaseResult[];
  runtimeMs: number;
  error?: "UNAVAILABLE" | "CANCELLED";
}
export interface JudgeInput { code: string; language: JudgeLanguage; problem: ProblemJudgingSpec }
export type WorkerReply =
  | { type: "ready" }
  | { type: "case-start"; caseId: number }
  | { type: "case-result"; result: JudgeCaseResult }
  | { type: "done"; reusable?: boolean }
  | { type: "output-limit" }
  | { type: "unavailable" };
export interface WorkerPort {
  onmessage: ((event: { data: WorkerReply }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessageerror: ((event: unknown) => void) | null;
  postMessage(data: unknown): void;
  terminate(): unknown;
}
