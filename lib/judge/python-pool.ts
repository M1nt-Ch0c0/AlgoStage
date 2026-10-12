import { apiPath } from "@/lib/runtime";
import type { WorkerPort } from "./types";

export type PythonEnvironmentStatus = "idle" | "loading" | "ready" | "unavailable";
export interface PythonPoolOptions {
  createWorker?: () => WorkerPort;
  indexURL?: string;
  initializationTimeoutMs?: number;
}
interface Slot {
  worker: WorkerPort;
  interruptBuffer?: Uint8Array;
  ready: Promise<boolean>;
  settle: (ready: boolean) => void;
  timer?: ReturnType<typeof setTimeout>;
  state: "loading" | "ready" | "disposed";
}
export interface PythonWorkerLease {
  worker: WorkerPort;
  ready: Promise<boolean>;
  resetInterrupt(): void;
  release(reusable: boolean): void;
}

/** 最多保留一个空闲实例；并行提交独占各自的实例，损坏后后台补充。 */
export class PythonWorkerPool {
  private available?: Slot;
  private slots = new Set<Slot>();
  private listeners = new Set<() => void>();
  private status: PythonEnvironmentStatus = "idle";
  private disposed = false;

  constructor(private options: PythonPoolOptions = {}) {}

  getStatus = (): PythonEnvironmentStatus => this.status;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private notify() {
    this.status = [...this.slots].some(slot => slot.state === "loading") ? "loading"
      : this.slots.size ? "ready" : this.disposed ? "idle" : "unavailable";
    for (const listener of this.listeners) listener();
  }

  private watchIdle(slot: Slot) {
    slot.worker.onmessage = null;
    slot.worker.onerror = slot.worker.onmessageerror = () => this.discard(slot, true);
  }

  private create(): Slot {
    const worker = this.options.createWorker?.() ?? new Worker(apiPath("/judge/python-worker.mjs"), { type: "module" }) as unknown as WorkerPort;
    let settle!: Slot["settle"];
    const slot: Slot = {
      worker, state: "loading", settle: ready => settle(ready),
      ready: new Promise(resolve => { settle = resolve; }),
    };
    this.slots.add(slot);
    slot.timer = setTimeout(() => this.discard(slot, false), this.options.initializationTimeoutMs ?? 60000);
    worker.onmessage = ({ data }) => {
      if (slot.state !== "loading") return;
      if (data.type === "ready") {
        clearTimeout(slot.timer);
        slot.state = "ready";
        this.watchIdle(slot);
        slot.settle(true);
        this.notify();
      } else if (data.type === "unavailable") this.discard(slot, false);
    };
    // 初始化失败不无限重试；下一次提交仍可重新尝试加载。
    worker.onerror = worker.onmessageerror = () => this.discard(slot, false);
    try {
      if (typeof SharedArrayBuffer !== "undefined") slot.interruptBuffer = new Uint8Array(new SharedArrayBuffer(1));
      worker.postMessage({
        type: "init",
        indexURL: this.options.indexURL ?? new URL(apiPath("/judge/pyodide-314.0.7/"), location.origin).href,
        interruptBuffer: slot.interruptBuffer,
      });
    } catch { this.discard(slot, false); }
    this.notify();
    return slot;
  }

  preload = () => {
    if (this.disposed || this.available) return;
    try {
      const slot = this.create();
      if (slot.state !== "disposed") this.available = slot;
    } catch { this.notify(); }
  };

  acquire(): PythonWorkerLease {
    if (this.disposed) throw new Error("Python worker 池已关闭");
    const slot = this.available ?? this.create();
    this.available = undefined;
    let released = false;
    return {
      worker: slot.worker,
      ready: slot.ready,
      resetInterrupt: () => { if (slot.interruptBuffer) Atomics.store(slot.interruptBuffer, 0, 0); },
      release: reusable => {
        if (released) return;
        released = true;
        if (!reusable || slot.state !== "ready") { this.discard(slot, true); return; }
        if (this.available) { this.discard(slot, false); return; }
        this.watchIdle(slot);
        this.available = slot;
        this.notify();
      },
    };
  }

  private discard(slot: Slot, replace: boolean) {
    if (slot.state === "disposed") return;
    slot.state = "disposed";
    clearTimeout(slot.timer);
    slot.settle(false);
    this.slots.delete(slot);
    if (this.available === slot) this.available = undefined;
    slot.worker.onmessage = slot.worker.onerror = slot.worker.onmessageerror = null;
    if (slot.interruptBuffer) Atomics.store(slot.interruptBuffer, 0, 2);
    slot.worker.terminate();
    if (replace) this.preload();
    this.notify();
  }

  dispose() {
    this.disposed = true;
    for (const slot of this.slots) this.discard(slot, false);
    this.notify();
  }
}

export const pythonWorkerPool = new PythonWorkerPool();
