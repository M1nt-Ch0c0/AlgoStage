/** Pyodide 314 module Worker；默认递归限制防止 Wasm 栈损坏，超时由主线程硬终止。 */
import { compareAnswer } from "./compare";
import { display, outputCollector, postResult, scope } from "./worker-common";
import type { JudgeInput } from "./types";
interface Pyodide {
  globals: { set(name: string, value: unknown): void };
  runPython(code: string): unknown;
  setStdout(options: { write(buffer: Uint8Array): number }): void;
  setStderr(options: { write(buffer: Uint8Array): number }): void;
  setStdin(options: { error: boolean }): void;
}
let pyodide: Pyodide;
const harness = `
import json, sys
sys.setrecursionlimit(500)
_namespace = {}
_args = json.loads(__args_json)
exec(__source, _namespace)
_fn = None
for _name in json.loads(__names_json):
    if callable(_namespace.get(_name)):
        _fn = _namespace[_name]
        break
    if 'Solution' in _namespace:
        _fn = getattr(_namespace['Solution'](), _name, None)
        if callable(_fn):
            break
if not callable(_fn):
    raise ValueError('没有找到题目入口函数')
_returned = _fn(*_args)
_actual = _args[__mutates] if __mutates >= 0 else _returned
json.dumps(_actual, ensure_ascii=False, allow_nan=False)
`;
scope.onmessage = async event => {
  const message = event.data;
  if (message.type === "init") {
    try {
      const indexURL = message.indexURL as string;
      const loader = await import(indexURL + "pyodide.mjs");
      pyodide = await loader.loadPyodide({ indexURL });
      pyodide.setStdin({ error: true });
      scope.postMessage({ type: "ready" });
    } catch { scope.postMessage({ type: "unavailable" }); }
    return;
  }
  const input = message as JudgeInput;
  for (let caseId = 0; caseId < input.problem.cases.length; caseId++) {
    const item = input.problem.cases[caseId], output = outputCollector();
    pyodide.setStdout({ write: output.write.bind(output) });
    pyodide.setStderr({ write: output.write.bind(output) });
    pyodide.globals.set("__source",input.code);
    pyodide.globals.set("__args_json",JSON.stringify(item.args));
    pyodide.globals.set("__names_json",JSON.stringify(input.problem.entryPoints.python));
    pyodide.globals.set("__mutates",input.problem.mutatesArg ?? -1);
    scope.postMessage({ type: "case-start", caseId });
    const started = performance.now();
    try {
      const actual = JSON.parse(pyodide.runPython(harness) as string);
      const verdict = compareAnswer(actual,item,input.problem.comparison) ? "AC" : "WA";
      postResult({ caseId, verdict, runtimeMs: performance.now()-started, input: display(item.args), expected: display(item.expected), actual: display(actual), stdout: output.text() });
      if (verdict !== "AC") break;
    } catch (error) {
      postResult({ caseId, verdict: "RE", runtimeMs: performance.now()-started, input: display(item.args), expected: display(item.expected), stderr: String(error).slice(0,2000), stdout: output.text() });
      break;
    }
  }
  scope.postMessage({ type: "done" });
};
