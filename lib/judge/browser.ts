import { apiPath } from "@/lib/runtime";
import type { JudgeCaseResult, JudgeInput, JudgeResult, WorkerReply } from "./types";
export interface WorkerPort {
  onmessage: ((event: { data: WorkerReply }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessageerror: ((event: unknown) => void) | null;
  postMessage(data: unknown): void;
  terminate(): unknown;
}
export interface JudgeOptions {
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
  createWorker?: (python: boolean) => WorkerPort;
  indexURL?: string;
  initializationTimeoutMs?: number;
}
export function judgeInBrowser(input: JudgeInput, options: JudgeOptions = {}): Promise<JudgeResult> {
  return new Promise(resolve => {
    const python = input.language === "python";
    const results: JudgeCaseResult[] = [];
    let worker: WorkerPort | undefined, timer: ReturnType<typeof setTimeout>, finished = false, active = 0, caseStarted = 0;
    const finish = (error?: JudgeResult["error"]) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort",cancel);
      worker?.terminate();
      resolve({ verdict: error ? "RE" : results.find(c => c.verdict !== "AC")?.verdict ?? (results.length === input.problem.cases.length ? "AC" : "RE"), backend: "browser", cases: results, runtimeMs: results.reduce((sum,c) => sum+c.runtimeMs,0), ...(error ? { error } : {}) });
    };
    const fail = (verdict: "TLE" | "RE", message: string) => {
      if (finished) return;
      const item = input.problem.cases[active];
      results.push({ caseId: active, verdict, runtimeMs: caseStarted ? Date.now()-caseStarted : 0, input: JSON.stringify(item?.args), expected: JSON.stringify(item?.expected), stderr: message });
      finish();
    };
    const cancel = () => finish("CANCELLED");
    if (options.signal?.aborted) { cancel(); return; }
    options.signal?.addEventListener("abort",cancel,{ once: true });
    options.onProgress?.(python ? "正在加载本机 Python 运行环境…" : "正在准备判题…");
    timer = setTimeout(() => finish("UNAVAILABLE"),options.initializationTimeoutMs ?? (python ? 60000 : 15000));
    try {
      worker = options.createWorker?.(python) ?? new Worker(apiPath(`/judge/${python ? "python" : "javascript"}-worker.mjs`), { type: "module" }) as unknown as WorkerPort;
      worker.onmessage = ({ data }) => {
        if (finished) return;
        if (data.type === "ready") {
          // 转译阶段沿用初始化超时；首次 case-start 后才按用例执行时间计时。
          worker!.postMessage(input);
        } else if (data.type === "case-start") {
          active = data.caseId; caseStarted = Date.now(); clearTimeout(timer);
          options.onProgress?.(`正在运行 ${active+1}/${input.problem.cases.length} 个用例…`);
          timer = setTimeout(() => fail("TLE","超过时间限制，执行已停止。"),input.problem.timeLimitMs);
        } else if (data.type === "case-result") {
          if (Date.now()-caseStarted > input.problem.timeLimitMs || data.result.runtimeMs > input.problem.timeLimitMs) { fail("TLE","超过时间限制，执行已停止。"); return; }
          results.push(data.result);
        } else if (data.type === "output-limit") fail("RE","输出超过 32 KiB，执行已停止。");
        else if (data.type === "unavailable") finish("UNAVAILABLE");
        else if (data.type === "done") finish();
      };
      worker.onerror = () => caseStarted ? fail("RE","执行环境发生错误，已丢弃，将在下次运行时重建。") : finish("UNAVAILABLE");
      worker.onmessageerror = () => fail("RE","执行结果无法读取，已丢弃执行环境。");
      if (python) worker.postMessage({ type: "init", indexURL: options.indexURL ?? new URL(apiPath("/judge/pyodide-314.0.7/"),location.origin).href });
    } catch { finish("UNAVAILABLE"); }
  });
}
