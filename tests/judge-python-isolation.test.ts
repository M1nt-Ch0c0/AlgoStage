import { afterEach, expect, test } from "vitest";
import { judgeInBrowser } from "../lib/judge/browser";
import { PythonWorkerPool } from "../lib/judge/python-pool";
import { JUDGING_SPECS } from "../lib/judge/specs";
import { createNodeWorker, pythonIndexURL } from "./judge-node-worker";

const pools: PythonWorkerPool[] = [];
const terminations: Promise<unknown>[] = [];
afterEach(async () => {
  pools.splice(0).forEach(pool => pool.dispose());
  await Promise.all(terminations.splice(0));
});

const problem = { ...JUDGING_SPECS["two-sum"], cases: [JUDGING_SPECS["two-sum"].cases[0]] };
const correct = "def two_sum(nums, target):\n    return [0, 1]";
function setup() {
  const workers: { terminated: boolean; interruptBuffer?: Uint8Array }[] = [];
  const pool = new PythonWorkerPool({ indexURL: pythonIndexURL, createWorker: () => {
    const worker = createNodeWorker(true);
    const record: typeof workers[number] = { terminated: false };
    workers.push(record);
    const post = worker.postMessage, terminate = worker.terminate;
    worker.postMessage = data => {
      const message = data as { type?: string; interruptBuffer?: Uint8Array };
      if (message.type === "init") record.interruptBuffer = message.interruptBuffer;
      post(data);
    };
    worker.terminate = () => {
      record.terminated = true;
      const stopped = Promise.resolve(terminate());
      terminations.push(stopped);
      return stopped;
    };
    return worker;
  } });
  pools.push(pool);
  const run = (code: string, timeLimitMs = 2000) => judgeInBrowser({ code, language: "python", problem: { ...problem, timeLimitMs } }, { pythonPool: pool });
  return { pool, workers, run };
}

test("真实 Pyodide 连续提交：复用 worker，但不泄漏 globals、imports、builtins 或递归上限", async () => {
  const { pool, workers, run } = setup();
  pool.preload();
  expect(pool.getStatus()).toBe("loading");
  expect((await run(`
import builtins, colorsys, sys, types
s7_dirty = True
sys.modules['_s7_transient'] = types.ModuleType('_s7_transient')
sys.setrecursionlimit(1250)
builtins.s7_dirty = True
builtins.len = lambda value: 99
del builtins.abs
class Result(list):
    def __iter__(self):
        import builtins, colorsys
        builtins.s7_dirty = True
        return super().__iter__()
def two_sum(nums, target):
    return Result([0, 1])
`)).verdict).toBe("AC");
  expect(pool.getStatus()).toBe("ready");
  const second = await run(`
import builtins, sys
assert 's7_dirty' not in globals()
assert 'colorsys' not in sys.modules
assert '_s7_transient' not in sys.modules
assert not hasattr(builtins, 's7_dirty')
assert len([1, 2]) == 2 and abs(-1) == 1
assert sys.getrecursionlimit() == 500
${correct}
`);
  expect(second.verdict, JSON.stringify(second)).toBe("AC");
  expect(workers).toHaveLength(1);
  expect(workers[0].terminated).toBe(false);
});

test("真实 Pyodide TLE 后后台预热替代 worker，下一次运行清空中断并 AC", async () => {
  const { pool, workers, run } = setup();
  const first = await run("while True:\n    pass", 80);
  expect(first.verdict).toBe("TLE");
  expect(workers).toHaveLength(2);
  expect(workers[0].terminated).toBe(true);
  // 等后台预热完成再写入旧信号，确保运行前主线程与 worker 都会清零。
  const warmed = pool.acquire();
  expect(await warmed.ready).toBe(true);
  warmed.release(true);
  Atomics.store(workers[1].interruptBuffer!, 0, 2);
  const second = await run(correct);
  expect(second.verdict, JSON.stringify(second)).toBe("AC");
  expect(workers).toHaveLength(2);
  expect(workers[1].interruptBuffer?.[0]).toBe(0);
});

test.each([
  ["RecursionError", "def recurse():\n    return recurse()\nrecurse()"],
  ["MemoryError", "raise MemoryError('模拟内存耗尽')"],
  ["清理失败", `
import sys, types
class LockedSys(types.ModuleType):
    def __setattr__(self, name, value):
        if name == 'setrecursionlimit':
            raise RuntimeError('cleanup denied')
        super().__setattr__(name, value)
sys.__class__ = LockedSys
${correct}
`],
])("真实 Pyodide %s 后丢弃并预热，后续提交恢复", async (reason, code) => {
  const { workers, run } = setup();
  const first = await run(code);
  expect(first.verdict, JSON.stringify(first)).toBe("RE");
  expect(first.cases[0].stderr).toContain(reason);
  expect(workers[0].terminated).toBe(true);
  expect(workers).toHaveLength(2);
  const second = await run(correct);
  expect(second.verdict, JSON.stringify(second)).toBe("AC");
  expect(workers).toHaveLength(2);
});

test("真实 Pyodide 从单个 spec 名匹配 snake/camel Solution 方法，且只实例化一次", async () => {
  const { pool, workers } = setup();
  for (const [entry, method] of [["two_sum", "twoSum"], ["twoSum", "two_sum"]]) {
    const result = await judgeInBrowser({ language: "python", problem: {
      ...problem, entryPoints: { ...problem.entryPoints, python: [entry] },
    }, code: `
created = 0
class Solution:
    def __init__(self):
        global created
        created += 1
        assert created == 1
    def ${method}(self, nums, target):
        return [0, 1]
` }, { pythonPool: pool });
    expect(result.verdict, JSON.stringify(result)).toBe("AC");
  }
  expect(workers).toHaveLength(1);
});
