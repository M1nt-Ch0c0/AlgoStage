import { apiPath } from "@/lib/runtime";
import type { JudgeCaseResult, JudgeInput, JudgeResult, WorkerPort } from "./types";
import { PythonWorkerPool, pythonWorkerPool, type PythonWorkerLease } from "./python-pool";
export type { WorkerPort } from "./types";
export interface JudgeOptions {
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
  createWorker?: (python: boolean) => WorkerPort;
  indexURL?: string;
  initializationTimeoutMs?: number;
  pythonPool?: PythonWorkerPool;
}
export function judgeInBrowser(input: JudgeInput, options: JudgeOptions = {}): Promise<JudgeResult> {
  return new Promise(resolve => {
    const python = input.language === "python";
    const results: JudgeCaseResult[] = [];
    let worker: WorkerPort | undefined, timer: ReturnType<typeof setTimeout>, finished = false, active = 0, caseStarted = 0;
    let lease: PythonWorkerLease | undefined, ownedPool: PythonWorkerPool | undefined;
    const finish = (error?: JudgeResult["error"], reusable = false) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort",cancel);
      const verdict = error ? "RE" : results.find(c => c.verdict !== "AC")?.verdict ?? (results.length === input.problem.cases.length ? "AC" : "RE");
      ownedPool?.dispose();
      if (lease) lease.release(reusable && (verdict === "AC" || verdict === "WA"));
      else worker?.terminate();
      resolve({ verdict, backend: "browser", cases: results, runtimeMs: results.reduce((sum,c) => sum+c.runtimeMs,0), ...(error ? { error } : {}) });
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
    // 加载文案由控件订阅 worker 池的实际状态，预热后的提交不再闪现加载提示。
    options.onProgress?.("正在准备判题…");
    timer = setTimeout(() => finish("UNAVAILABLE"),options.initializationTimeoutMs ?? (python ? 60000 : 15000));
    const listen = (worker: WorkerPort) => {
      worker.onmessage = ({ data }) => {
        if (finished) return;
        if (data.type === "ready") {
          // 转译阶段沿用初始化超时；首次 case-start 后才按用例执行时间计时。
          worker.postMessage(input);
        } else if (data.type === "case-start") {
          active = data.caseId; caseStarted = Date.now(); clearTimeout(timer);
          options.onProgress?.(`正在运行 ${active+1}/${input.problem.cases.length} 个用例…`);
          timer = setTimeout(() => fail("TLE","超过时间限制，执行已停止。"),input.problem.timeLimitMs);
        } else if (data.type === "case-result") {
          if (Date.now()-caseStarted > input.problem.timeLimitMs || data.result.runtimeMs > input.problem.timeLimitMs) { fail("TLE","超过时间限制，执行已停止。"); return; }
          results.push(data.result);
        } else if (data.type === "output-limit") fail("RE","输出超过 32 KiB，执行已停止。");
        else if (data.type === "unavailable") finish("UNAVAILABLE");
        else if (data.type === "done") finish(undefined, data.reusable === true && results.length > 0 && results.every(result => result.verdict === "AC" || result.verdict === "WA"));
      };
      worker.onerror = () => caseStarted ? fail("RE",python ? "执行环境发生错误，正在重新加载 Python 环境。" : "执行环境发生错误，请重新运行。") : finish("UNAVAILABLE");
      worker.onmessageerror = () => fail("RE","执行结果无法读取，已丢弃执行环境。");
    };
    try {
      if (python) {
        // 自定义 worker 工厂默认只服务本次调用；测试/嵌入方可显式传池来共享。
        let pool = options.pythonPool ?? pythonWorkerPool;
        if (!options.pythonPool && (options.createWorker || options.indexURL)) {
          const createWorker = options.createWorker;
          pool = ownedPool = new PythonWorkerPool({
            createWorker: createWorker ? () => createWorker(true) : undefined,
            indexURL: options.indexURL,
            initializationTimeoutMs: options.initializationTimeoutMs,
            keepSpare: false,
          });
        }
        const acquired = lease = pool.acquire();
        worker = acquired.worker;
        void acquired.ready.then(ready => {
          if (finished) return;
          if (!ready) { finish("UNAVAILABLE"); return; }
          try {
            listen(acquired.worker);
            acquired.resetInterrupt();
            acquired.worker.postMessage(input);
          } catch { finish("UNAVAILABLE"); }
        });
      } else {
        worker = options.createWorker?.(false) ?? new Worker(apiPath("/judge/javascript-worker.mjs"), { type: "module" }) as unknown as WorkerPort;
        listen(worker);
      }
    } catch { finish("UNAVAILABLE"); }
  });
}
