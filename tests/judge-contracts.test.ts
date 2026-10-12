import { afterEach, expect, test, vi } from "vitest";
import { compareAnswer } from "../lib/judge/compare";
import { judgeInBrowser, type WorkerPort } from "../lib/judge/browser";
import { JUDGING_SPECS } from "../lib/judge/specs";
import type { JudgeCaseResult, WorkerReply } from "../lib/judge/types";

afterEach(() => vi.useRealTimers());

test("answer comparison handles order, duplicate indices, missing windows and object key order", () => {
  expect(compareAnswer([{ a: 1, b: 2 }], { args: [], expected: [{ b: 2, a: 1 }] }, "exact")).toBe(true);
  expect(compareAnswer(undefined, { args: [], expected: null }, "exact")).toBe(false);
  expect(compareAnswer([2, 1], { args: [], expected: [1, 2] }, "unordered")).toBe(true);
  expect(compareAnswer(null, { args: [], expected: [] }, "groups")).toBe(false);
  expect(compareAnswer([], { args: [], expected: null }, "unordered")).toBe(false);
  for (const actual of [null, [0], [0, 0], [0.5, 1], [-1, 1], [0, 9], [1, 2]]) {
    expect(compareAnswer(actual, { args: [[2, 7, 11], 9], expected: [0, 1] }, "two-sum")).toBe(false);
  }
  for (const actual of [null, "longer", "zz", "AA"]) {
    expect(compareAnswer(actual, { args: ["AABC", "AB"], expected: "AB" }, "min-window")).toBe(false);
  }
  expect(compareAnswer("", { args: ["ABC", "D"], expected: "" }, "min-window")).toBe(true);
  expect(compareAnswer("AB", { args: ["AABC", "AB"], expected: "AB" }, "min-window")).toBe(true);
});

test("judge handles unavailable workers, cancellation, bad messages and late results without leaking workers", async () => {
  vi.useFakeTimers();
  const input = { language: "typescript" as const, code: "", problem: JUDGING_SPECS["two-sum"] };
  function start() {
    const terminate = vi.fn();
    const worker: WorkerPort = { onmessage: null, onerror: null, onmessageerror: null, postMessage: vi.fn(), terminate };
    const controller = new AbortController();
    const onProgress = vi.fn();
    const result = judgeInBrowser(input, { createWorker: () => worker, initializationTimeoutMs: 10, signal: controller.signal, onProgress });
    const send = (data: WorkerReply) => worker.onmessage?.({ data });
    return { worker, terminate, controller, onProgress, result, send };
  }
  const timeout = start();
  await vi.advanceTimersByTimeAsync(10);
  expect(await timeout.result).toMatchObject({ error: "UNAVAILABLE" });
  expect(timeout.terminate).toHaveBeenCalledOnce();
  const unavailable = start();
  unavailable.send({ type: "unavailable" });
  expect(await unavailable.result).toMatchObject({ error: "UNAVAILABLE" });
  const cancelled = start();
  cancelled.controller.abort();
  cancelled.send({ type: "done" });
  expect(await cancelled.result).toMatchObject({ error: "CANCELLED" });
  expect(cancelled.terminate).toHaveBeenCalledOnce();
  const broken = start();
  broken.worker.onerror?.(new Error("init failed"));
  expect(await broken.result).toMatchObject({ error: "UNAVAILABLE" });
  const badMessage = start();
  badMessage.worker.onmessageerror?.(new Error("unreadable"));
  expect(await badMessage.result).toMatchObject({ verdict: "RE" });
  const late = start();
  late.send({ type: "ready" });
  expect(late.worker.postMessage).toHaveBeenCalledWith(input);
  late.send({ type: "case-start", caseId: 0 });
  expect(late.onProgress).toHaveBeenCalledTimes(2);
  late.send({ type: "case-result", result: { runtimeMs: input.problem.timeLimitMs + 1 } as JudgeCaseResult });
  expect(await late.result).toMatchObject({ verdict: "TLE" });
  expect(late.terminate).toHaveBeenCalledOnce();
  expect(await judgeInBrowser(input, { createWorker: () => { throw new Error("unsupported"); } })).toMatchObject({ error: "UNAVAILABLE" });
  expect(vi.getTimerCount()).toBe(0);
});
