import { expect, test } from "vitest";
import { cancelLectureForPlayback } from "../lib/player/load-lecture";
import { usePlayerStore } from "../lib/player/store";
import { TWO_SUM_SCRIPT } from "../lib/content/scripts/two-sum";
import { localSeedSource } from "../lib/content/local-source";

test.each(["cancel", "language", "practice"] as const)("%s 入口：终止备课，清空步骤与锚点并恢复对应语言参考代码", async entry => {
  const detail = await localSeedSource.detail("two-sum");
  const store = usePlayerStore.getState();
  store.beginStream(TWO_SUM_SCRIPT);
  store.appendStep(TWO_SUM_SCRIPT.steps[0]);
  store.appendStep(TWO_SUM_SCRIPT.steps[1]);
  const request = new AbortController();
  const language = entry === "language" ? "python" : "typescript";
  let code = "// 已编辑的残缺代码";
  cancelLectureForPlayback(detail, language, {
    abort: () => request.abort(), reset: store.reset, setCode: value => { code = value; },
  });
  expect(request.signal.aborted).toBe(true);
  expect(usePlayerStore.getState()).toMatchObject({ steps: [], script: null, status: "idle", receiving: false, currentIndex: 0 });
  expect(code).toBe(detail.referenceSolutions!.find(s => s.language === language)!.code);
  // 取消后可立即开始另一堂课，没有上一堂课的步骤。
  store.beginStream(TWO_SUM_SCRIPT);
  store.appendStep(TWO_SUM_SCRIPT.steps[0]);
  expect(usePlayerStore.getState().steps).toHaveLength(1);
  store.reset();
});
