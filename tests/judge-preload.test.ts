import { createElement, type EffectCallback } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, test, vi } from "vitest";
import JudgeControls from "../components/judge/judge-controls";
import { PythonWorkerPool, pythonWorkerPool } from "../lib/judge/python-pool";
import type { WorkerPort } from "../lib/judge/types";

const effects = vi.hoisted(() => [] as EffectCallback[]);
vi.mock("react", async importOriginal => ({
  ...await importOriginal<typeof import("react")>(),
  // SSR 用于获得首次渲染；手动执行挂载 effect，无需引入浏览器测试依赖。
  useEffect: (effect: EffectCallback) => { effects.push(effect); },
}));
afterEach(() => {
  effects.length = 0;
  vi.restoreAllMocks();
});

test.each([true, false])("题目页初始 TypeScript、练习禁用为 %s 时，控件挂载即预热主备环境", disabled => {
  const workers: WorkerPort[] = [];
  const pool = new PythonWorkerPool({ keepSpare: true, indexURL: "/local/pyodide/", createWorker: () => {
    const worker: WorkerPort = { onmessage: null, onerror: null, onmessageerror: null, postMessage: vi.fn(), terminate: vi.fn() };
    workers.push(worker);
    return worker;
  } });
  vi.spyOn(pythonWorkerPool, "preload").mockImplementation(pool.preload);
  const cleanup: (() => void)[] = [];
  try {
    renderToStaticMarkup(createElement(JudgeControls, { detail: null, code: "", language: "typescript", onLanguage: vi.fn(), disabled }));
    for (const effect of effects) {
      const dispose = effect();
      if (dispose) cleanup.push(dispose);
    }
    expect(workers).toHaveLength(2);
    for (const worker of workers) {
      expect(worker.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "init" }));
      worker.onmessage?.({ data: { type: "ready" } });
    }
    expect(pool.getStatus()).toBe("ready");
    pool.preload();
    expect(workers).toHaveLength(2);
  } finally {
    cleanup.forEach(dispose => dispose());
    pool.dispose();
  }
});
