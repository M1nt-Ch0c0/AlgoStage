import assert from "node:assert/strict";
import { test } from "node:test";
import { createFixture, request } from "./api-fixture";
import { teachingScriptSchema } from "../lib/teaching/schema";
import { validateScript } from "../lib/teaching/validated-script";
import { localSeedSource } from "../lib/content/local-source";

function script(
  language: "zh" | "en" = "zh",
  solutionLanguage: "typescript" | "python" = "typescript",
) {
  return {
    problemSlug: "3sum",
    mode: "lecture",
    language,
    solutionLanguage,
    steps: [
      {
        id: "step-1",
        narration: "先排序，再用双指针查找。",
        targets: [
          { kind: "code-line", start: 999, end: 2 },
          { kind: "code-token", line: 999, match: "nums" },
        ],
        effects: [
          { effect: "spotlight-beam", targetIndex: 0 },
          { effect: "laser-pointer", targetIndex: 8 },
        ],
      },
    ],
  };
}

test("S2/S4：单调用重试、422 不缓存及语言缓存隔离", async () => {
  const f = await createFixture();
  try {
    const { POST } = await import("../app/api/lecture/route");
    await f.save({
      apiKey: "saved-test-key",
      model: "test-model",
      provider: "openai-compatible",
      baseURL: f.baseURL,
    });
    const invalid = {
      ...script(),
      steps: [
        {
          id: "bad",
          narration: "坏脚本",
          targets: [{ type: "code-line", line: 3 }],
        },
      ],
    };
    f.setReply(() => invalid);
    const failed = await POST(request({ slug: "3sum" }));
    assert.equal(failed.status, 422);
    assert.equal((await failed.json()).error, "INVALID_SCRIPT");
    assert.equal(f.calls.length, 3);
    assert.equal(await f.prisma.lectureScriptCache.count(), 0);

    let attempt = 0;
    f.setReply(() =>
      ++attempt === 1
        ? invalid
        : {
            ...script(),
            steps: [
              {
                id: "s1",
                narration: "先排序",
                targets: [{ kind: "code-line", start: 1 }],
                effects: [],
              },
            ],
          },
    );
    const ok = await POST(request({ slug: "3sum" }));
    assert.equal(ok.status, 200);
    assert.equal(attempt, 3);
    const result = await ok.json();
    assert.equal(result.cached, false);
    assert.ok(teachingScriptSchema.safeParse(result.script).success);
    assert.equal(result.script.steps[0].targets[0].start, 1);
    assert.ok(
      result.script.steps[0].targets[0].end === undefined ||
        result.script.steps[0].targets[0].end === 1,
    );

    assert.equal(result.script.steps[0].effects[0].effect, "spotlight-beam");
    assert.equal(
      (await (await POST(request({ slug: "3sum" }))).json()).cached,
      true,
    );
    assert.equal(f.calls.length, 6);

    for (const [language, solutionLanguage] of [
      ["en", "typescript"],
      ["zh", "python"],
      ["en", "python"],
    ] as const) {
      f.setReply(() => ({
        ...script(language, solutionLanguage),
        steps: [
          {
            id: "s1",
            narration: "按参考代码讲解",
            targets: [{ kind: "code-line", start: 1 }],
            effects: [],
          },
        ],
      }));
      const response = await POST(
        request({ slug: "3sum", language, solutionLanguage }),
      );
      const data = await response.json();
      assert.equal(response.status, 200);
      assert.equal(data.cached, false);
      assert.equal(data.script.language, language);
      assert.equal(data.script.solutionLanguage, solutionLanguage);
    }
    assert.equal(await f.prisma.lectureScriptCache.count(), 4);

    const cached = (await f.prisma.lectureScriptCache.findMany())[0];
    await f.prisma.lectureScriptCache.update({
      where: { key: cached.key },
      data: { script: JSON.stringify(invalid) },
    });
    const metadata = JSON.parse(cached.script);
    f.setReply(() => ({
      ...script(metadata.language, metadata.solutionLanguage),
      steps: [
        {
          id: "s1",
          narration: "按参考代码讲解",
          targets: [{ kind: "code-line", start: 1 }],
          effects: [],
        },
      ],
    }));
    const regenerated = await POST(
      request({
        slug: "3sum",
        language: metadata.language,
        solutionLanguage: metadata.solutionLanguage,
      }),
    );
    assert.equal((await regenerated.json()).cached, false);
    assert.equal(await f.prisma.lectureScriptCache.count(), 4);
  } finally {
    await f.close();
  }
});

test("S2：空参考代码不会产生代码锚点，非法结构会在播放器加载前被拒绝", () => {
  const result = validateScript(script(), "");
  assert.ok(
    result.steps[0].targets.every((target) => target.kind === "statement"),
  );
  assert.throws(() => validateScript({ steps: [] }, "a\nb"));
});

test("S2：五道不同题的两种参考代码都能拦截越界行号", async () => {
  for (const slug of [
    "group-anagrams",
    "3sum",
    "word-search",
    "median-of-two-sorted-arrays",
    "binary-tree-maximum-path-sum",
  ]) {
    const detail = await localSeedSource.detail(slug);
    for (const reference of detail.referenceSolutions!) {
      const result = validateScript(
        { ...script("zh", reference.language), problemSlug: slug },
        reference.code,
      );
      const lines = reference.code.split("\n").length;
      for (const target of result.steps[0].targets) {
        if (target.kind === "code-line")
          assert.ok(
            target.start >= 1 &&
              target.start <= lines &&
              target.end! >= target.start &&
              target.end! <= lines,
          );
        if (target.kind === "code-token")
          assert.ok(target.line >= 1 && target.line <= lines);
      }
    }
  }
});
