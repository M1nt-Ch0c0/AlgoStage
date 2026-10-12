import { expect, test } from "vitest";
import { localSeedSource } from "../lib/content/local-source";
import { HOT100 } from "../lib/content/hot100";
import { createFixture, request } from "./api-fixture";

test("local content lists 100 unique problems and rejects unknown slugs", async () => {
  const problems = await localSeedSource.list();
  expect(new Set(problems.map(problem => problem.slug)).size).toBe(100);
  expect((await localSeedSource.detail("two-sum")).judging?.cases.length).toBeGreaterThanOrEqual(3);
  expect((await localSeedSource.detail(problems[30].slug)).referenceSolutions).toHaveLength(2);
  await expect(localSeedSource.detail("missing-problem")).rejects.toThrow("Unknown problem");
});

test("进度接受未通过结果并安排复习，拒绝客户端 AC 且不改变复习卡", async () => {
  const fixture = await createFixture({ modelServer: false });
  try {
    const { POST } = await import("../app/api/progress/route");
    for (const problem of HOT100.slice(0, 3)) {
      await fixture.prisma.problem.create({ data: {
        slug: problem.slug, title: problem.title, number: problem.number, difficulty: problem.difficulty,
        order: problem.order, patterns: JSON.stringify(problem.patterns), prereqs: JSON.stringify(problem.prereqs),
      } });
    }
    const submit = (problemSlug: string, verdict: "AC" | "WA" | "RE" | "TLE") => POST(request({
      type: "submission", problemSlug, verdict, code: "test submission", language: "typescript", runtimeMs: 7,
    }));
    for (const verdict of ["WA", "RE", "TLE"] as const) expect((await submit("two-sum", verdict)).status).toBe(200);
    const card = await fixture.prisma.reviewCard.findFirstOrThrow();
    expect(card).toMatchObject({ interval: 1, lapses: 3, reps: 0 });
    expect((await submit("two-sum", "AC")).status).toBe(400);
    expect((await submit(HOT100[1].slug, "AC")).status).toBe(400);
    expect(await fixture.prisma.reviewCard.findMany()).toEqual([card]);
    expect(await fixture.prisma.submission.count()).toBe(3);
    const progress = await fixture.prisma.problemProgress.findUniqueOrThrow({
      where: { userId_problemSlug: { userId: "local-default", problemSlug: "two-sum" } },
    });
    expect(progress).toMatchObject({ status: "learning", attempts: 3 });
    expect(progress.solvedAt).toBeNull();
    expect((await POST(request({ type: "hint", problemSlug: "two-sum", level: 2 }))).status).toBe(200);
    expect(await fixture.prisma.hintUsage.count()).toBe(1);
    for (let stepIndex = 0; stepIndex < 2; stepIndex++) {
      expect((await POST(request({ type: "lecture-step", problemSlug: HOT100[2].slug, stepIndex }))).status).toBe(200);
    }
    expect(await fixture.prisma.problemProgress.findUniqueOrThrow({
      where: { userId_problemSlug: { userId: "local-default", problemSlug: HOT100[2].slug } },
    })).toMatchObject({ lectureSeen: 2, status: "learning", attempts: 0 });
    expect((await POST(request({ type: "unknown" }))).status).toBe(400);
  } finally { await fixture.close(); }
});
