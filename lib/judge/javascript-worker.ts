/** 用户代码只在独立 Worker 中执行；TS 先在 Worker 中转译为 JS。 */
import ts from "typescript";
import { compareAnswer } from "./compare";
import { display, outputCollector, postResult, scope } from "./worker-common";
import type { JudgeInput } from "./types";

scope.onmessage = async (event) => {
  const input = event.data as JudgeInput;
  let code = input.code;
  let compilationError = "";
  if (input.language === "typescript") {
    const compiled = ts.transpileModule(code, { reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } });
    code = compiled.outputText;
    compilationError = (compiled.diagnostics ?? []).filter(d => d.category === ts.DiagnosticCategory.Error).map(d => ts.flattenDiagnosticMessageText(d.messageText,"\n")).join("\n");
  }
  for (let caseId = 0; caseId < input.problem.cases.length; caseId++) {
    const item = input.problem.cases[caseId], args = structuredClone(item.args), output = outputCollector();
    scope.postMessage({ type: "case-start", caseId });
    const started = performance.now();
    try {
      if (compilationError) throw new Error(compilationError);
      const logger = { log: output.print.bind(output), info: output.print.bind(output), warn: output.print.bind(output), error: output.print.bind(output), debug: output.print.bind(output) };
      const selector = input.problem.entryPoints[input.language].map(name => `if (typeof ${name} === 'function') return ${name};`).join("\n");
      const fn = new Function("console", `${code}\n${selector}\nthrow new Error('没有找到题目入口函数');`)(logger);
      const returned = await fn(...args);
      const actual = input.problem.mutatesArg === undefined ? returned : args[input.problem.mutatesArg];
      const verdict = compareAnswer(actual, item, input.problem.comparison) ? "AC" : "WA";
      postResult({ caseId, verdict, runtimeMs: performance.now()-started, input: display(item.args), expected: display(item.expected), actual: display(actual), stdout: output.text() });
      if (verdict !== "AC") break;
    } catch (error) {
      postResult({ caseId, verdict: "RE", runtimeMs: performance.now()-started, input: display(item.args), expected: display(item.expected), stderr: String(error).slice(0,2000), stdout: output.text() });
      break;
    }
  }
  scope.postMessage({ type: "done" });
};
scope.postMessage({ type: "ready" });
