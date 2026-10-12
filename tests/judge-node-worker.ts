/** Node 22 测试适配器：执行与浏览器相同的已构建 module Worker 和 Pyodide WASM。 */
import { Worker } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import type { WorkerPort } from "../lib/judge/browser";
export const pythonIndexURL = resolve("public/judge/pyodide-314.0.7") + "/";
export function createNodeWorker(python: boolean): WorkerPort {
  const entry = pathToFileURL(resolve(`public/judge/${python ? "python" : "javascript"}-worker.mjs`)).href;
  const worker = new Worker(`
    const { parentPort } = require('node:worker_threads');
    globalThis.self = { postMessage: data => parentPort.postMessage(data), onmessage: null };
    const queued = [];
    parentPort.on('message', data => self.onmessage ? self.onmessage({ data }) : queued.push(data));
    import(${JSON.stringify(entry)}).then(() => { for (const data of queued) self.onmessage({data}); });
  `,{ eval: true });
  const port: WorkerPort = { onmessage: null, onerror: null, onmessageerror: null, postMessage: data => worker.postMessage(data), terminate: () => worker.terminate() };
  worker.on("message",data=>port.onmessage?.({data}));
  worker.on("error",error=>port.onerror?.(error));
  worker.on("messageerror",error=>port.onmessageerror?.(error));
  worker.on("exit",code=>{ if (code!==0) port.onerror?.(new Error("Worker exited")); });
  return port;
}
