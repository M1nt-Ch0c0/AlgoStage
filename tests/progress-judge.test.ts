import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { createFixture, request } from "./api-fixture";
import { localSeedSource } from "../lib/content/local-source";
import { HOT100 } from "../lib/content/hot100";
import { isSolved } from "../lib/content/pattern-labels";

let f: Awaited<ReturnType<typeof createFixture>>;
let judge: typeof import("../app/api/judge/route").POST;
let progress: typeof import("../app/api/progress/route").POST;
let code: string;
const where = { userId: "local-default", problemSlug: "two-sum" };
const key = { userId_problemSlug: where };
const submit = (source = code, language = "typescript") => judge(request({ problemSlug: "two-sum", language, code: source }));

beforeAll(async () => {
  f = await createFixture({ modelServer: false });
  ({ POST: judge } = await import("../app/api/judge/route"));
  ({ POST: progress } = await import("../app/api/progress/route"));
  code = (await localSeedSource.detail("two-sum")).referenceSolutions!.find(item => item.language === "typescript")!.code;
  for (const problem of [HOT100[0], HOT100[20]]) {
    await f.prisma.problem.create({ data: {
      slug: problem.slug, title: problem.title, number: problem.number, difficulty: problem.difficulty,
      order: problem.order, patterns: JSON.stringify(problem.patterns), prereqs: JSON.stringify(problem.prereqs),
    } });
  }
});
beforeEach(async () => {
  await f.prisma.submission.deleteMany();
  await f.prisma.problemProgress.deleteMany();
  await f.prisma.reviewCard.deleteMany();
});
afterAll(async () => { await f?.close(); });

test("真实服务端 AC 写入 solved/Submission，并同步看板、题目状态和到期复习", async () => {
  const { GET: dashboard } = await import("../app/api/dashboard/route");
  const { GET: problems } = await import("../app/api/problems/route");
  const { GET: review } = await import("../app/api/review/route");
  expect((await (await dashboard()).json()).acCount).toBe(0);
  expect((await (await review()).json()).cards).toEqual([]);
  const response = await submit();
  expect(response.status).toBe(200);
  expect((await response.json()).result).toMatchObject({ backend: "node", verdict: "AC" });
  const solved = await f.prisma.problemProgress.findUniqueOrThrow({ where: key });
  expect(solved).toMatchObject({ status: "solved", attempts: 1 });
  expect(solved.solvedAt).toBeInstanceOf(Date);
  expect(solved.lastStepAt).toBeInstanceOf(Date);
  expect(await f.prisma.submission.findFirst()).toMatchObject({ code, verdict: "AC", language: "typescript" });
  const card = await f.prisma.reviewCard.findFirstOrThrow();
  expect(card).toMatchObject({ interval: 1, reps: 1, lapses: 0 });
  expect((await (await dashboard()).json())).toMatchObject({ acCount: 1, totalSubmissions: 1, reviewDue: 0 });
  expect((await (await review()).json()).cards).toEqual([]);
  const list = (await (await problems()).json()).problems;
  expect(list.filter((item: { status: string }) => isSolved(item.status))).toHaveLength(1);
  await f.prisma.reviewCard.update({ where: { id: card.id }, data: { dueAt: new Date(0) } });
  expect((await (await review()).json()).cards).toMatchObject([{ problemSlug: "two-sum", status: "solved" }]);
  expect((await (await dashboard()).json()).reviewDue).toBe(1);
  expect((await submit()).status).toBe(200);
  expect((await f.prisma.reviewCard.findFirstOrThrow()).interval).toBeGreaterThan(card.interval);
  expect((await f.prisma.problemProgress.findUniqueOrThrow({ where: key })).solvedAt).toEqual(solved.solvedAt);
});

test.each(["solved", "mastered"])("%s 后 WA/RE/TLE 及 lecture-step 不降级，保留首次 solvedAt", async status => {
  expect((await submit()).status).toBe(200);
  const previous = await f.prisma.problemProgress.update({ where: key, data: { status, lastStepAt: new Date(0) } });
  const card = await f.prisma.reviewCard.findFirstOrThrow();
  for (const verdict of ["WA", "RE", "TLE"]) {
    const response = await progress(request({ type: "submission", problemSlug: "two-sum", verdict, language: "typescript", code: "wrong" }));
    expect(response.status).toBe(200);
    expect(await f.prisma.problemProgress.findUniqueOrThrow({ where: key })).toMatchObject({ status, solvedAt: previous.solvedAt });
  }
  expect(await f.prisma.reviewCard.findMany()).toMatchObject([{ id: card.id, interval: 1, lapses: 3, reps: 0 }]);
  const failed = await f.prisma.problemProgress.findUniqueOrThrow({ where: key });
  expect(failed.attempts).toBe(4);
  expect(failed.lastStepAt!.getTime()).toBeGreaterThan(0);
  const schedule = await f.prisma.reviewCard.findMany();
  await f.prisma.problemProgress.update({ where: key, data: { lastStepAt: new Date(0) } });
  expect((await progress(request({ type: "lecture-step", problemSlug: "two-sum", stepIndex: 1 }))).status).toBe(200);
  const taught = await f.prisma.problemProgress.findUniqueOrThrow({ where: key });
  expect(taught).toMatchObject({ status, attempts: 4, lectureSeen: 1, solvedAt: previous.solvedAt });
  expect(taught.lastStepAt!.getTime()).toBeGreaterThan(0);
  expect(await f.prisma.reviewCard.findMany()).toEqual(schedule);
  // 直接调用服务端提交错误代码也不能降低已掌握状态。
  const response = await submit("function twoSum(){return [0,1]}");
  expect((await response.json()).result.verdict).toBe("WA");
  expect(await f.prisma.problemProgress.findUniqueOrThrow({ where: key })).toMatchObject({ status, attempts: 5 });
  expect(await f.prisma.submission.count()).toBe(5);
  const { GET } = await import("../app/api/dashboard/route");
  expect((await (await GET()).json())).toMatchObject({ acCount: 1, totalSubmissions: 5 });
  await submit();
  expect((await f.prisma.problemProgress.findUniqueOrThrow({ where: key })).status).toBe(status);
});

