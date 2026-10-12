import { apiPath } from "@/lib/runtime";
import type { WorkerPort } from "./types";

export type PythonEnvironmentStatus = "idle" | "loading" | "ready" | "unavailable";
export interface PythonPoolOptions {
  createWorker?: () => WorkerPort;
  indexURL?: string;
  initializationTimeoutMs?: number;
  /** 单次调用或已知内存紧张时可关闭备用预热。 */
  keepSpare?: boolean;
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

/** 预热一个执行实例和一个备用实例；低内存设备退回单实例，提交始终独占租约。 */
export class PythonWorkerPool {
  private available: Slot[] = [];
  private slots = new Set<Slot>();
  private listeners = new Set<() => void>();
  private status: PythonEnvironmentStatus = "idle";
  private disposed = false;
  private preloading = false;
  private warmCapacity: number;

  constructor(private options: PythonPoolOptions = {}) {
    const memory = typeof navigator === "undefined" ? undefined : (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
    this.warmCapacity = (options.keepSpare ?? (memory === undefined || memory >= 4)) ? 2 : 1;
  }

  getStatus = (): PythonEnvironmentStatus => this.status;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private notify() {
    // 已有可用环境时，后台补备用实例不让加载提示重新闪现。
    this.status = [...this.slots].some(slot => slot.state === "ready") ? "ready"
      : [...this.slots].some(slot => slot.state === "loading") ? "loading"
      : this.disposed ? "idle" : "unavailable";
    for (const listener of this.listeners) listener();
  }

  private watchIdle(slot: Slot) {
    slot.worker.onmessage = null;
    slot.worker.onerror = slot.worker.onmessageerror = () => this.discard(slot, true);
  }

  private initializationFailed(slot: Slot) {
    if (slot.state !== "loading") return;
    // 分配或加载第二个环境失败时退回单实例，避免内存紧张时反复补备用。
    if (this.slots.size > 1) this.warmCapacity = 1;
    this.discard(slot, false);
  }

  private create(): Slot {
    const worker = this.options.createWorker?.() ?? new Worker(apiPath("/judge/python-worker.mjs"), { type: "module" }) as unknown as WorkerPort;
    let settle!: Slot["settle"];
    const slot: Slot = {
      worker, state: "loading", settle: ready => settle(ready),
      ready: new Promise(resolve => { settle = resolve; }),
    };
    this.slots.add(slot);
    slot.timer = setTimeout(() => this.initializationFailed(slot), this.options.initializationTimeoutMs ?? 60000);
    worker.onmessage = ({ data }) => {
      if (slot.state !== "loading") return;
      if (data.type === "ready") {
        clearTimeout(slot.timer);
        slot.state = "ready";
        this.watchIdle(slot);
        slot.settle(true);
        this.notify();
      } else if (data.type === "unavailable") this.initializationFailed(slot);
    };
    // 初始化失败不无限重试；下一次提交仍可重新尝试加载。
    worker.onerror = worker.onmessageerror = () => this.initializationFailed(slot);
    try {
      if (typeof SharedArrayBuffer !== "undefined") slot.interruptBuffer = new Uint8Array(new SharedArrayBuffer(1));
      worker.postMessage({
        type: "init",
        indexURL: this.options.indexURL ?? new URL(apiPath("/judge/pyodide-314.0.7/"), location.origin).href,
        interruptBuffer: slot.interruptBuffer,
      });
    } catch { this.initializationFailed(slot); }
    this.notify();
    return slot;
  }

  preload = () => {
    if (this.disposed || this.preloading) return;
    this.preloading = true;
    try {
      // 租出的实例也计入预热额度，普通连续提交最多占用两个实例。
      while (this.slots.size < this.warmCapacity) {
        const slot = this.create();
        if (slot.state === "disposed") break;
        this.available.push(slot);
      }
    } catch {
      if (this.slots.size) this.warmCapacity = 1;
      this.notify();
    }
    finally { this.preloading = false; }
  };

  acquire(): PythonWorkerLease {
    if (this.disposed) throw new Error("Python worker 池已关闭");
    // 替换实例还在加载时，立即借出已预热的备用实例。
    const readyIndex = this.available.findIndex(slot => slot.state === "ready");
    const slot = this.available.splice(readyIndex < 0 ? 0 : readyIndex, 1)[0] ?? this.create();
    this.preload();
    let released = false;
    return {
      worker: slot.worker,
      ready: slot.ready,
      resetInterrupt: () => { if (slot.interruptBuffer) Atomics.store(slot.interruptBuffer, 0, 0); },
      release: reusable => {
        if (released) return;
        released = true;
        if (!reusable || slot.state !== "ready") { this.discard(slot, true); return; }
        this.watchIdle(slot);
        this.available.push(slot);
        // 并行提交归还后收缩池；优先保留已经就绪的实例。
        while (this.available.length > this.warmCapacity) {
          this.discard(this.available.find(idle => idle.state === "loading") ?? this.available[this.available.length - 1], false);
        }
        this.preload();
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
    this.available = this.available.filter(idle => idle !== slot);
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
