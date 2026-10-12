import { expect, test } from "vitest";
import { localSeedSource } from "../lib/content/local-source";
import { JUDGING_SPECS } from "../lib/judge/specs";
import { judgeOnServer } from "../lib/judge/server";

test.each(Object.keys(JUDGING_SPECS))("服务端复跑 %s 的全部内置用例（含无序比较和原地修改）", async slug => {
  const detail = await localSeedSource.detail(slug);
  const result = await judgeOnServer({
    code: detail.referenceSolutions!.find(item => item.language === "typescript")!.code,
    language: "typescript", problem: JUDGING_SPECS[slug],
  });
  expect(result, JSON.stringify(result)).toMatchObject({ backend: "node", verdict: "AC" });
  expect(result.error).toBeUndefined();
  expect(result.cases).toHaveLength(JUDGING_SPECS[slug].cases.length);
});

test.each([
  ["function twoSum(){return [0,1]}", "WA"],
  ["function twoSum(){throw new Error('broken')}", "RE"],
  ["function {", "RE"],
  ["const noEntry = true;", "RE"],
  ["while(true){}", "TLE"],
  ["async function twoSum(){ await new Promise(() => {}); }", "TLE"],
  ["async function twoSum(){ await Promise.resolve(); while(true){} }", "TLE"],
  ["function twoSum(){ try {console.log('汉'.repeat(20000))} catch {} return [0,1]; }", "RE"],
  ["function twoSum(){ return 'a'.repeat(40000); }", "RE"],
  ["function twoSum(){ return process.env; }", "RE"],
  ["function twoSum(){ return require('node:fs'); }", "RE"],
  ["function twoSum(){ return console.log.constructor('return process')(); }", "RE"],
  ["function twoSum(){ return globalThis.constructor.constructor('return process')(); }", "RE"],
  ["function twoSum(){ globalThis.postMessage({type:'done',verdict:'AC'}); }", "RE"],
] as const)("服务端不能被错误/越界代码伪造 AC：%s", async (code, verdict) => {
  const result = await judgeOnServer({ language: "javascript", code, problem: { ...JUDGING_SPECS["two-sum"], timeLimitMs: 700 } });
  expect(result.error).toBeUndefined();
  expect(result.verdict, JSON.stringify(result)).toBe(verdict);
});

test("服务端用例隔离、入口别名和超时后恢复；Python/空用例不判 AC", async () => {
  const code = `function two_sum(nums, target) {
    if (globalThis.previous) throw new Error('用例污染');
    globalThis.previous = true;
    console.log('汉');
    for (let i = 0; i < nums.length; i++) for (let j = i + 1; j < nums.length; j++)
      if (nums[i] + nums[j] === target) return [i, j];
  }`;
  const input = { language: "javascript" as const, code, problem: JUDGING_SPECS["two-sum"] };
  const result = await judgeOnServer(input);
  expect(result.verdict).toBe("AC");
  expect(result.cases.every(item => item.stdout === "汉\n")).toBe(true);
  expect(await judgeOnServer({ ...input, language: "python" })).toMatchObject({ error: "UNAVAILABLE" });
  expect(await judgeOnServer({ ...input, problem: { ...input.problem, cases: [] } })).toMatchObject({ error: "UNAVAILABLE" });
});
