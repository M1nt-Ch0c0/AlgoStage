// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import JudgeControls from "../components/judge/judge-controls";
import { judgeInBrowser } from "../lib/judge/browser";
import { pythonWorkerPool } from "../lib/judge/python-pool";
import { localSeedSource } from "../lib/content/local-source";
import type { JudgeResult } from "../lib/judge/types";

vi.mock("../lib/runtime", async importOriginal => ({ ...await importOriginal<typeof import("../lib/runtime")>(), IS_DEMO: true }));
vi.mock("../lib/judge/browser", () => ({ judgeInBrowser: vi.fn() }));

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(pythonWorkerPool, "preload").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.innerHTML = ""; });

const localResult = (verdict: JudgeResult["verdict"]): JudgeResult => ({
  backend: "browser", verdict, runtimeMs: 1.4,
  cases: ["AC", verdict].map((value, caseId) => ({
    caseId, verdict: value as JudgeResult["verdict"], runtimeMs: 0.7,
    input: "[1, 2]", expected: "3", actual: value === "AC" ? "3" : "0",
  })),
});

async function runJudge(language: "python" | "typescript") {
  const detail = await localSeedSource.detail("two-sum"), onResult = vi.fn();
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(JudgeControls, {
    detail, code: "exact submitted source", language, onLanguage: vi.fn(), onResult,
  })));
  const run = Array.from(container.querySelectorAll("button")).find(button => button.textContent === "运行")!;
  await act(async () => run.click());
  return { container, root, onResult, run };
}

test.each([
  ["python", "AC"], ["python", "WA"], ["python", "RE"], ["python", "TLE"],
  ["typescript", "WA"], ["typescript", "RE"], ["typescript", "TLE"],
] as const)("Demo %s 的 %s 结果正常显示且不上报进度", async (language, verdict) => {
  const result = localResult(verdict);
  vi.mocked(judgeInBrowser).mockResolvedValue(result);
  const fetcher = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("不应发起请求"));
  const { container, root, onResult, run } = await runJudge(language);
  try {
    expect(fetcher).not.toHaveBeenCalled();
    expect(container.querySelector('[role="status"]')?.textContent).toBe(`${verdict} · ${verdict === "AC" ? 2 : 1}/4 个用例通过（体验版不保存）`);
    expect(container.textContent).not.toContain("已保存");
    expect(onResult).toHaveBeenCalledExactlyOnceWith(result);
    expect(run.disabled).toBe(false);
    if (verdict !== "AC") {
      expect(Array.from(container.querySelectorAll("pre")).map(pre => pre.textContent)).toEqual(["[1, 2]", "3", "0"]);
    }
  } finally { await act(async () => root.unmount()); }
});

test.each(["AC", "WA"] as const)("Demo JS/TS 本地 AC 仍调用服务端并显示其 %s 结果", async verdict => {
  vi.mocked(judgeInBrowser).mockResolvedValue(localResult("AC"));
  const authoritative = { ...localResult(verdict), backend: "node" };
  const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ ok: true, result: authoritative }));
  const { container, root, onResult } = await runJudge("typescript");
  try {
    expect(fetcher).toHaveBeenCalledExactlyOnceWith("/api/judge", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ problemSlug: "two-sum", language: "typescript", code: "exact submitted source" }),
    });
    expect(onResult).toHaveBeenCalledExactlyOnceWith(authoritative);
    expect(container.querySelector('[role="status"]')?.textContent).toBe(`${verdict} · ${verdict === "AC" ? 2 : 1}/4 个用例通过（体验版不保存）`);
  } finally { await act(async () => root.unmount()); }
});

test("Demo Python 环境加载失败保留错误提示且不上报进度", async () => {
  vi.mocked(judgeInBrowser).mockResolvedValue({ ...localResult("RE"), error: "UNAVAILABLE" });
  const fetcher = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("不应发起请求"));
  const { container, root, onResult, run } = await runJudge("python");
  try {
    expect(fetcher).not.toHaveBeenCalled();
    expect(onResult).not.toHaveBeenCalled();
    expect(container.textContent).toContain("运行环境未能加载，请重试。");
    expect(run.disabled).toBe(false);
  } finally { await act(async () => root.unmount()); }
});
