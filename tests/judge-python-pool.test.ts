import { afterEach, expect, test, vi } from "vitest";
import { judgeInBrowser, type WorkerPort } from "../lib/judge/browser";
import { PythonWorkerPool, type PythonPoolOptions } from "../lib/judge/python-pool";
import { JUDGING_SPECS } from "../lib/judge/specs";
import type { WorkerReply } from "../lib/judge/types";
import { judgeSignature, pythonEntryPoints } from "../lib/judge/entry-points";

const pools: PythonWorkerPool[] = [];
afterEach(() => {
  pools.splice(0).forEach(pool => pool.dispose());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const problem = { ...JUDGING_SPECS["two-sum"], cases: [JUDGING_SPECS["two-sum"].cases[0]] };
const input = { language: "python" as const, code: "", problem };
function setup(options: Pick<PythonPoolOptions, "keepSpare"> = { keepSpare: false }) {
  const workers: (WorkerPort & { send: (reply: WorkerReply) => void })[] = [];
  const pool = new PythonWorkerPool({ ...options, indexURL: "/local/pyodide/", initializationTimeoutMs: 60000, createWorker: () => {
    const worker = { onmessage: null, onerror: null, onmessageerror: null,
      postMessage: vi.fn(), terminate: vi.fn(), send: (data: WorkerReply) => worker.onmessage?.({ data }),
    } as typeof workers[number];
    workers.push(worker);
    return worker;
  } });
  pools.push(pool);
  return { pool, workers };
}
function complete(worker: ReturnType<typeof setup>["workers"][number], reusable = true) {
  worker.send({ type: "case-start", caseId: 0 });
  worker.send({ type: "case-result", result: { caseId: 0, verdict: "AC", runtimeMs: 1, input: "", expected: "" } });
  worker.send({ type: "done", reusable });
}

test.each([false, true])("加载提示只跟随实际池状态，预热状态为 %s 时运行不会误报加载", async warmed => {
  const { pool, workers } = setup();
  pool.preload();
  expect(pool.getStatus()).toBe("loading");
  if (warmed) workers[0].send({ type: "ready" });
  const statuses: string[] = [];
  pool.subscribe(() => statuses.push(pool.getStatus()));
  for (let attempt = 0; attempt < 2; attempt++) {
    const onProgress = vi.fn();
    const result = judgeInBrowser(input, { pythonPool: pool, onProgress });
    expect(pool.getStatus()).toBe(warmed || attempt > 0 ? "ready" : "loading");
    if (!warmed && attempt === 0) workers[0].send({ type: "ready" });
    await Promise.resolve();
    expect(pool.getStatus()).toBe("ready");
    expect(onProgress).toHaveBeenLastCalledWith("正在准备判题…");
    complete(workers[0]);
    expect((await result).verdict).toBe("AC");
    expect(onProgress.mock.calls.flat()).not.toContain("正在加载 Python 环境…");
  }
  expect(statuses).not.toContain("loading");
  expect(workers).toHaveLength(1);
});

test("备用实例让 TLE 后的首次提交立即运行，后台补齐后再次 TLE 仍有备用", async () => {
  vi.useFakeTimers();
  const { pool, workers } = setup({ keepSpare: true });
  pool.preload(); pool.preload();
  expect(workers).toHaveLength(2);
  for (const worker of workers) worker.send({ type: "ready" });
  const statuses: string[] = [];
  pool.subscribe(() => statuses.push(pool.getStatus()));
  for (const failedIndex of [0, 2]) {
    const first = judgeInBrowser(input, { pythonPool: pool });
    await Promise.resolve();
    workers[failedIndex].send({ type: "case-start", caseId: 0 });
    await vi.advanceTimersByTimeAsync(problem.timeLimitMs);
    expect((await first).verdict).toBe("TLE");
    expect(workers[failedIndex].terminate).toHaveBeenCalledOnce();
    expect(workers.filter(worker => !vi.mocked(worker.terminate).mock.calls.length)).toHaveLength(2);
    const progress = vi.fn();
    const next = judgeInBrowser(input, { pythonPool: pool, onProgress: progress });
    await Promise.resolve();
    // 新补的环境尚未 ready，备用实例已经收到本次提交。
    expect(workers[1].postMessage).toHaveBeenLastCalledWith(input);
    complete(workers[1]);
    expect((await next).verdict).toBe("AC");
    expect(progress.mock.calls.flat()).not.toContain("正在加载 Python 环境…");
    workers.at(-1)!.send({ type: "ready" });
  }
  expect(statuses).not.toContain("loading");
  expect(workers).toHaveLength(4);
});

test("优先借出已预热的实例，不等待更早创建但仍加载中的实例", async () => {
  const { pool, workers } = setup({ keepSpare: true });
  pool.preload();
  workers[1].send({ type: "ready" });
  const result = judgeInBrowser(input, { pythonPool: pool });
  await Promise.resolve();
  expect(workers[1].postMessage).toHaveBeenLastCalledWith(input);
  expect(pool.getStatus()).toBe("ready");
  complete(workers[1]);
  expect((await result).verdict).toBe("AC");
  expect(workers).toHaveLength(2);
});

test.each([undefined, 8, 4, 2, 0.5])("依据设备内存 %s GiB 决定是否保留备用", memory => {
  vi.stubGlobal("navigator", { deviceMemory: memory });
  const { pool, workers } = setup({});
  pool.preload(); pool.preload();
  expect(workers).toHaveLength(memory === undefined || memory >= 4 ? 2 : 1);
  pool.dispose();
  pool.preload();
  expect(pool.getStatus()).toBe("idle");
  expect(workers.every(worker => vi.mocked(worker.terminate).mock.calls.length === 1)).toBe(true);
});

test.each(["unavailable", "error", "timeout"])("备用初始化 %s 时退回单实例，主实例仍可连续使用", async failure => {
  vi.useFakeTimers();
  const { pool, workers } = setup({ keepSpare: true });
  pool.preload();
  workers[0].send({ type: "ready" });
  if (failure === "unavailable") workers[1].send({ type: "unavailable" });
  else if (failure === "error") workers[1].onerror?.(new Error("out of memory"));
  else await vi.advanceTimersByTimeAsync(60000);
  expect(workers[1].terminate).toHaveBeenCalledOnce();
  expect(pool.getStatus()).toBe("ready");
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = judgeInBrowser(input, { pythonPool: pool });
    await Promise.resolve();
    complete(workers[0]);
    expect((await result).verdict).toBe("AC");
  }
  expect(workers).toHaveLength(2);
});

test("备用 worker 构造失败也不影响已经预热的主实例", async () => {
  // 通过真实的 Worker 工厂入口模拟浏览器拒绝第二次分配。
  const worker: WorkerPort = { onmessage: null, onerror: null, onmessageerror: null, postMessage: vi.fn(), terminate: vi.fn() };
  const createWorker = vi.fn().mockReturnValueOnce(worker).mockImplementation(() => { throw new Error("out of memory"); });
  const limited = new PythonWorkerPool({ keepSpare: true, indexURL: "/local/pyodide/", createWorker });
  pools.push(limited);
  limited.preload();
  worker.onmessage?.({ data: { type: "ready" } });
  const lease = limited.acquire();
  expect(await lease.ready).toBe(true);
  lease.release(true);
  limited.preload();
  expect(createWorker).toHaveBeenCalledTimes(2);
  expect(limited.getStatus()).toBe("ready");
  expect(worker.terminate).not.toHaveBeenCalled();
});

test("双实例池的并行租约互不共享，归还和销毁后不留下多余 worker", async () => {
  const { pool, workers } = setup({ keepSpare: true });
  pool.preload();
  const leases = [pool.acquire(), pool.acquire(), pool.acquire()];
  expect(new Set(leases.map(lease => lease.worker)).size).toBe(3);
  for (const worker of workers) worker.send({ type: "ready" });
  await Promise.all(leases.map(lease => lease.ready));
  for (const lease of leases) lease.release(true);
  expect(workers.filter(worker => !vi.mocked(worker.terminate).mock.calls.length)).toHaveLength(2);
  pool.dispose();
  for (const lease of leases) lease.release(true);
  expect(workers.every(worker => vi.mocked(worker.terminate).mock.calls.length === 1)).toBe(true);
});

test("预热去重，只有收到清理完成确认的 worker 才复用，逐用例开始计时", async () => {
  vi.useFakeTimers();
  const { pool, workers } = setup();
  const listener = vi.fn();
  const unsubscribe = pool.subscribe(listener);
  pool.preload(); pool.preload();
  expect(workers).toHaveLength(1);
  expect(pool.getStatus()).toBe("loading");
  const first = judgeInBrowser(input, { pythonPool: pool });
  // 环境加载远超过用例限时也不会 TLE。
  await vi.advanceTimersByTimeAsync(problem.timeLimitMs + 100);
  expect(workers[0].terminate).not.toHaveBeenCalled();
  workers[0].send({ type: "ready" });
  await Promise.resolve();
  expect(workers[0].postMessage).toHaveBeenLastCalledWith(input);
  complete(workers[0]);
  expect((await first).verdict).toBe("AC");
  expect(pool.getStatus()).toBe("ready");
  const second = judgeInBrowser(input, { pythonPool: pool });
  await Promise.resolve();
  complete(workers[0], false);
  expect((await second).verdict).toBe("AC");
  expect(workers[0].terminate).toHaveBeenCalledOnce();
  expect(workers).toHaveLength(2);
  expect(pool.getStatus()).toBe("loading");
  expect(listener).toHaveBeenCalled();
  unsubscribe();
});

test.each(["abort", "error", "messageerror", "TLE"])("%s 后立即丢弃并预热，迟到消息不能污染下一次提交", async failure => {
  vi.useFakeTimers();
  const { pool, workers } = setup();
  const controller = new AbortController();
  const first = judgeInBrowser(input, { pythonPool: pool, signal: controller.signal });
  workers[0].send({ type: "ready" });
  await Promise.resolve();
  workers[0].send({ type: "case-start", caseId: 0 });
  const late = workers[0].onmessage;
  if (failure === "abort") controller.abort();
  else if (failure === "error") workers[0].onerror?.(new Error("crashed"));
  else if (failure === "messageerror") workers[0].onmessageerror?.(new Error("bad message"));
  else await vi.advanceTimersByTimeAsync(problem.timeLimitMs);
  const failed = await first;
  expect(failed.error ?? failed.verdict).toBe(failure === "abort" ? "CANCELLED" : failure === "TLE" ? "TLE" : "RE");
  expect(workers[0].terminate).toHaveBeenCalledOnce();
  expect(workers).toHaveLength(2);
  late?.({ data: { type: "done", reusable: true } });
  const second = judgeInBrowser(input, { pythonPool: pool });
  workers[1].send({ type: "ready" });
  await Promise.resolve();
  complete(workers[1]);
  expect((await second).verdict).toBe("AC");
  expect(workers[1].terminate).not.toHaveBeenCalled();
});

test("每个用例单独计时，总运行时间可以超过单例限制", async () => {
  vi.useFakeTimers();
  const { pool, workers } = setup();
  const result = judgeInBrowser({ ...input, problem: { ...problem, timeLimitMs: 100, cases: [problem.cases[0], problem.cases[0]] } }, { pythonPool: pool });
  workers[0].send({ type: "ready" });
  await Promise.resolve();
  for (const caseId of [0, 1]) {
    workers[0].send({ type: "case-start", caseId });
    await vi.advanceTimersByTimeAsync(90);
    workers[0].send({ type: "case-result", result: { caseId, verdict: "AC", runtimeMs: 90, input: "", expected: "" } });
  }
  workers[0].send({ type: "done", reusable: true });
  expect(await result).toMatchObject({ verdict: "AC", runtimeMs: 180 });
  expect(workers[0].terminate).not.toHaveBeenCalled();
});

test("无 SharedArrayBuffer 仍可预热和判题，空闲 worker 崩溃也会后台替换", async () => {
  vi.stubGlobal("SharedArrayBuffer", undefined);
  const { pool, workers } = setup();
  pool.preload();
  expect(workers[0].postMessage).toHaveBeenCalledWith({ type: "init", indexURL: "/local/pyodide/", interruptBuffer: undefined });
  workers[0].send({ type: "ready" });
  workers[0].onerror?.(new Error("idle crash"));
  expect(workers).toHaveLength(2);
  const result = judgeInBrowser(input, { pythonPool: pool });
  workers[1].send({ type: "ready" });
  await Promise.resolve();
  complete(workers[1]);
  expect((await result).verdict).toBe("AC");
});

test("预热失败停止重试，加载中取消会回收实例，并行租约不会共享 worker", async () => {
  const { pool, workers } = setup();
  pool.preload();
  workers[0].send({ type: "unavailable" });
  expect(pool.getStatus()).toBe("unavailable");
  expect(workers).toHaveLength(1);
  const controller = new AbortController();
  const cancelled = judgeInBrowser(input, { pythonPool: pool, signal: controller.signal });
  controller.abort();
  expect((await cancelled).error).toBe("CANCELLED");
  expect(workers[1].terminate).toHaveBeenCalledOnce();
  expect(workers).toHaveLength(3);
  const first = pool.acquire(), second = pool.acquire();
  expect(first.worker).not.toBe(second.worker);
  workers[2].send({ type: "ready" }); workers[3].send({ type: "ready" });
  await Promise.all([first.ready, second.ready]);
  first.release(true); second.release(true);
  expect(workers[2].terminate).not.toHaveBeenCalled();
  expect(workers[3].terminate).toHaveBeenCalledOnce();
});

test("函数签名使用题目参数，入口统一生成 snake/camel 别名", () => {
  expect(pythonEntryPoints(["two_sum"])).toEqual(["two_sum", "twoSum"]);
  expect(pythonEntryPoints(["twoSum", "two_sum"])).toEqual(["twoSum", "two_sum"]);
  expect(judgeSignature(problem, "python")).toBe("def two_sum(nums, target):");
  expect(judgeSignature(problem, "typescript")).toBe("function twoSum(nums, target)");
  for (const spec of Object.values(JUDGING_SPECS)) expect(spec.parameters).toHaveLength(spec.cases[0].args.length);
});
