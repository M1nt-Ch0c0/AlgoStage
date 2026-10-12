import assert from "node:assert/strict";
import { test } from "node:test";
import { HOT100 } from "../lib/content/hot100";
import { localSeedSource } from "../lib/content/local-source";
import { JUDGING_SPECS } from "../lib/judge/specs";
import { compareAnswer } from "../lib/judge/compare";
import { judgeInBrowser } from "../lib/judge/browser";
import { createNodeWorker, pythonIndexURL } from "./judge-node-worker";
import type { JudgeLanguage, Verdict } from "../lib/judge/types";
import nextConfig from "../next.config";
const options = { createWorker: createNodeWorker, indexURL: pythonIndexURL };

test("S7：前 20 题的两种语言均覆盖 AC/WA/RE/TLE", { concurrency: 2, timeout: 240000 }, async t => {
  assert.deepEqual(Object.keys(JUDGING_SPECS),HOT100.slice(0,20).map(p=>p.slug));
  const tasks: Promise<unknown>[] = [];
  for (const language of ["typescript","python"] as const) for (const problem of HOT100.slice(0,20)) {
    const detail = await localSeedSource.detail(problem.slug), spec = detail.judging!;
    assert.ok(spec.cases.length>=3);
    for (const verdict of ["AC","WA","RE","TLE"] as const) tasks.push(t.test(`${problem.slug}/${language}/${verdict}`, async ()=> {
      let code: string;
      const name = spec.entryPoints[language][0];
      if (verdict === "AC") code = detail.referenceSolutions!.find(s=>s.language===language)!.code;
      else if (verdict === "WA") code = language === "python" ? `def ${name}(*args):\n    return None` : `function ${name}(...args) { return null; }`;
      else if (verdict === "RE") code = language === "python" ? "raise RuntimeError('测试运行异常')" : "throw new Error('测试运行异常');";
      else code = language === "python" ? "while True:\n    pass" : "while (true) {}";
      const result = await judgeInBrowser({ language, code, problem: { ...spec, timeLimitMs: verdict === "TLE" ? 100 : 2000 } },options);
      assert.equal(result.error,undefined);
      assert.equal(result.verdict,verdict,JSON.stringify(result));
      if (verdict === "AC") assert.equal(result.cases.length,spec.cases.length);
    }));
  }
  await Promise.all(tasks);
});

test("S7：特殊答案、重复解和原地修改规范不能误判",()=>{
  assert.ok(compareAnswer([1,0],JUDGING_SPECS["two-sum"].cases[0],"two-sum"));
  assert.ok(!compareAnswer([0,0],JUDGING_SPECS["two-sum"].cases[0],"two-sum"));
  assert.ok(!compareAnswer([[-1,-1,2],[-1,0,1],[-1,0,1]],JUDGING_SPECS["3sum"].cases[0],"groups"));
  assert.ok(compareAnswer("ba",JUDGING_SPECS["min-window-substring"].cases[4],"min-window"));
  assert.ok(!compareAnswer("aa",JUDGING_SPECS["min-window-substring"].cases[4],"min-window"));
});

test("S7：深递归、吞中断、刷屏与 Worker 崩溃后均丢弃并可再次运行", { timeout: 60000 },async()=>{
  const spec = {...JUDGING_SPECS["two-sum"], timeLimitMs: 1000};
  const samples: [JudgeLanguage,string,Verdict][] = [
    ["typescript","function recurse(){return recurse();} recurse();","RE"],
    ["python","def recurse():\n    return recurse()\nrecurse()","RE"],
    ["python","while True:\n    try:\n        while True: pass\n    except BaseException: pass","TLE"],
    ["typescript","while(true) console.log('汉'.repeat(1000));","RE"],
    ["python","while True: print('汉'*1000)","RE"],
    ["typescript","process.exit(1)","RE"],
  ];
  let created = 0, terminated = 0;
  const tracked = { ...options, createWorker(python:boolean) {
    created++; const worker=createNodeWorker(python), terminate=worker.terminate;
    worker.terminate=()=>{ terminated++; return terminate(); }; return worker;
  }};
  for (const [language,code,verdict] of samples) {
    const result = await judgeInBrowser({language,code,problem:spec},tracked);
    assert.equal(result.verdict,verdict,JSON.stringify(result));
    assert.equal(terminated,created);
    const detail=await localSeedSource.detail("two-sum");
    const recovered=await judgeInBrowser({language,code:detail.referenceSolutions!.find(s=>s.language===language)!.code,problem:spec},tracked);
    assert.equal(recovered.verdict,"AC");
  }
  const controller = new AbortController(); controller.abort();
  const cancelled=await judgeInBrowser({ language:"python",code:"while True: pass",problem:spec },{...tracked,signal:controller.signal});
  assert.equal(cancelled.error,"CANCELLED");
  assert.equal(terminated,created);
});

test("S7：隔离头仅用于独立判题路由",async()=>{
  const headers = await nextConfig.headers!();
  assert.deepEqual(headers.map(h=>h.source),["/judge/:path*"]);
  assert.ok(headers[0].headers.some(h=>h.key==="Cross-Origin-Embedder-Policy" && h.value==="require-corp"));
});
