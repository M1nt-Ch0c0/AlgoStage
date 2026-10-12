import type { Comparison, JudgeCase } from "./types";
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}
export function compareAnswer(actual: unknown, item: JudgeCase, comparison: Comparison): boolean {
  if (comparison === "two-sum") {
    if (!Array.isArray(actual) || actual.length !== 2 || !actual.every(Number.isInteger)) return false;
    const [a,b] = actual as number[], [nums,target] = item.args as [number[], number];
    return a !== b && a >= 0 && b >= 0 && a < nums.length && b < nums.length && nums[a] + nums[b] === target;
  }
  if (comparison === "min-window") {
    if (typeof actual !== "string" || actual.length !== (item.expected as string).length) return false;
    const [s,t] = item.args as [string,string];
    if (!s.includes(actual)) return false;
    if (!actual.length) return item.expected === "";
    const counts = new Map<string,number>();
    for (const ch of actual) counts.set(ch,(counts.get(ch) ?? 0)+1);
    for (const ch of t) { const n=counts.get(ch) ?? 0; if (!n) return false; counts.set(ch,n-1); }
    return true;
  }
  if (comparison === "unordered" || comparison === "groups") {
    if (!Array.isArray(actual) || !Array.isArray(item.expected)) return false;
    const normalize = (value: unknown[]) => value.map(part => comparison === "groups" && Array.isArray(part) ? part.map(stable).sort().join("|") : stable(part)).sort();
    return stable(normalize(actual)) === stable(normalize(item.expected));
  }
  return stable(actual) === stable(item.expected);
}
