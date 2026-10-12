import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { resolve } from "node:path";
import { JUDGING_SPECS } from "../lib/judge/specs";
import type { JudgeInput, WorkerReply } from "../lib/judge/types";

// Use the installed runtime (including its source maps) for source coverage;
// the existing worker matrix separately checks the distributed public/ copy.
const pythonIndexURL = resolve("node_modules/pyodide") + "/";

const messages: WorkerReply[] = [];
const scope = {
  postMessage: (message: WorkerReply) => messages.push(message),
  onmessage: null as ((event: MessageEvent) => void | Promise<void>) | null,
};
beforeAll(() => vi.stubGlobal("self", scope));
afterAll(() => vi.unstubAllGlobals());

async function run(input: JudgeInput) {
  messages.length = 0;
  await scope.onmessage!({ data: input } as MessageEvent);
  expect(messages.at(-1)).toMatchObject({ type: "done" });
  return messages.filter(message => message.type === "case-result").map(message => message.result);
}

test("worker output limits count UTF-8 bytes and reject oversized return values", async () => {
  const { outputCollector, display, OUTPUT_LIMIT } = await import("../lib/judge/worker-common");
  const output = outputCollector();
  const bytes = new TextEncoder().encode("汉");
  output.write(bytes.slice(0, 1));
  output.write(bytes.slice(1));
  output.print("字", 2);
  expect(output.text()).toBe("汉字 2\n");
  messages.length = 0;
  const bounded = outputCollector();
  expect(bounded.write(new Uint8Array(OUTPUT_LIMIT))).toBe(OUTPUT_LIMIT);
  expect(() => bounded.write(bytes)).toThrow("32 KiB");
  expect(() => bounded.write(bytes)).toThrow("32 KiB");
  expect(messages).toEqual([{ type: "output-limit" }]);
  expect(display(undefined)).toBe("undefined");
  expect(() => display("汉".repeat(Math.ceil(OUTPUT_LIMIT / 3)))).toThrow("返回值过大");
});

test("TypeScript worker reports compile errors, runtime errors, mutations and per-case results", async () => {
  await import("../lib/judge/javascript-worker");
  const input = { language: "typescript" as const, problem: JUDGING_SPECS["two-sum"] };
  for (const code of ["function {", "const noEntry = true", "function twoSum(){ throw new Error('broken'); }"]) {
    expect(await run({ ...input, code })).toMatchObject([{ verdict: "RE" }]);
  }
  expect(await run({ ...input, code: "function twoSum(){ return null; }" })).toMatchObject([{ verdict: "WA" }]);
  const cases = [{ args: [[1, 2]], expected: [2, 1] }, { args: [[3, 4]], expected: [4, 3] }];
  const problem = { ...input.problem, cases, comparison: "exact" as const, mutatesArg: 0 };
  const results = await run({ ...input, problem, code: "function twoSum(nums: number[]) { console.log('汉'); nums.reverse(); }" });
  expect(results).toHaveLength(2);
  expect(results.every(result => result.verdict === "AC" && result.stdout === "汉\n")).toBe(true);
  expect(cases[0].args).toEqual([[1, 2]]);
});

test("Python worker loads real local Pyodide and reports output, mutations and invalid programs", async () => {
  await import("../lib/judge/python-worker");
  messages.length = 0;
  await scope.onmessage!({ data: { type: "init", indexURL: "/missing-pyodide/" } } as MessageEvent);
  expect(messages).toEqual([{ type: "unavailable" }]);
  messages.length = 0;
  const interruptBuffer = new Uint8Array(new SharedArrayBuffer(1));
  await scope.onmessage!({ data: { type: "init", indexURL: pythonIndexURL, interruptBuffer } } as MessageEvent);
  expect(messages).toEqual([{ type: "ready" }]);
  const input = { language: "python" as const, problem: JUDGING_SPECS["two-sum"] };
  Atomics.store(interruptBuffer, 0, 2);
  expect(await run({ ...input, code: "def twoSum(*args):\n    return None" })).toMatchObject([{ verdict: "WA" }]);
  expect(messages.at(-1)).toEqual({ type: "done", reusable: true });
  expect(interruptBuffer[0]).toBe(0);
  expect(await run({ ...input, code: "raise RuntimeError('broken')" })).toMatchObject([{ verdict: "RE" }]);
  expect(messages.at(-1)).toEqual({ type: "done", reusable: false });
  const problem = { ...input.problem, comparison: "exact" as const, mutatesArg: 0,
    cases: [{ args: [[1, 2]], expected: [2, 1] }, { args: [[3, 4]], expected: [4, 3] }] };
  const results = await run({ ...input, problem, code: "def twoSum(nums):\n    print('汉')\n    nums.reverse()" });
  expect(results).toHaveLength(2);
  expect(results.every(result => result.verdict === "AC" && result.stdout === "汉\n")).toBe(true);
});
