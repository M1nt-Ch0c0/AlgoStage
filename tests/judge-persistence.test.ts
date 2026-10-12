// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import JudgeControls from "../components/judge/judge-controls";
import ReviewPage from "../app/review/page";
import { judgeInBrowser } from "../lib/judge/browser";
import { pythonWorkerPool } from "../lib/judge/python-pool";
import { localSeedSource } from "../lib/content/local-source";
import type { JudgeResult } from "../lib/judge/types";

vi.mock("../lib/judge/browser", () => ({ judgeInBrowser: vi.fn() }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.innerHTML = ""; });

const localResult = (verdict: JudgeResult["verdict"]): JudgeResult => ({
  backend: "browser", verdict, runtimeMs: 1.4,
  cases: [{ caseId: 0, verdict, runtimeMs: 1.4, input: "[]", expected: "[]", actual: "[]" }],
});

test.each(["AC", "WA", "python", "save-error"])("判题控件持久化并使用服务端结果：%s", async scenario => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(pythonWorkerPool, "preload").mockImplementation(() => {});
  vi.mocked(judgeInBrowser).mockResolvedValue(localResult(scenario === "WA" ? "WA" : "AC"));
  const authoritative = { ...localResult(scenario === "AC" ? "WA" : "AC"), backend: "node" };
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async () => scenario === "python"
    ? Response.json({ message: "服务端无法判定 Python，未记录 AC。" }, { status: 503 })
    : scenario === "save-error"
      ? Response.json({ message: "保存失败，请重试。" }, { status: 500 })
      : Response.json({ ok: true, result: authoritative }));
  const detail = await localSeedSource.detail("two-sum"), onResult = vi.fn();
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(JudgeControls, {
      detail, code: "exact submitted source", language: scenario === "python" ? "python" : "typescript",
      onLanguage: vi.fn(), onResult,
    })));
    await act(async () => Array.from(container.querySelectorAll("button")).find(button => button.textContent === "运行")!.click());
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, options] = fetcher.mock.calls[0];
    const body = JSON.parse(String(options?.body));
    expect(body).toMatchObject({ problemSlug: "two-sum", code: "exact submitted source" });
    if (scenario === "WA") {
      expect(url).toBe("/api/progress");
      expect(body).toMatchObject({ type: "submission", verdict: "WA", runtimeMs: 1 });
      expect(onResult).toHaveBeenCalledWith(localResult("WA"));
    } else {
      expect(url).toBe("/api/judge");
      expect(body).not.toHaveProperty("verdict");
      if (scenario === "AC") {
        expect(onResult).toHaveBeenCalledWith(authoritative);
        expect(container.textContent).toContain("WA · 0/4 个用例通过 · 已保存");
      } else {
        expect(onResult).not.toHaveBeenCalled();
        expect(container.textContent).toContain(scenario === "python" ? "服务端无法判定" : "保存失败");
        expect(container.textContent).not.toContain("已保存");
      }
    }
  } finally { await act(async () => root.unmount()); }
});

test("复习页按持久化状态识别 solved/mastered，直接链接到判题页", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ cards: [
    { id: "1", problemSlug: "two-sum", title: "两数之和", status: "solved" },
    { id: "2", problemSlug: "3sum", title: "三数之和", status: "mastered" },
    { id: "3", problemSlug: "move-zeroes", title: "移动零", status: "learning" },
  ] }));
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(ReviewPage)));
    expect(container.textContent?.match(/已攻克/g)).toHaveLength(2);
    expect(container.textContent).toContain("学习中 · 再练一次");
    expect(container.querySelector('a[href="/judge/two-sum"]')).not.toBeNull();
  } finally { await act(async () => root.unmount()); }
});
