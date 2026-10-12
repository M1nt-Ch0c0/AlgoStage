/** 浏览器判题契约：每次提交独立 Worker，错误后不复用。 */
export type JudgeLanguage = "typescript" | "javascript" | "python";
export type Verdict = "AC" | "WA" | "RE" | "TLE";
export type Comparison = "exact" | "unordered" | "groups" | "two-sum" | "min-window";
export interface JudgeCase { args: unknown[]; expected: unknown }
export interface ProblemJudgingSpec {
  entryPoints: Record<JudgeLanguage, string[]>;
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
  backend: "browser";
  cases: JudgeCaseResult[];
  runtimeMs: number;
  error?: "UNAVAILABLE" | "CANCELLED";
}
export interface JudgeInput { code: string; language: JudgeLanguage; problem: ProblemJudgingSpec }
export type WorkerReply =
  | { type: "ready" }
  | { type: "case-start"; caseId: number }
  | { type: "case-result"; result: JudgeCaseResult }
  | { type: "done" }
  | { type: "output-limit" }
  | { type: "unavailable" };
