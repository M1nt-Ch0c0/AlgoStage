import { spawn } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { compareAnswer } from "./compare";
import { NODE_RUNNER } from "./node-runner";
import type { JudgeCase, JudgeCaseResult, JudgeInput, JudgeResult } from "./types";

const OUTPUT_LIMIT = 32768;
const DEFAULT_MAX_CONCURRENCY = 4;
const unavailable = (): JudgeResult => ({ verdict: "RE", backend: "node", cases: [], runtimeMs: 0, error: "UNAVAILABLE" });

let activeJudges = 0;

export function maxJudgeConcurrency(raw = process.env.JUDGE_MAX_CONCURRENCY): number {
  if (typeof raw !== "string") return DEFAULT_MAX_CONCURRENCY;
  const trimmed = raw.trim();
  if (!/^[1-9]\d*$/.test(trimmed)) return DEFAULT_MAX_CONCURRENCY;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_CONCURRENCY;
}

export function tryAcquire(): boolean {
  if (activeJudges >= maxJudgeConcurrency()) return false;
  activeJudges += 1;
  return true;
}

export function release(): void {
  activeJudges = Math.max(0, activeJudges - 1);
}

type Execution = {
  runtimeMs: number;
  actual?: unknown;
  stdout?: string;
  stderr?: string;
  failure?: "RE" | "TLE";
  unavailable?: boolean;
};

async function runCase(input: JudgeInput, item: JudgeCase): Promise<Execution> {
  // 文件描述符传输在禁止本地 socket 的环境中也可用，不授予子进程任何路径权限。
  const directory = mkdtempSync(join(tmpdir(), "algostage-judge-"));
  const descriptors: number[] = [];
  try {
    const source = join(directory, "input.json"), destination = join(directory, "output.json");
    writeFileSync(source, JSON.stringify({
      code: input.code, args: item.args, entryPoints: input.problem.entryPoints[input.language],
      mutatesArg: input.problem.mutatesArg, timeLimitMs: input.problem.timeLimitMs,
    }), { mode: 0o600 });
    descriptors.push(openSync(source, "r"));
    descriptors.push(openSync(destination, "w", 0o600));
    return await new Promise(resolve => {
      const started = Date.now();
      const child = spawn(process.execPath, [
        "--permission", "--disable-proto=throw", "--max-old-space-size=64",
        "--input-type=commonjs", "--eval", NODE_RUNNER,
      ], { env: { NODE_ENV: "production" }, cwd: "/", stdio: [descriptors[0], descriptors[1], "ignore"] });
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, input.problem.timeLimitMs);
      child.on("error", () => {
        clearTimeout(timer);
        resolve({ runtimeMs: 0, unavailable: true });
      });
      child.on("close", code => {
        clearTimeout(timer);
        const runtimeMs = Math.max(0, Date.now() - started);
        if (timedOut || runtimeMs > input.problem.timeLimitMs) {
          resolve({ runtimeMs, failure: "TLE", stderr: "超过时间限制，执行已停止。" });
          return;
        }
        try {
          const output = readFileSync(destination, "utf8");
          if (!output.startsWith("ready\n")) { resolve({ runtimeMs, unavailable: true }); return; }
          if (code !== 0 || Buffer.byteLength(output) > OUTPUT_LIMIT * 16) throw new Error("执行结果无效。");
          const reply = JSON.parse(output.slice(6));
          if (typeof reply.error === "string") {
            resolve({ runtimeMs, failure: reply.timeout ? "TLE" : "RE", stderr: reply.error });
            return;
          }
          const value = JSON.parse(reply.value);
          if (typeof value.stdout !== "string" || Buffer.byteLength(value.stdout) > OUTPUT_LIMIT ||
              (value.actual !== undefined && (typeof value.actual !== "string" || Buffer.byteLength(value.actual) > OUTPUT_LIMIT))) {
            throw new Error("输出或返回值超过 32 KiB。");
          }
          resolve({ runtimeMs, actual: value.actual === undefined ? undefined : JSON.parse(value.actual), stdout: value.stdout });
        } catch {
          resolve({ runtimeMs, failure: "RE", stderr: "执行结果无效，或输出超过 32 KiB。" });
        }
      });
    });
  } finally {
    for (const descriptor of descriptors) closeSync(descriptor);
    rmSync(directory, { recursive: true, force: true });
  }
}

/** 仅接受服务端选取的 specs；API 不接受客户端的用例、入口、时间限制或判定。 */
export async function judgeOnServer(input: JudgeInput): Promise<JudgeResult> {
  if (input.language === "python" || !input.problem.cases.length) return unavailable();
  let code = input.code, compilationError = "";
  if (input.language === "typescript") {
    const compiled = ts.transpileModule(code, {
      reportDiagnostics: true,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
    });
    code = compiled.outputText;
    compilationError = (compiled.diagnostics ?? [])
      .filter(d => d.category === ts.DiagnosticCategory.Error)
      .map(d => ts.flattenDiagnosticMessageText(d.messageText, "\n")).join("\n").slice(0, 2000);
  }
  const cases: JudgeCaseResult[] = [];
  for (const [caseId, item] of input.problem.cases.entries()) {
    let execution: Execution;
    try {
      execution = compilationError
        ? { runtimeMs: 0, failure: "RE", stderr: compilationError }
        : await runCase({ ...input, code }, item);
    } catch { return unavailable(); }
    if (execution.unavailable) return unavailable();
    let verdict: JudgeCaseResult["verdict"] = execution.failure ?? "WA";
    if (!execution.failure) {
      try { verdict = compareAnswer(execution.actual, item, input.problem.comparison) ? "AC" : "WA"; }
      catch { verdict = "RE"; execution.stderr = "返回值无法比较。"; }
    }
    cases.push({
      caseId, verdict, runtimeMs: execution.runtimeMs,
      input: JSON.stringify(item.args), expected: JSON.stringify(item.expected),
      actual: JSON.stringify(execution.actual), stdout: execution.stdout, stderr: execution.stderr,
    });
    if (verdict !== "AC") break;
  }
  return { backend: "node", verdict: cases.at(-1)!.verdict, cases, runtimeMs: cases.reduce((sum, item) => sum + item.runtimeMs, 0) };
}