test.each([
  ["function twoSum(){return [0,1]}", "WA"],
  ["function twoSum(){throw new Error('broken')}", "RE"],
  ["while(true){}", "TLE"],
] as const)("服务端非 AC 只记实际结果和复习安排：%s", async (source, verdict) => {
  const response = await submit(source);
  expect(response.status).toBe(200);
  const result = (await response.json()).result;
  expect(result.verdict).toBe(verdict);
  if (verdict === "WA") expect(result.cases).toHaveLength(2); // 首例通过也不能提前记 AC。
  expect(await f.prisma.submission.findFirst()).toMatchObject({ verdict });
  expect(await f.prisma.problemProgress.findUniqueOrThrow({ where: key })).toMatchObject({ status: "learning", attempts: 1, solvedAt: null });
});

test("拒绝伪造判定/用例；Python、无用例和未知题均不产生提交或 AC", async () => {
  for (const extra of [{ verdict: "AC" }, { result: { verdict: "AC" } }, { verified: true }, { problem: { cases: [] } }, { status: "solved" }]) {
    expect((await judge(request({ problemSlug: "two-sum", language: "typescript", code, ...extra }))).status).toBe(400);
  }
  const python = await submit("def twoSum(nums, target): return [0, 1]", "python");
  expect(python.status).toBe(422);
  expect((await python.json()).error).toBe("CLIENT_JUDGED");
  for (const slug of [HOT100[20].slug, "unknown", "__proto__", "toString"]) {
    expect((await judge(request({ problemSlug: slug, language: "javascript", code: "" }))).status).toBe(422);
  }
  expect((await judge(request({ problemSlug: "group-anagrams", language: "javascript", code: "" }))).status).toBe(404);
  expect(await f.prisma.submission.count()).toBe(0);
  expect(await f.prisma.problemProgress.count()).toBe(0);
  expect(await f.prisma.reviewCard.count()).toBe(0);
  await progress(request({ type: "lecture-step", problemSlug: HOT100[20].slug, stepIndex: 0 }));
  expect(await f.prisma.reviewCard.count()).toBe(0);
  const { GET } = await import("../app/api/dashboard/route");
  expect((await (await GET()).json()).acCount).toBe(0);
});

const clientAc = (extra: Record<string, unknown> = {}) => progress(request({
  type: "client-ac", problemSlug: "two-sum", language: "python", code: "def twoSum(n, t): return [0, 1]", verdict: "AC", runtimeMs: 3, ...extra,
}));

test("Python 浏览器 AC 记为 solved，提交带 judgedBy: client；JS/TS 不能走这条路", async () => {
  expect((await clientAc()).status).toBe(200);
  expect(await f.prisma.submission.findFirstOrThrow()).toMatchObject({ verdict: "AC", language: "python", judgedBy: "client" });
  const solved = await f.prisma.problemProgress.findUniqueOrThrow({ where: key });
  expect(solved).toMatchObject({ status: "solved", attempts: 1 });
  expect(solved.solvedAt).toBeInstanceOf(Date);
  expect(await f.prisma.reviewCard.findFirstOrThrow()).toMatchObject({ reps: 1, lapses: 0 });
  // 之后的 Python WA 不会把 solved 降级。
  expect((await progress(request({ type: "submission", problemSlug: "two-sum", language: "python", code: "x", verdict: "WA" }))).status).toBe(200);
  expect(await f.prisma.problemProgress.findUniqueOrThrow({ where: key })).toMatchObject({ status: "solved", attempts: 2 });
  for (const language of ["typescript", "javascript"]) expect((await clientAc({ language })).status).toBe(400);
  for (const extra of [{ verdict: "WA" }, { judgedBy: "server" }, { type: "submission" }]) expect((await clientAc(extra)).status).toBe(400);
  expect(await f.prisma.submission.count()).toBe(2);
});

test("服务端判出的提交带 judgedBy: server", async () => {
  expect((await submit()).status).toBe(200);
  expect(await f.prisma.submission.findFirstOrThrow()).toMatchObject({ verdict: "AC", judgedBy: "server" });
});

test("浏览器上报的 WA/RE/TLE 记为 judgedBy: client", async () => {
  for (const verdict of ["WA", "RE", "TLE"]) {
    expect((await progress(request({ type: "submission", problemSlug: "two-sum", language: "typescript", code: "x", verdict }))).status).toBe(200);
  }
  const rows = await f.prisma.submission.findMany();
  expect(rows).toHaveLength(3);
  expect(rows.every(row => row.judgedBy === "client")).toBe(true);
});
