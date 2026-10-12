import assert from "node:assert/strict";
import { test } from "node:test";
import { NextRequest } from "next/server";
import { createFixture, request } from "./api-fixture";

test("progress：拒绝客户端 AC，无提交、解题状态或复习卡副作用；保留正常学习上报", async () => {
  const f = await createFixture({ modelServer: false });
  try {
    const { POST } = await import("../app/api/progress/route");
    await f.prisma.problem.create({
      data: {
        slug: "two-sum",
        title: "两数之和",
        number: 1,
        difficulty: "easy",
        patterns: "[]",
        prereqs: "[]",
        order: 1,
      },
    });
    const beforeUsers = await f.prisma.user.count();
    for (const body of [
      {
        type: "submission",
        problemSlug: "two-sum",
        code: "return [0,1]",
        language: "typescript",
        verdict: "AC",
      },
      {
        type: "submission",
        problemSlug: "two-sum",
        code: "",
        language: "python",
        verdict: "AC",
        verified: true,
      },
      {
        type: "lecture-step",
        problemSlug: "two-sum",
        stepIndex: 1,
        verdict: "AC",
      },
      { type: "hint", problemSlug: "two-sum", level: 1, verdict: "AC" },
      {
        type: "submission",
        problemSlug: "two-sum",
        code: "",
        language: "typescript",
        verdict: ["AC"],
      },
    ]) {
      const response = await POST(request(body));
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error, "BAD_REQUEST");
    }
    assert.equal(await f.prisma.user.count(), beforeUsers);
    assert.equal(await f.prisma.submission.count(), 0);
    assert.equal(await f.prisma.problemProgress.count(), 0);
    assert.equal(await f.prisma.reviewCard.count(), 0);
    assert.equal(await f.prisma.hintUsage.count(), 0);
    const badJSON = await POST(
      new NextRequest("http://localhost/api/progress", {
        method: "POST",
        body: "{",
      }),
    );
    assert.equal(badJSON.status, 400);
    assert.equal((await badJSON.json()).error, "BAD_JSON");
    const longSlug = "a".repeat(201);
    for (const body of [
      { type: "submission", problemSlug: longSlug, code: "", language: "typescript", verdict: "WA" },
      { type: "client-ac", problemSlug: longSlug, code: "", language: "python", verdict: "AC" },
      { type: "hint", problemSlug: longSlug, level: 1 },
      { type: "lecture-step", problemSlug: longSlug, stepIndex: 0 },
    ]) {
      const response = await POST(request(body));
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error, "BAD_REQUEST");
    }
    for (const body of [
      { type: "submission", problemSlug: "non-existent", code: "", language: "typescript", verdict: "WA" },
      { type: "client-ac", problemSlug: "non-existent", code: "", language: "python", verdict: "AC" },
      { type: "hint", problemSlug: "non-existent", level: 1 },
      { type: "lecture-step", problemSlug: "non-existent", stepIndex: 0 },
    ]) {
      const response = await POST(request(body));
      assert.equal(response.status, 404);
      assert.equal((await response.json()).error, "NOT_FOUND");
    }
    assert.equal(await f.prisma.submission.count(), 0);
    assert.equal(await f.prisma.problemProgress.count(), 0);
    assert.equal(await f.prisma.reviewCard.count(), 0);
    assert.equal(await f.prisma.hintUsage.count(), 0);
    for (const verdict of ["WA", "RE", "TLE"])
      assert.equal(
        (
          await POST(
            request({
              type: "submission",
              problemSlug: "two-sum",
              code: "",
              language: "typescript",
              verdict,
            }),
          )
        ).status,
        200,
      );
    assert.equal(
      (
        await POST(
          request({
            type: "lecture-step",
            problemSlug: "two-sum",
            stepIndex: 1,
          }),
        )
      ).status,
      200,
    );
    assert.equal(
      (await POST(request({ type: "hint", problemSlug: "two-sum", level: 2 })))
        .status,
      200,
    );
    const progress = await f.prisma.problemProgress.findFirst();
    assert.equal(progress?.status, "learning");
    assert.equal(progress?.solvedAt, null);
    assert.equal(progress?.attempts, 3);
    assert.equal(progress?.lectureSeen, 1);
    assert.equal(await f.prisma.submission.count(), 3);
    assert.equal(await f.prisma.hintUsage.count(), 1);
    assert.equal(await f.prisma.reviewCard.count(), 1);
  } finally {
    await f.close();
  }
});
