// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { createFixture, request } from "./api-fixture";
import { localSeedSource } from "../lib/content/local-source";
import { HOT100 } from "../lib/content/hot100";
import * as judgeServer from "../lib/judge/server";
import type { JudgeResult } from "../lib/judge/types";
import JudgeControls from "../components/judge/judge-controls";
import * as browserJudge from "../lib/judge/browser";
import { pythonWorkerPool } from "../lib/judge/python-pool";

let f: Awaited<ReturnType<typeof createFixture>>;
let code: string;
const payload = () => ({ problemSlug: "two-sum", language: "typescript", code });

beforeAll(async () => {
  f = await createFixture({ modelServer: false });
  code = (await localSeedSource.detail("two-sum")).referenceSolutions!.find(item => item.language === "typescript")!.code;
  const problem = HOT100[0];
  await f.prisma.problem.create({
    data: {
      slug: problem.slug, title: problem.title, number: problem.number, difficulty: problem.difficulty,
      order: problem.order, patterns: JSON.stringify(problem.patterns), prereqs: JSON.stringify(problem.prereqs),
    },
  });
});

beforeEach(async () => {
  delete process.env.JUDGE_MAX_CONCURRENCY;
  for (let i = 0; i < 64; i++) judgeServer.release();
  await f.prisma.submission.deleteMany();
  await f.prisma.problemProgress.deleteMany();
  await f.prisma.reviewCard.deleteMany();
});

afterEach(() => {
  delete process.env.JUDGE_MAX_CONCURRENCY;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (let i = 0; i < 64; i++) judgeServer.release();
});

afterAll(async () => {
  await f?.close();
});

const acResult = (): JudgeResult => ({
  backend: "node",
  verdict: "AC",
  runtimeMs: 2,
  cases: [{ caseId: 0, verdict: "AC", runtimeMs: 2, input: "[]", expected: "[]", actual: "[]" }],
});

test("环境变量非法、0、负数或未设置时回退为 4，正整数生效", () => {
  for (const invalid of [undefined, "", " ", "0", "-1", "-4", "abc", "3.5", "4a", "NaN", "Infinity", "00"]) {
    if (invalid === undefined) delete process.env.JUDGE_MAX_CONCURRENCY;
    else process.env.JUDGE_MAX_CONCURRENCY = invalid;
    for (let i = 0; i < 4; i++) expect(judgeServer.tryAcquire()).toBe(true);
    expect(judgeServer.tryAcquire()).toBe(false);
    for (let i = 0; i < 4; i++) judgeServer.release();
  }

  process.env.JUDGE_MAX_CONCURRENCY = "2";
  expect(judgeServer.tryAcquire()).toBe(true);
  expect(judgeServer.tryAcquire()).toBe(true);
  expect(judgeServer.tryAcquire()).toBe(false);
  judgeServer.release();
  expect(judgeServer.tryAcquire()).toBe(true);
  judgeServer.release();
  judgeServer.release();

  for (const capped of ["64", "65", "100", "999"]) {
    process.env.JUDGE_MAX_CONCURRENCY = capped;
    expect(judgeServer.maxJudgeConcurrency()).toBe(64);
    for (let i = 0; i < 64; i++) expect(judgeServer.tryAcquire()).toBe(true);
    expect(judgeServer.tryAcquire()).toBe(false);
    for (let i = 0; i < 64; i++) judgeServer.release();
  }
});

test("同时 5 个请求第 5 个立即返回 429 BUSY，前面跑完后新请求正常判题", async () => {
  vi.resetModules();

  const serverMod = await import("../lib/judge/server");
  const resolvers: (() => void)[] = [];
  vi.spyOn(serverMod, "judgeOnServer").mockImplementation(() => new Promise<JudgeResult>(resolve => {
    resolvers.push(() => resolve(acResult()));
  }));

  const { POST } = await import("../app/api/judge/route");

  const firstFour = [
    POST(request(payload())),
    POST(request(payload())),
    POST(request(payload())),
    POST(request(payload())),
  ];

  await vi.waitFor(() => expect(resolvers).toHaveLength(4));

  const fifthRes = await POST(request(payload()));
  expect(fifthRes.status).toBe(429);
  expect(await fifthRes.json()).toEqual({ error: "BUSY", message: "判题繁忙，结果未保存，请稍后再试" });

  for (const releaseOne of resolvers.splice(0)) releaseOne();
  const responses = await Promise.all(firstFour);
  for (const res of responses) {
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, result: { verdict: "AC" } });
  }

  vi.mocked(serverMod.judgeOnServer).mockResolvedValueOnce(acResult());
  const nextRes = await POST(request(payload()));
  expect(nextRes.status).toBe(200);
  expect(await nextRes.json()).toMatchObject({ ok: true, result: { verdict: "AC" } });
});

test("判题抛异常后槽位在 finally 中释放，后续请求可正常判题", async () => {
  process.env.JUDGE_MAX_CONCURRENCY = "1";
  vi.resetModules();
  const serverMod = await import("../lib/judge/server");
  const spy = vi.spyOn(serverMod, "judgeOnServer").mockRejectedValueOnce(new Error("boom"));
  const { POST } = await import("../app/api/judge/route");

  await expect(POST(request(payload()))).rejects.toThrow("boom");

  spy.mockResolvedValueOnce(acResult());
  const nextRes = await POST(request(payload()));
  expect(nextRes.status).toBe(200);
  expect(await nextRes.json()).toMatchObject({ ok: true, result: { verdict: "AC" } });
});

test("UI 收到 429 时显示「判题繁忙，结果未保存，请稍后再试」，运行按钮可用，编辑器代码保留", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(pythonWorkerPool, "preload").mockImplementation(() => {});
  vi.spyOn(browserJudge, "judgeInBrowser").mockResolvedValue({
    backend: "browser", verdict: "AC", runtimeMs: 1,
    cases: [{ caseId: 0, verdict: "AC", runtimeMs: 1, input: "[]", expected: "[]", actual: "[]" }],
  });
  vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ error: "BUSY" }, { status: 429 }));

  const detail = await localSeedSource.detail("two-sum");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  function Harness() {
    const [source, setSource] = useState("const userDraft = 42;");
    return createElement("div", {},
      createElement("textarea", { "data-editor": true, value: source, onChange: (e: { currentTarget: HTMLTextAreaElement }) => setSource(e.currentTarget.value) }),
      createElement(JudgeControls, { detail, code: source, language: "typescript", onLanguage: () => setSource("") }),
    );
  }

  try {
    await act(async () => root.render(createElement(Harness)));
    const getButton = () => Array.from(container.querySelectorAll("button")).find(b => b.textContent === "运行" || b.textContent === "判题中…")!;
    await act(async () => getButton().click());
    expect(container.textContent).toContain("判题繁忙，结果未保存，请稍后再试");
    expect(getButton().disabled).toBe(false);
    expect(getButton().textContent).toBe("运行");
    expect(container.querySelector<HTMLTextAreaElement>("[data-editor]")!.value).toBe("const userDraft = 42;");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("deploy/README.md 注明 JUDGE_MAX_CONCURRENCY 为单进程并发上限", () => {
  const readme = readFileSync(resolve(__dirname, "../deploy/README.md"), "utf8");
  expect(readme).toContain("JUDGE_MAX_CONCURRENCY");
  expect(readme).toContain("单个进程");
});


