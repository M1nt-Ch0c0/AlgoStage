import { afterEach, describe, expect, test, vi } from "vitest";
import {
  acquireEncodeWorker,
  prewarmEncodeWorker,
  resetEncodeWorkerForTests,
  retireEncodeWorker,
} from "../lib/ask/capture-worker";

class FakeWorker {
  static made: FakeWorker[] = [];
  terminated = false;
  listeners = new Map<string, Set<() => void>>();
  url: string;
  options: WorkerOptions | undefined;

  constructor(url: string | URL, options?: WorkerOptions) {
    this.url = String(url);
    this.options = options;
    FakeWorker.made.push(this);
  }

  addEventListener(type: string, handler: () => void) {
    const set = this.listeners.get(type) ?? new Set();
    set.add(handler);
    this.listeners.set(type, set);
  }

  terminate() {
    this.terminated = true;
  }

  fail() {
    for (const handler of this.listeners.get("error") ?? []) handler();
  }
}

afterEach(() => {
  resetEncodeWorkerForTests();
  FakeWorker.made = [];
  vi.unstubAllGlobals();
});

describe("encode worker singleton", () => {
  test("prewarm creates one module worker and acquire reuses it", () => {
    vi.stubGlobal("Worker", FakeWorker);
    const first = prewarmEncodeWorker();
    const second = prewarmEncodeWorker();
    const acquired = acquireEncodeWorker();
    expect(first).toBe(second);
    expect(acquired).toBe(first);
    expect(FakeWorker.made).toHaveLength(1);
    expect(FakeWorker.made[0]?.options).toEqual({ type: "module" });
    expect(FakeWorker.made[0]?.url).toContain("capture-encode.worker.ts");
    expect(FakeWorker.made[0]?.terminated).toBe(false);
  });

  test("acquire creates the worker on demand when prewarm was not called", () => {
    vi.stubGlobal("Worker", FakeWorker);
    const worker = acquireEncodeWorker();
    expect(worker).toBeInstanceOf(FakeWorker);
    expect(acquireEncodeWorker()).toBe(worker);
    expect(FakeWorker.made).toHaveLength(1);
  });

  test("a missing Worker and a constructor throw fall back to null", () => {
    vi.stubGlobal("Worker", undefined);
    expect(prewarmEncodeWorker()).toBeNull();
    expect(acquireEncodeWorker()).toBeNull();

    vi.stubGlobal(
      "Worker",
      class {
        constructor() {
          throw new Error("blocked");
        }
      },
    );
    expect(prewarmEncodeWorker()).toBeNull();
    expect(acquireEncodeWorker()).toBeNull();
  });

  test("an error event drops the singleton so the next acquire starts a new one", () => {
    vi.stubGlobal("Worker", FakeWorker);
    const first = prewarmEncodeWorker() as unknown as FakeWorker;
    first.fail();
    expect(prewarmEncodeWorker()).toBeNull();
    const next = acquireEncodeWorker();
    expect(next).not.toBe(first);
    expect(FakeWorker.made).toHaveLength(2);
  });

  test("retire terminates that worker and the next acquire starts another", () => {
    vi.stubGlobal("Worker", FakeWorker);
    const first = acquireEncodeWorker() as unknown as FakeWorker;
    retireEncodeWorker(first as unknown as Worker);
    expect(first.terminated).toBe(true);
    const next = acquireEncodeWorker();
    expect(next).not.toBe(first);
    expect(FakeWorker.made).toHaveLength(2);
  });
});
