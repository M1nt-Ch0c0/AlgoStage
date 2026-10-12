/** Pyodide 314 module Worker；默认递归限制防止 Wasm 栈损坏，超时由主线程硬终止。 */
import { compareAnswer } from "./compare";
import { display, outputCollector, postResult, scope } from "./worker-common";
import { runPythonCase, type PythonRuntime } from "./python-runtime";
import type { JudgeInput } from "./types";
interface Pyodide extends PythonRuntime {
  setStdout(options: { write(buffer: Uint8Array): number }): void;
  setStderr(options: { write(buffer: Uint8Array): number }): void;
  setStdin(options: { error: boolean }): void;
  setInterruptBuffer(buffer: Uint8Array): void;
}
let pyodide: Pyodide;
let interruptBuffer: Uint8Array | undefined;
scope.onmessage = async event => {
  const message = event.data;
  if (message.type === "init") {
    try {
      const indexURL = message.indexURL as string;
      const loader = await import(indexURL + "pyodide.mjs");
      pyodide = await loader.loadPyodide({ indexURL });
      pyodide.setStdin({ error: true });
      pyodide.runPython("import sys\nsys.setrecursionlimit(500)");
      interruptBuffer = message.interruptBuffer;
      if (interruptBuffer) {
        Atomics.store(interruptBuffer, 0, 0);
        pyodide.setInterruptBuffer(interruptBuffer);
      }
      scope.postMessage({ type: "ready" });
    } catch { scope.postMessage({ type: "unavailable" }); }
    return;
  }
  const input = message as JudgeInput;
  let reusable = true;
  if (interruptBuffer) Atomics.store(interruptBuffer, 0, 0);
  for (let caseId = 0; caseId < input.problem.cases.length; caseId++) {
    const item = input.problem.cases[caseId], output = outputCollector();
    pyodide.setStdout({ write: output.write.bind(output) });
    pyodide.setStderr({ write: output.write.bind(output) });
    if (interruptBuffer) Atomics.store(interruptBuffer, 0, 0);
    scope.postMessage({ type: "case-start", caseId });
    const started = performance.now();
    try {
      const actual = runPythonCase(pyodide, input.code, item.args, input.problem.entryPoints.python, input.problem.mutatesArg);
      const verdict = compareAnswer(actual,item,input.problem.comparison) ? "AC" : "WA";
      postResult({ caseId, verdict, runtimeMs: performance.now()-started, input: display(item.args), expected: display(item.expected), actual: display(actual), stdout: output.text() });
      if (verdict !== "AC") break;
    } catch (error) {
      reusable = false;
      postResult({ caseId, verdict: "RE", runtimeMs: performance.now()-started, input: display(item.args), expected: display(item.expected), stderr: String(error).slice(0,2000), stdout: output.text() });
      break;
    }
  }
  scope.postMessage({ type: "done", reusable });
};
