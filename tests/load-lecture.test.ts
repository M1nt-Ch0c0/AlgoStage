import assert from "node:assert/strict";
import { test } from "node:test";
import { loadLectureForPlayback } from "../lib/player/load-lecture";
import { localSeedSource } from "../lib/content/local-source";
import { TWO_SUM_SCRIPT } from "../lib/content/scripts/two-sum";
import { usePlayerStore } from "../lib/player/store";
import type { TeachingScript } from "../lib/teaching/types";
import { teachingScriptSchema } from "../lib/teaching/schema";

test("S3 review：练习删短代码后重开 two-sum，先恢复全文再加载和播放", async () => {
  const detail = await localSeedSource.detail("two-sum");
  const referenceCode = detail.referenceSolutions!.find(s => s.language === "typescript")!.code;
  const actions: string[] = [];
  let editorCode = referenceCode;
  const controls = {
    setCode(code: string) { editorCode = code; actions.push("code"); },
    loadScript(script: TeachingScript) {
      actions.push("script");
      const lines = editorCode.split("\n").length;
      for (const step of script.steps) for (const target of step.targets) {
        if (target.kind === "code-line") assert.ok(target.start <= lines && (target.end ?? target.start) <= lines);
        if (target.kind === "code-token") assert.ok(target.line <= lines);
      }
      usePlayerStore.getState().loadScript(script);
    },
    play() { actions.push("play"); usePlayerStore.getState().play(); },
  };
  try {
    for (const practiceCode of ["return [];", "", "// 学生自己的解法\nreturn [0,1];"]) {
      editorCode = practiceCode;
      actions.length = 0;
      loadLectureForPlayback(TWO_SUM_SCRIPT, detail, controls);
      assert.equal(editorCode, referenceCode);
      assert.deepEqual(actions, ["code", "script", "play"]);
      assert.equal(usePlayerStore.getState().status, "playing");
      assert.ok(teachingScriptSchema.safeParse(usePlayerStore.getState().script).success);
    }
  } finally { usePlayerStore.getState().reset(); }
});

test("S3 review：AI 教案恢复对应语言代码；错误教案或缺少参考代码时不加载", async () => {
  const detail = await localSeedSource.detail("two-sum");
  const changes: unknown[] = [];
  const controls = {
    setCode(code: string) { changes.push(code); },
    loadScript(script: TeachingScript) { changes.push(script); },
    play() { changes.push("play"); },
  };
  loadLectureForPlayback({ ...TWO_SUM_SCRIPT, solutionLanguage: "python" }, detail, controls);
  assert.equal(changes[0], detail.referenceSolutions!.find(s => s.language === "python")!.code);
  assert.ok(teachingScriptSchema.safeParse(changes[1]).success);
  changes.length = 0;
  assert.throws(() => loadLectureForPlayback({ ...TWO_SUM_SCRIPT, problemSlug: "3sum" }, detail, controls));
  assert.throws(() => loadLectureForPlayback(TWO_SUM_SCRIPT, { ...detail, referenceSolutions: [] }, controls));
  assert.throws(() => loadLectureForPlayback({ ...TWO_SUM_SCRIPT, steps: [] }, detail, controls));
  assert.deepEqual(changes, []);
});
