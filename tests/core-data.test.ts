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

test("progress stores real verdicts and only AC creates a review card due tomorrow", async () => {
  const fixture = await createFixture();
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
    expect(await fixture.prisma.reviewCard.count()).toBe(0);
    const before = Date.now();
    expect((await submit("two-sum", "AC")).status).toBe(200);
    expect((await submit(HOT100[1].slug, "AC")).status).toBe(200);
    const cards = await fixture.prisma.reviewCard.findMany();
    expect(cards).toHaveLength(2);
    for (const card of cards) {
      expect(card.dueAt.getTime()).toBeGreaterThanOrEqual(before + 86_400_000);
      expect(card.dueAt.getTime()).toBeLessThanOrEqual(Date.now() + 86_400_000);
      expect(card).toMatchObject({ userId: "local-default", ease: 2.5, lapses: 0, reps: 0 });
    }
    const progress = await fixture.prisma.problemProgress.findUniqueOrThrow({
      where: { userId_problemSlug: { userId: "local-default", problemSlug: "two-sum" } },
    });
    expect(progress).toMatchObject({ status: "solved", attempts: 4 });
    expect(progress.solvedAt).toBeInstanceOf(Date);
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
