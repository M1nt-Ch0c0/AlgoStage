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
function setup(keepSpare = false) {
  const workers: { terminated: boolean; runs: number; interruptBuffer?: Uint8Array }[] = [];
  const pool = new PythonWorkerPool({ keepSpare, indexURL: pythonIndexURL, createWorker: () => {
    const worker = createNodeWorker(true);
    const record: typeof workers[number] = { terminated: false, runs: 0 };
    workers.push(record);
    const post = worker.postMessage, terminate = worker.terminate;
    worker.postMessage = data => {
      const message = data as { type?: string; language?: string; interruptBuffer?: Uint8Array };
      if (message.type === "init") record.interruptBuffer = message.interruptBuffer;
      if (message.language === "python") record.runs++;
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

test.each([
  ["SyntaxError / IndentationError", ["def two_sum(nums, target)\n    return [0, 1]", "def two_sum(nums, target):\nreturn [0, 1]"]],
  ["RuntimeError / 自定义 BaseException", [
    "import builtins, json\nbuiltins.s7_dirty = True\njson.X = 1\nraise RuntimeError('MemoryError / RecursionError 只是普通异常消息')",
    "class UserError(BaseException):\n    pass\ndef two_sum(nums, target):\n    raise UserError('用户异常')",
  ]],
  ["SystemExit / KeyboardInterrupt", ["raise SystemExit('用户退出')", "raise KeyboardInterrupt('用户中断')"]],
  ["返回值序列化异常", [
    "def two_sum(nums, target):\n    return object()",
    "class Result(list):\n    def __iter__(self):\n        raise ValueError('用户迭代异常')\ndef two_sum(nums, target):\n    return Result([0, 1])",
  ]],
])("真实 Pyodide 连续两次 RE（%s）后 AC，清理成功时不创建或替换 worker", async (_reason, codes) => {
  const { pool, workers, run } = setup();
  for (const code of codes) {
    const result = await run(code);
    expect(result.verdict, JSON.stringify(result)).toBe("RE");
    expect(result.cases[0].stderr).toBeTruthy();
    expect(pool.getStatus()).toBe("ready");
    expect(workers).toHaveLength(1);
    expect(workers[0].terminated).toBe(false);
  }
  const result = await run(`
import builtins, json
assert not hasattr(builtins, 's7_dirty')
assert not hasattr(json, 'X')
${correct}
`);
  expect(result.verdict, JSON.stringify(result)).toBe("AC");
  expect(workers).toEqual([expect.objectContaining({ terminated: false, runs: 3 })]);
});

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

test("真实 Pyodide 回归：json.X 与 math.inf 的修改不会带到下一次运行", async () => {
  const { run } = setup();
  const first = await run(`
import json, math
json.X = 1
math.inf = 0
${correct}
`);
  expect(first.verdict, JSON.stringify(first)).toBe("AC");
  const next = await run(`
import json, math
assert not hasattr(json, 'X')
assert math.inf == float('inf')
${correct}
`);
  expect(next.verdict, JSON.stringify(next)).toBe("AC");
});

test("真实 Pyodide 恢复已有模块属性的新增、删除和对象替换，序列化污染也不会泄漏", async () => {
  const { workers, run } = setup();
  const identities = "print(id(json.loads), id(json.dumps), id(json.JSONDecodeError))";
  const first = await run(`
import json, sys, types
${identities}
json.QA_MOD_FLAG = 1
json.dumps = lambda *args, **kwargs: 'null'
del json.loads
del json.JSONDecodeError
sys.modules['json'] = types.ModuleType('json')
sys.modules['_qa_added'] = types.ModuleType('_qa_added')
del sys.modules['collections']
sys.modules = dict(sys.modules)
class Result(list):
    def __iter__(self):
        json.QA_SERIALIZE_FLAG = 1
        return super().__iter__()
def two_sum(nums, target):
    return Result([0, 1])
`);
  expect(first.verdict, JSON.stringify(first)).toBe("AC");
  for (let attempt = 0; attempt < 2; attempt++) {
    const next = await run(`
import json, sys
assert not hasattr(json, 'QA_MOD_FLAG')
assert not hasattr(json, 'QA_SERIALIZE_FLAG')
assert '_qa_added' not in sys.modules
assert 'collections' in sys.modules
assert json.loads('{"ok": true}') == {'ok': True}
assert json.dumps([0, 1]) == '[0, 1]'
assert json.JSONDecodeError is json.decoder.JSONDecodeError
${identities}
${correct}
`);
    expect(next.verdict, JSON.stringify(next)).toBe("AC");
    expect(next.cases[0].stdout).toBe(first.cases[0].stdout);
  }
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

test("真实 Pyodide TLE 后首次提交直接使用已预热备用，同时后台补齐实例", async () => {
  const { pool, workers, run } = setup(true);
  pool.preload();
  const primary = pool.acquire(), spare = pool.acquire();
  expect(await primary.ready).toBe(true);
  expect(await spare.ready).toBe(true);
  primary.release(true); spare.release(true);
  const first = await run("while True:\n    pass", 80);
  expect(first.verdict).toBe("TLE");
  expect(workers[0].terminated).toBe(true);
  expect(workers).toHaveLength(3);
  expect(pool.getStatus()).toBe("ready");
  Atomics.store(workers[1].interruptBuffer!, 0, 2);
  const next = await run(correct);
  expect(next.verdict, JSON.stringify(next)).toBe("AC");
  expect(workers[1].runs).toBe(1);
  expect(workers[1].interruptBuffer?.[0]).toBe(0);
  expect(workers[2].runs).toBe(0);
  expect(workers).toHaveLength(3);
});

test.each([
  ["RecursionError", "def recurse():\n    return recurse()\nrecurse()"],
  ["MemoryError", "raise MemoryError('模拟内存耗尽')"],
  ["RecursionError 子类", "class DeepError(RecursionError):\n    pass\nraise DeepError('RecursionError 子类')"],
  ["MemoryError 子类", "class Exhausted(MemoryError):\n    pass\nraise Exhausted('MemoryError 子类')"],
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

test("真实 Pyodide 覆盖 builtins（str/repr/type）后抛异常，在 restore 前正确格式化异常信息", async () => {
  const { run } = setup();
  const result = await run(`
import builtins
builtins.str = None
builtins.repr = None
builtins.type = None
raise ValueError("custom_error_message")
`);
  expect(result.verdict, JSON.stringify(result)).toBe("RE");
  expect(result.cases[0].stderr).toContain("ValueError: custom_error_message");

  // 验证环境已被 restore 正常恢复，下一题可以正常运行
  const next = await run(correct);
  expect(next.verdict, JSON.stringify(next)).toBe("AC");
});

