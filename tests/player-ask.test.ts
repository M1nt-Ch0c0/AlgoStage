import { afterEach, describe, expect, test } from "vitest";
import { countAnswers } from "../lib/ask/answers";
import type { AnswerSegment, AskSelectionSummary, StepAnswer } from "../lib/ask/types";
import {
  selectAskAvailability,
  selectAskPresentation,
  usePlayerStore,
  type AskRequestGuard,
  type LectureAnswerMeta,
} from "../lib/player/store";
import type { TeachingScript, TeachingStep } from "../lib/teaching/types";

const step1: TeachingStep = { id: "s1", narration: "第一步", targets: [], effects: [] };
const step2: TeachingStep = { id: "s2", narration: "第二步", targets: [], effects: [] };
const step3: TeachingStep = { id: "s3", narration: "第三步", targets: [], effects: [] };

const script: TeachingScript = {
  problemSlug: "3sum",
  mode: "lecture",
  language: "zh",
  solutionLanguage: "typescript",
  steps: [step1, step2, step3],
};

const readyMeta: LectureAnswerMeta = {
  cacheKey: "ck-1",
  scriptVersion: "v1",
  askDisabledStepIds: [],
  storageMode: "server",
};

const selection: AskSelectionSummary = {
  mode: "single",
  bbox: { x: 0, y: 0, width: 10, height: 10 },
  targets: [{ kind: "subtitle", id: "sub-1", text: "第一步" }],
};

const s = () => usePlayerStore.getState();

afterEach(() => {
  s().reset();
});

function loadReady(meta: LectureAnswerMeta = readyMeta) {
  s().loadScript(script);
  s().setLectureAnswerMeta(meta);
  s().setAnswers(Object.create(null));
  usePlayerStore.setState({ answersReady: true });
}

function guard(overrides: Partial<AskRequestGuard> = {}): AskRequestGuard {
  return {
    generation: s().generation,
    problemSlug: script.problemSlug,
    cacheKey: s().answerMeta.cacheKey,
    scriptVersion: s().answerMeta.scriptVersion,
    stepId: s().steps[s().currentIndex]?.id ?? "s1",
    token: s().askContext?.token ?? 1,
    ...overrides,
  };
}

function segment(id: string, narration = id): AnswerSegment {
  return { id, narration };
}

function answerOf(partial: Partial<StepAnswer> & Pick<StepAnswer, "id" | "stepId">): StepAnswer {
  return {
    v: 1,
    question: "为什么",
    selection,
    segments: [segment("seg-a"), segment("seg-b"), segment("seg-c")],
    createdAt: "2026-10-13T00:00:00.000Z",
    ...partial,
  };
}

function enterDrafting(question = "为什么这样移动指针") {
  s().enterAsk();
  s().setAskSelection(selection);
  s().setAskQuestion(question);
}

describe("进入 / 退出 / 草稿", () => {
  test("playing 进入圈选：interrupted/selecting，记下 prev，步号不变", () => {
    loadReady();
    s().play();
    expect(s()).toMatchObject({ status: "playing", awaitingContinue: false, currentIndex: 0 });
    s().enterAsk();
    expect(s()).toMatchObject({
      status: "interrupted",
      awaitingContinue: false,
      askPhase: "selecting",
      currentIndex: 0,
    });
    expect(s().askContext).toMatchObject({
      stepId: "s1",
      stepIndex: 0,
      prevStatus: "playing",
      prevAwaitingContinue: false,
      answerId: null,
      segmentIndex: -1,
    });
  });

  test("paused 与 finished、awaitingContinue 进入后再退出完整恢复", () => {
    loadReady();
    s().pause();
    usePlayerStore.setState({ awaitingContinue: true });
    s().enterAsk();
    expect(s().askContext).toMatchObject({ prevStatus: "paused", prevAwaitingContinue: true });
    s().exitAsk();
    expect(s()).toMatchObject({ status: "paused", awaitingContinue: true, askPhase: "idle", askContext: null });

    usePlayerStore.setState({ status: "finished", currentIndex: 2, awaitingContinue: true });
    s().enterAsk();
    expect(s()).toMatchObject({ askPhase: "selecting", currentIndex: 2, status: "interrupted" });
    expect(s().askContext).toMatchObject({ prevStatus: "finished", prevAwaitingContinue: true, stepId: "s3" });
    s().exitAsk();
    expect(s()).toMatchObject({ status: "finished", awaitingContinue: true, currentIndex: 2, askPhase: "idle" });
  });

  test("playing 取消不重置原步位置", () => {
    loadReady();
    s().play();
    s().goto(1);
    s().enterAsk();
    s().exitAsk();
    expect(s()).toMatchObject({ status: "playing", currentIndex: 1, askPhase: "idle" });
  });

  test("空 targets 留在 selecting；有效选择进入 drafting", () => {
    loadReady();
    s().enterAsk();
    s().setAskSelection({ ...selection, targets: [] });
    expect(s().askPhase).toBe("selecting");
    expect(s().selection).toBeNull();
    s().setAskSelection(selection);
    expect(s()).toMatchObject({ askPhase: "drafting", draftStepId: "s1" });
    expect(s().selection?.targets).toHaveLength(1);
  });

  test("drafting 取消退出保留选区和草稿，同一步重进直接 drafting 并更新 prev", () => {
    loadReady();
    s().play();
    enterDrafting("  保留的问题  ");
    s().exitAsk();
    expect(s()).toMatchObject({
      askPhase: "idle",
      status: "playing",
      draftQuestion: "  保留的问题  ",
      draftStepId: "s1",
    });
    expect(s().selection?.targets).toHaveLength(1);
    s().pause();
    usePlayerStore.setState({ awaitingContinue: true });
    s().enterAsk();
    expect(s()).toMatchObject({ askPhase: "drafting", status: "interrupted" });
    expect(s().askContext).toMatchObject({ prevStatus: "paused", prevAwaitingContinue: true });
    expect(s().draftQuestion).toBe("  保留的问题  ");
  });

  test("closeAskPanel 从 drafting 回到 selecting 并保留草稿；exitAsk 回 idle", () => {
    loadReady();
    s().pause();
    enterDrafting("还在");
    expect(s().closeAskPanel()).toBeNull();
    expect(s()).toMatchObject({
      askPhase: "selecting",
      draftQuestion: "还在",
      draftStepId: "s1",
      status: "interrupted",
    });
    expect(s().selection).not.toBeNull();
    s().exitAsk();
    expect(s()).toMatchObject({ askPhase: "idle", status: "paused", draftQuestion: "还在" });
  });

  test("closeAskPanel 从 error 回到 selecting，清错误码，保留草稿和选区", () => {
    loadReady();
    s().pause();
    enterDrafting("失败也留着");
    s().askSent(guard({ token: 4 }));
    s().answerFailed("TIMEOUT", true, guard({ token: 4 }));
    expect(s().askPhase).toBe("error");
    expect(s().closeAskPanel()).toBeNull();
    expect(s()).toMatchObject({
      askPhase: "selecting",
      draftQuestion: "失败也留着",
      askErrorCode: null,
      askErrorRetryable: false,
      status: "interrupted",
    });
    expect(s().selection).not.toBeNull();
  });

  test("closeAskPanel 从 sending/streaming 摘掉 token 回 selecting，不改 answers", () => {
    loadReady();
    s().pause();
    const prior = answerOf({ id: "kept", stepId: "s1" });
    s().setAnswers({ s1: [prior] });
    usePlayerStore.setState({ answersReady: true });

    enterDrafting("还在发送");
    s().askSent(guard({ token: 9 }));
    expect(s().askPhase).toBe("sending");
    expect(s().closeAskPanel()).toBe(9);
    expect(s()).toMatchObject({
      askPhase: "selecting",
      draftQuestion: "还在发送",
      status: "interrupted",
      previewSegments: [],
      askStartedAt: null,
    });
    expect(s().askContext).toMatchObject({ token: null, answerId: null, stepId: "s1", prevStatus: "paused" });
    expect(s().selection).not.toBeNull();
    expect(countAnswers(s().answers)).toBe(1);
    // 请求还在飞：关面板后入口仍是 busy。
    expect(selectAskAvailability(s())).toEqual({ visible: true, disabled: true, reason: "busy" });
    s().answerArrived(answerOf({ id: "bg-9", stepId: "s1" }), guard({ token: 9, stepId: "s1" }));
    expect(s().askInFlight).toBe(false);

    s().setAskQuestion("还在流式");
    usePlayerStore.setState({ askPhase: "drafting" });
    s().askSent(guard({ token: 10 }));
    s().askStarted("ans-live", guard({ token: 10 }));
    s().answerSegmentArrived(segment("live"), guard({ token: 10 }));
    expect(s().previewSegments).toHaveLength(1);
    expect(s().closeAskPanel()).toBe(10);
    expect(s().askPhase).toBe("selecting");
    expect(s().askContext).toMatchObject({ token: null, answerId: null });
    expect(s().previewSegments).toEqual([]);
    expect(selectAskAvailability(s())).toEqual({ visible: true, disabled: true, reason: "busy" });
  });

  test("exitAsk 从 selecting/drafting/error/sending/streaming 回 idle 且不 abort 语义", () => {
    loadReady();
    s().pause();

    s().enterAsk();
    s().exitAsk();
    expect(s()).toMatchObject({ askPhase: "idle", status: "paused", askContext: null });

    enterDrafting("草稿退出");
    s().exitAsk();
    expect(s()).toMatchObject({ askPhase: "idle", status: "paused", draftQuestion: "草稿退出" });

    enterDrafting("错误退出");
    s().askSent(guard({ token: 3 }));
    s().answerFailed("TIMEOUT", true, guard({ token: 3 }));
    s().exitAsk();
    expect(s()).toMatchObject({ askPhase: "idle", askErrorCode: null, draftQuestion: "错误退出" });

    enterDrafting("发送中退出");
    s().askSent(guard({ token: 5 }));
    const startedAt = s().askStartedAt;
    expect(startedAt).not.toBeNull();
    s().exitAsk();
    expect(s()).toMatchObject({
      askPhase: "idle",
      status: "paused",
      askContext: null,
      askStartedAt: null,
      previewSegments: [],
      draftQuestion: "发送中退出",
    });
    expect(s().selection).not.toBeNull();

    enterDrafting("流式中退出");
    s().askSent(guard({ token: 6 }));
    s().askStarted("ans-bg", guard({ token: 6 }));
    s().answerSegmentArrived(segment("p"), guard({ token: 6 }));
    s().exitAsk();
    expect(s()).toMatchObject({ askPhase: "idle", askContext: null, previewSegments: [] });
  });

  test("关面板或退出后到达的回答落入 answers，不改 phase", () => {
    loadReady();
    s().pause();
    enterDrafting("后台完成");
    s().askSent(guard({ token: 8 }));
    s().askStarted("bg-close", guard({ token: 8 }));
    s().closeAskPanel();
    expect(s().askPhase).toBe("selecting");
    const closed = answerOf({ id: "bg-close", stepId: "s1" });
    s().answerArrived(closed, guard({ token: 8, stepId: "s1" }));
    expect(s().askPhase).toBe("selecting");
    expect(s().askContext?.token).toBeNull();
    expect(s().answers.s1?.map((item) => item.id)).toEqual(["bg-close"]);
    expect(s().expandedAnswerIds.has("bg-close")).toBe(false);
    expect(selectAskPresentation(s())).toBeNull();
    s().answerFailed("TIMEOUT", true, guard({ token: 8, stepId: "s1" }));
    expect(s()).toMatchObject({ askPhase: "selecting", askErrorCode: null });

    s().exitAsk();
    enterDrafting("退出后完成");
    s().askSent(guard({ token: 12 }));
    s().askStarted("bg-exit", guard({ token: 12 }));
    s().exitAsk();
    expect(s().askPhase).toBe("idle");
    s().answerArrived(answerOf({ id: "bg-exit", stepId: "s1" }), guard({ token: 12, stepId: "s1" }));
    expect(s()).toMatchObject({ askPhase: "idle", status: "paused", askContext: null });
    expect(s().answers.s1?.map((item) => item.id)).toEqual(["bg-close", "bg-exit"]);
    expect(s().expandedAnswerIds.has("bg-exit")).toBe(false);

    s().answerSegmentArrived(segment("late"), guard({ token: 12, stepId: "s1" }));
    expect(s().askPhase).toBe("idle");
    expect(s().previewSegments).toEqual([]);
  });

  test("error 态退出保留选区和草稿", () => {
    loadReady();
    enterDrafting("失败也留着");
    s().askSent(guard({ token: 4 }));
    s().answerFailed("TIMEOUT", true, guard({ token: 4 }));
    expect(s().askPhase).toBe("error");
    s().exitAsk();
    expect(s()).toMatchObject({
      askPhase: "idle",
      draftQuestion: "失败也留着",
      askErrorCode: null,
    });
    expect(s().selection).not.toBeNull();
  });

  test("askCancelled：sending 回 drafting，清预览，保留草稿", () => {
    loadReady();
    enterDrafting("取消后还在");
    s().askSent(guard({ token: 7 }));
    s().askStarted("ans-1", guard({ token: 7 }));
    s().answerSegmentArrived(segment("p1"), guard({ token: 7 }));
    expect(s().previewSegments).toHaveLength(1);
    s().askCancelled(guard({ token: 7 }));
    expect(s()).toMatchObject({
      askPhase: "drafting",
      status: "interrupted",
      draftQuestion: "取消后还在",
      askErrorCode: null,
      previewSegments: [],
    });
    expect(s().selection?.targets).toHaveLength(1);
    expect(s().askContext).toMatchObject({ answerId: null, token: null, segmentIndex: -1 });
  });

  test("answerFailed 丢预览进 error，草稿还在，已有回答条数不变", () => {
    loadReady();
    const prior = answerOf({ id: "old", stepId: "s1", createdAt: "2026-10-12T00:00:00.000Z" });
    s().setAnswers({ s1: [prior] });
    usePlayerStore.setState({ answersReady: true });
    enterDrafting("再问一次");
    s().askSent(guard({ token: 3 }));
    s().askStarted("ans-new", guard({ token: 3 }));
    s().answerSegmentArrived(segment("p1"), guard({ token: 3 }));
    s().answerSegmentArrived(segment("p2"), guard({ token: 3 }));
    s().answerFailed("UPSTREAM_ERROR", true, guard({ token: 3 }));
    expect(s()).toMatchObject({
      askPhase: "error",
      askErrorCode: "UPSTREAM_ERROR",
      askErrorRetryable: true,
      previewSegments: [],
      draftQuestion: "再问一次",
      status: "interrupted",
    });
    expect(s().selection).not.toBeNull();
    expect(countAnswers(s().answers)).toBe(1);
    expect(s().answers.s1?.[0]?.id).toBe("old");
  });

  test("streaming 中再 enter 不覆盖 token，availability 为 busy", () => {
    loadReady();
    enterDrafting("第一个");
    s().askSent(guard({ token: 11 }));
    s().askStarted("ans-1", guard({ token: 11 }));
    const token = s().askContext?.token;
    s().enterAsk();
    s().requestEnterAsk();
    expect(s().askContext?.token).toBe(token);
    expect(s().askPhase).toBe("streaming");
    expect(selectAskAvailability(s())).toEqual({ visible: true, disabled: true, reason: "busy" });
  });
});

describe("换步守卫与播放路由", () => {
  test("selecting 挡住 goto / next / prev，草稿不动", () => {
    loadReady();
    s().enterAsk();
    s().setAskQuestion("圈选中");
    s().goto(2);
    s().next();
    s().prev();
    expect(s()).toMatchObject({
      currentIndex: 0,
      askPhase: "selecting",
      draftQuestion: "圈选中",
      status: "interrupted",
    });
  });

  test("goto 当前步不清草稿和 awaitingContinue", () => {
    loadReady();
    s().pause();
    usePlayerStore.setState({ awaitingContinue: true });
    enterDrafting("同一步");
    s().exitAsk();
    usePlayerStore.setState({ awaitingContinue: true });
    s().goto(0);
    expect(s()).toMatchObject({
      currentIndex: 0,
      awaitingContinue: true,
      draftQuestion: "同一步",
      askPhase: "idle",
    });
    expect(s().selection).not.toBeNull();
  });

  test("idle 换步丢掉草稿，回到旧步没有旧草稿", () => {
    loadReady();
    enterDrafting("只属于第一步");
    s().exitAsk();
    s().goto(1);
    expect(s()).toMatchObject({
      currentIndex: 1,
      askPhase: "idle",
      draftQuestion: "",
      draftStepId: null,
      selection: null,
    });
    s().goto(0);
    expect(s().draftQuestion).toBe("");
    expect(s().selection).toBeNull();
  });

  test("play / resume 在 selecting 不把原课恢复成 playing", () => {
    loadReady();
    s().play();
    s().enterAsk();
    s().play();
    s().resume();
    expect(s()).toMatchObject({ status: "interrupted", askPhase: "selecting", currentIndex: 0 });
  });

  test("回答播放时 pause / play 只改 askPlaybackPaused", () => {
    loadReady();
    const stored = answerOf({ id: "a1", stepId: "s1" });
    s().setAnswers({ s1: [stored] });
    usePlayerStore.setState({ answersReady: true });
    s().play();
    s().playAnswer("a1");
    expect(s()).toMatchObject({ askPhase: "playing", status: "interrupted", currentIndex: 0 });
    s().pause();
    expect(s()).toMatchObject({ askPlaybackPaused: true, status: "interrupted", askPhase: "playing", currentIndex: 0 });
    s().play();
    expect(s()).toMatchObject({ askPlaybackPaused: false, status: "interrupted", currentIndex: 0 });
    s().setAnswerPlaybackPaused(true);
    s().resume();
    expect(s().askPlaybackPaused).toBe(false);
    expect(s().status).toBe("interrupted");
  });

  test("sending 时 next 不换步；goto 其他步后台化后跳走", () => {
    loadReady();
    enterDrafting("在飞");
    s().askSent(guard({ token: 2 }));
    s().next();
    expect(s()).toMatchObject({ askPhase: "sending", currentIndex: 0, status: "interrupted" });
    const generation = s().generation;
    s().goto(2);
    expect(s()).toMatchObject({
      askPhase: "idle",
      currentIndex: 2,
      status: "paused",
      awaitingContinue: false,
      askContext: null,
      draftQuestion: "",
      selection: null,
      previewSegments: [],
    });
    expect(s().generation).toBe(generation);
  });
});

describe("回答到达 / 播放 / 展开", () => {
  test("segment 不进 answers；result 追加、展开、从第 0 段播放，原 steps 不变", () => {
    loadReady();
    const stepsBefore = s().steps.map((step) => ({ ...step }));
    const scriptBefore = s().script;
    enterDrafting("问段");
    s().askSent(guard({ token: 5 }));
    s().askStarted("ans-1", guard({ token: 5 }));
    s().answerSegmentArrived(segment("p1", "预览一"), guard({ token: 5 }));
    s().answerSegmentArrived(segment("p2", "预览二"), guard({ token: 5 }));
    expect(countAnswers(s().answers)).toBe(0);
    expect(s().previewSegments).toHaveLength(2);
    expect(s().askPhase).toBe("streaming");
    const full = answerOf({
      id: "ans-1",
      stepId: "s1",
      segments: [segment("p1", "正式一"), segment("p2", "正式二")],
    });
    s().answerArrived(full, guard({ token: 5 }));
    expect(s()).toMatchObject({
      askPhase: "playing",
      status: "interrupted",
      previewSegments: [],
      askErrorCode: null,
    });
    expect(s().askContext).toMatchObject({ answerId: "ans-1", segmentIndex: 0 });
    expect(s().expandedAnswerIds.has("ans-1")).toBe(true);
    expect(countAnswers(s().answers)).toBe(1);
    expect(s().steps).toEqual(stepsBefore);
    expect(s().script).toEqual(scriptBefore);
    expect(selectAskPresentation(s())?.narration).toBe("正式一");
  });

  test("nextAnswerSegment 只推进段；最后一段 done 且不看 autoAdvance", () => {
    loadReady();
    s().setAutoAdvance(true);
    const full = answerOf({ id: "ans-1", stepId: "s1" });
    enterDrafting("三段");
    s().askSent(guard({ token: 8 }));
    s().askStarted("ans-1", guard({ token: 8 }));
    s().answerArrived(full, guard({ token: 8 }));
    const run = s().askPlaybackRun;
    expect(s().askContext?.segmentIndex).toBe(0);
    s().nextAnswerSegment(run - 1);
    expect(s().askContext?.segmentIndex).toBe(0);
    s().nextAnswerSegment(run);
    expect(s().askContext?.segmentIndex).toBe(1);
    expect(s()).toMatchObject({ askPhase: "playing", currentIndex: 0, status: "interrupted" });
    s().setAnswerPlaybackPaused(true);
    s().nextAnswerSegment(run);
    expect(s().askContext?.segmentIndex).toBe(1);
    s().setAnswerPlaybackPaused(false);
    s().nextAnswerSegment(run);
    s().nextAnswerSegment(run);
    expect(s()).toMatchObject({
      askPhase: "done",
      status: "paused",
      awaitingContinue: true,
      currentIndex: 0,
      draftQuestion: "",
      selection: null,
    });
    expect(s().askContext?.segmentIndex).toBe(-1);
    expect(s().expandedAnswerIds.has("ans-1")).toBe(true);
    expect(s().autoAdvance).toBe(true);
    expect(selectAskPresentation(s())).toBeNull();
  });

  test("autoAdvance 关闭时播完同样停在原步", () => {
    loadReady();
    s().setAutoAdvance(false);
    const full = answerOf({ id: "ans-1", stepId: "s1", segments: [segment("only")] });
    enterDrafting("一段");
    s().askSent(guard({ token: 1 }));
    s().askStarted("ans-1", guard({ token: 1 }));
    s().answerArrived(full, guard({ token: 1 }));
    s().nextAnswerSegment(s().askPlaybackRun);
    expect(s()).toMatchObject({ askPhase: "done", currentIndex: 0, status: "paused", awaitingContinue: true });
  });

  test("截图失败记在 askCaptureFallback，前台回答落地仍保留，播完清掉", () => {
    loadReady();
    enterDrafting("没截到");
    usePlayerStore.setState({ askCaptureFallback: true });
    s().askSent(guard({ token: 1 }));
    expect(s().askCaptureFallback).toBe(true);
    s().askStarted("ans-cap", guard({ token: 1 }));
    s().answerArrived(answerOf({ id: "ans-cap", stepId: "s1", segments: [segment("only")] }), guard({ token: 1 }));
    expect(s()).toMatchObject({ askPhase: "playing", askCaptureFallback: true });
    s().nextAnswerSegment(s().askPlaybackRun);
    expect(s()).toMatchObject({ askPhase: "done", askCaptureFallback: false });
  });

  test("截图失败后回答落地仍保留 askCaptureFallback，exitAsk 才清掉", () => {
    loadReady();
    enterDrafting("没截到就落地");
    usePlayerStore.setState({ askCaptureFallback: true });
    s().askSent(guard({ token: 1 }));
    expect(s()).toMatchObject({ askPhase: "sending", askInFlight: true, askCaptureFallback: true });
    s().answerArrived(answerOf({ id: "ans-settle", stepId: "s1", segments: [segment("only")] }), guard({ token: 1 }));
    expect(s().answers.s1?.map((item) => item.id)).toEqual(["ans-settle"]);
    expect(s()).toMatchObject({
      askPhase: "sending",
      askInFlight: false,
      askCaptureFallback: true,
    });
    s().exitAsk();
    expect(s().askCaptureFallback).toBe(false);
  });

  test("returnToStep 收起当前回答并停在原步；等待中只后台化", () => {
    loadReady();
    const full = answerOf({ id: "ans-1", stepId: "s1" });
    enterDrafting("播放中回去");
    s().askSent(guard({ token: 1 }));
    s().askStarted("ans-1", guard({ token: 1 }));
    s().answerArrived(full, guard({ token: 1 }));
    s().nextAnswerSegment(s().askPlaybackRun);
    expect(s().askContext?.segmentIndex).toBe(1);
    s().returnToStep();
    expect(s()).toMatchObject({
      askPhase: "done",
      status: "paused",
      awaitingContinue: true,
      currentIndex: 0,
    });
    expect(s().expandedAnswerIds.has("ans-1")).toBe(false);

    enterDrafting("最后一段");
    s().askSent(guard({ token: 2 }));
    s().askStarted("ans-2", guard({ token: 2 }));
    s().answerArrived(answerOf({ id: "ans-2", stepId: "s1", segments: [segment("z")] }), guard({ token: 2 }));
    s().returnToStep();
    expect(s().currentIndex).toBe(0);
    expect(s().expandedAnswerIds.has("ans-2")).toBe(false);

    enterDrafting("还在等");
    s().askSent(guard({ token: 9 }));
    s().askStarted("ans-3", guard({ token: 9 }));
    const gen = s().generation;
    s().returnToStep();
    expect(s()).toMatchObject({
      askPhase: "done",
      status: "paused",
      awaitingContinue: true,
      askContext: null,
      draftQuestion: "",
      currentIndex: 0,
    });
    expect(s().generation).toBe(gen);
  });

  test("历史展开不播放；显式播放从段 0；收起正在播放的条立即停", () => {
    loadReady();
    const stored = answerOf({ id: "hist", stepId: "s1" });
    s().setAnswers({ s1: [stored] });
    usePlayerStore.setState({ answersReady: true, askPhase: "idle", status: "paused" });
    s().toggleAnswer("hist");
    expect(s()).toMatchObject({ askPhase: "idle", status: "paused" });
    expect(s().expandedAnswerIds.has("hist")).toBe(true);
    expect(selectAskPresentation(s())).toBeNull();
    s().playAnswer("hist");
    expect(s()).toMatchObject({ askPhase: "playing", status: "interrupted" });
    expect(s().askContext).toMatchObject({ answerId: "hist", segmentIndex: 0, token: null });
    expect(countAnswers(s().answers)).toBe(1);
    s().toggleAnswer("hist");
    expect(s()).toMatchObject({ askPhase: "done", status: "paused", awaitingContinue: true });
    expect(s().expandedAnswerIds.has("hist")).toBe(false);
    expect(selectAskPresentation(s())).toBeNull();
  });

  test("同一步多回答按 createdAt 升序，同 id 替换，相同时刻保持原顺序", () => {
    loadReady();
    const first = answerOf({ id: "a", stepId: "s1", createdAt: "2026-10-13T08:00:00+08:00" });
    const second = answerOf({ id: "b", stepId: "s1", createdAt: "2026-10-13T00:30:00.000Z" });
    const tie = answerOf({ id: "c", stepId: "s1", createdAt: "2026-10-13T00:30:00.000Z" });
    s().setAnswers({ s1: [first] });
    usePlayerStore.setState({ answersReady: true, askPhase: "idle" });
    // 直接走 answerArrived 的后台路径，验证 appendAnswer 排序。
    const bg = (answer: StepAnswer, token: number) => {
      s().answerArrived(answer, guard({ token, stepId: "s1" }));
    };
    bg(second, 90);
    bg(tie, 91);
    expect(s().answers.s1?.map((item) => item.id)).toEqual(["a", "b", "c"]);
    const replaced = answerOf({ id: "b", stepId: "s1", question: "替换", createdAt: "2026-10-13T00:30:00.000Z" });
    bg(replaced, 92);
    expect(countAnswers(s().answers)).toBe(3);
    expect(s().answers.s1?.find((item) => item.id === "b")?.question).toBe("替换");
    expect(s().askPhase).toBe("idle");
  });

  test("replay 保留 answers、清空展开，不自动播放回答", () => {
    loadReady();
    const stored = answerOf({ id: "keep", stepId: "s2" });
    s().setAnswers({ s2: [stored] });
    usePlayerStore.setState({ answersReady: true });
    s().goto(1);
    s().toggleAnswer("keep");
    expect(s().expandedAnswerIds.has("keep")).toBe(true);
    usePlayerStore.setState({ status: "finished", currentIndex: 2 });
    s().replay();
    expect(s()).toMatchObject({
      status: "playing",
      currentIndex: 0,
      replaying: true,
      askPhase: "idle",
      awaitingContinue: false,
    });
    expect(countAnswers(s().answers)).toBe(1);
    expect(s().expandedAnswerIds.size).toBe(0);
    expect(s().steps).toHaveLength(3);
    expect(selectAskPresentation(s())).toBeNull();
  });

  test("selecting 时 replay 不生效", () => {
    loadReady();
    s().enterAsk();
    s().replay();
    expect(s()).toMatchObject({ askPhase: "selecting", currentIndex: 0, status: "interrupted" });
  });
});

describe("可用性", () => {
  test("askDisabledStepIds 置灰 stepDisabled，入口仍 visible", () => {
    loadReady({ ...readyMeta, askDisabledStepIds: ["", "s1", "s1"] });
    expect(selectAskAvailability(s())).toEqual({ visible: true, disabled: true, reason: "stepDisabled" });
    s().enterAsk();
    expect(s().askPhase).toBe("idle");
    s().goto(1);
    expect(selectAskAvailability(s())).toEqual({ visible: true, disabled: false, reason: null });
  });

  test("receiving、askBuiltin、askUnfinished、busy 按顺序取第一条", () => {
    loadReady();
    usePlayerStore.setState({ receiving: true, askBuiltin: true, askUnfinished: true });
    expect(selectAskAvailability(s()).reason).toBe("builtin");
    s().setAskBuiltin(false);
    expect(selectAskAvailability(s()).reason).toBe("receiving");
    usePlayerStore.setState({ receiving: false });
    expect(selectAskAvailability(s()).reason).toBe("unfinished");
    s().setAskUnfinished(false);
    expect(selectAskAvailability(s())).toEqual({ visible: true, disabled: false, reason: null });
    enterDrafting("忙");
    s().askSent(guard({ token: 1 }));
    expect(selectAskAvailability(s()).reason).toBe("busy");
  });

  test("无脚本或当前步未到时入口不可见", () => {
    expect(selectAskAvailability(s())).toEqual({ visible: false, disabled: true, reason: null });
    s().beginStream(script);
    expect(selectAskAvailability(s()).visible).toBe(false);
  });

  test("pending 不置灰；requestEnterAsk 记意图，meta 落到 server 后进入", () => {
    s().loadScript(script);
    s().setLectureAnswerMeta({ ...readyMeta, storageMode: "pending", cacheKey: "", scriptVersion: "" });
    usePlayerStore.setState({ answersReady: true });
    expect(selectAskAvailability(s())).toEqual({ visible: true, disabled: false, reason: null });
    s().play();
    s().requestEnterAsk();
    expect(s().askPhase).toBe("idle");
    expect(s().pendingEnterIntent).toEqual({ stepId: "s1", generation: s().generation });
    s().setLectureAnswerMeta(readyMeta);
    expect(s()).toMatchObject({ askPhase: "selecting", status: "interrupted", pendingEnterIntent: null });
    expect(s().askContext).toMatchObject({ prevStatus: "playing", stepId: "s1" });
  });

  test("意图换步后失效；落定后若步骤禁问则返回 reason 且不进入", () => {
    s().loadScript(script);
    s().setLectureAnswerMeta({ ...readyMeta, storageMode: "pending" });
    s().requestEnterAsk();
    s().goto(1);
    expect(s().pendingEnterIntent).toBeNull();

    s().setLectureAnswerMeta({ ...readyMeta, storageMode: "pending" });
    s().goto(0);
    s().requestEnterAsk();
    const reason = s().flushPendingEnterAsk();
    expect(reason).toBeNull();
    expect(s().askPhase).toBe("idle");

    s().requestEnterAsk();
    s().setLectureAnswerMeta({ ...readyMeta, askDisabledStepIds: ["s1"] });
    expect(s().askPhase).toBe("idle");
    expect(s().pendingEnterIntent).toBeNull();
    expect(selectAskAvailability(s()).reason).toBe("stepDisabled");
  });

  test("clearAskSelection 清选区、留问题，回到 selecting", () => {
    loadReady();
    enterDrafting("问题还在");
    s().clearAskSelection();
    expect(s()).toMatchObject({
      askPhase: "selecting",
      selection: null,
      draftQuestion: "问题还在",
      draftStepId: "s1",
      askErrorCode: null,
    });
  });
});

describe("后台结果 / stale / 清理", () => {
  test("跳走后的 result 只追加，不改 phase、展开和 currentIndex", () => {
    loadReady();
    enterDrafting("会跳走");
    s().askSent(guard({ token: 4 }));
    s().askStarted("bg-1", guard({ token: 4 }));
    s().goto(2);
    expect(s()).toMatchObject({ askPhase: "idle", currentIndex: 2 });
    const late = answerOf({ id: "bg-1", stepId: "s1" });
    s().answerArrived(late, guard({ token: 4, stepId: "s1" }));
    expect(s()).toMatchObject({ askPhase: "idle", currentIndex: 2, status: "paused" });
    expect(s().expandedAnswerIds.has("bg-1")).toBe(false);
    expect(s().answers.s1?.map((item) => item.id)).toEqual(["bg-1"]);
    expect(s().askContext).toBeNull();
  });

  test("后台 result 与新前台 result 交错，两答都在且不覆盖新 context", () => {
    loadReady();
    enterDrafting("旧的");
    s().askSent(guard({ token: 1 }));
    s().askStarted("old", guard({ token: 1 }));
    s().goto(1);
    s().enterAsk();
    s().setAskSelection(selection);
    s().setAskQuestion("新的");
    s().askSent(guard({ token: 2, stepId: "s2" }));
    s().askStarted("new", guard({ token: 2, stepId: "s2" }));
    const oldAnswer = answerOf({ id: "old", stepId: "s1", createdAt: "2026-10-13T00:00:00.000Z" });
    const newAnswer = answerOf({ id: "new", stepId: "s2", createdAt: "2026-10-13T00:01:00.000Z" });
    s().answerArrived(oldAnswer, guard({ token: 1, stepId: "s1" }));
    expect(s().askPhase).toBe("streaming");
    expect(s().askContext).toMatchObject({ token: 2, answerId: "new", stepId: "s2" });
    s().answerArrived(newAnswer, guard({ token: 2, stepId: "s2" }));
    expect(s()).toMatchObject({ askPhase: "playing", currentIndex: 1 });
    expect(s().askContext).toMatchObject({ answerId: "new", stepId: "s2", segmentIndex: 0 });
    expect(s().expandedAnswerIds.has("new")).toBe(true);
    expect(s().expandedAnswerIds.has("old")).toBe(false);
    expect(s().answers.s1?.[0]?.id).toBe("old");
    expect(s().answers.s2?.[0]?.id).toBe("new");
  });

  test("跳回原步后后台完成仍折叠；后台 error 不改当前面板", () => {
    loadReady();
    enterDrafting("跳走再回来");
    s().askSent(guard({ token: 6 }));
    s().askStarted("late", guard({ token: 6 }));
    s().goto(1);
    s().goto(0);
    s().answerArrived(answerOf({ id: "late", stepId: "s1" }), guard({ token: 6, stepId: "s1" }));
    expect(s()).toMatchObject({ askPhase: "idle", currentIndex: 0, status: "paused" });
    expect(s().expandedAnswerIds.size).toBe(0);
    expect(selectAskPresentation(s())).toBeNull();

    s().enterAsk();
    s().setAskSelection(selection);
    s().setAskQuestion("当前面板");
    const phase = s().askPhase;
    s().answerFailed("TIMEOUT", true, guard({ token: 6, stepId: "s1" }));
    expect(s().askPhase).toBe(phase);
    expect(s().askErrorCode).toBeNull();
    expect(s().draftQuestion).toBe("当前面板");
    expect(countAnswers(s().answers)).toBe(1);
  });

  test("取消后旧 start / segment / result / error 不能覆盖重试", () => {
    loadReady();
    enterDrafting("重试");
    s().askSent(guard({ token: 1 }));
    s().askCancelled(guard({ token: 1 }));
    expect(s().askPhase).toBe("drafting");
    s().askSent(guard({ token: 2 }));
    s().askStarted("old", guard({ token: 1 }));
    s().answerSegmentArrived(segment("stale"), guard({ token: 1 }));
    expect(s()).toMatchObject({ askPhase: "sending", previewSegments: [] });
    expect(s().askContext?.token).toBe(2);
    s().askStarted("fresh", guard({ token: 2 }));
    s().answerFailed("TIMEOUT", true, guard({ token: 1 }));
    expect(s().askPhase).toBe("streaming");
    expect(s().askErrorCode).toBeNull();
    s().answerArrived(answerOf({ id: "old", stepId: "s1" }), guard({ token: 1, stepId: "s1" }));
    // token 1 已不是前台，但 generation / meta 仍匹配：作为后台结果可以落库，不改前台。
    expect(s().askPhase).toBe("streaming");
    expect(s().askContext).toMatchObject({ token: 2, answerId: "fresh" });
    expect(s().answers.s1?.[0]?.id).toBe("old");
    s().answerFailed("UPSTREAM_ERROR", true, guard({ token: 2 }));
    expect(s().askErrorCode).toBe("UPSTREAM_ERROR");
    const run = s().askPlaybackRun;
    s().answerArrived(answerOf({ id: "old-2", stepId: "s1" }), guard({ token: 1, stepId: "s1" }));
    expect(s().askPhase).toBe("error");
    expect(s().askErrorCode).toBe("UPSTREAM_ERROR");
    expect(s().askPlaybackRun).toBe(run);
  });

  test("generation 或 cacheKey 不匹配的回调被丢弃", () => {
    loadReady();
    enterDrafting("会过期");
    s().askSent(guard({ token: 1 }));
    s().askStarted("a", guard({ token: 1 }));
    const stale = guard({ token: 1, generation: s().generation - 1 });
    s().answerSegmentArrived(segment("nope"), stale);
    s().answerArrived(answerOf({ id: "nope", stepId: "s1" }), stale);
    s().answerFailed("TIMEOUT", true, stale);
    expect(s().previewSegments).toEqual([]);
    expect(countAnswers(s().answers)).toBe(0);
    expect(s().askPhase).toBe("streaming");
    const wrongKey = guard({ token: 1, cacheKey: "other" });
    s().answerArrived(answerOf({ id: "nope2", stepId: "s1" }), wrongKey);
    expect(countAnswers(s().answers)).toBe(0);
  });

  test("clearAnswers 清空 map；取消和失败不会清已有回答", () => {
    loadReady();
    s().setAnswers({
      s1: [answerOf({ id: "keep", stepId: "s1" })],
      s2: [answerOf({ id: "keep-2", stepId: "s2" })],
    });
    usePlayerStore.setState({ answersReady: true });
    expect(countAnswers(s().answers)).toBe(2);
    enterDrafting("别删");
    s().askSent(guard({ token: 1 }));
    s().askCancelled(guard({ token: 1 }));
    expect(countAnswers(s().answers)).toBe(2);
    s().askSent(guard({ token: 2 }));
    s().answerFailed("EMPTY_BODY", true, guard({ token: 2 }));
    expect(countAnswers(s().answers)).toBe(2);
    s().clearAnswers();
    expect(countAnswers(s().answers)).toBe(0);
    expect(s()).toMatchObject({ askPhase: "idle", draftQuestion: "", selection: null });
  });

  test("reset 清内存提问；beginStream 保留旧 answers 但 answersReady=false", () => {
    loadReady();
    s().setAnswers({ s1: [answerOf({ id: "mem", stepId: "s1" })] });
    usePlayerStore.setState({ answersReady: true, askBuiltin: true });
    enterDrafting("要被 reset");
    const gen = s().generation;
    s().reset();
    expect(s()).toMatchObject({
      askPhase: "idle",
      answersReady: false,
      askBuiltin: false,
      askUnfinished: false,
      draftQuestion: "",
      selection: null,
      pendingEnterIntent: null,
      status: "idle",
    });
    expect(s().generation).toBe(gen + 1);
    expect(countAnswers(s().answers)).toBe(0);

    loadReady();
    s().setAnswers({ s1: [answerOf({ id: "mem", stepId: "s1" })] });
    usePlayerStore.setState({ answersReady: true });
    s().beginStream(script);
    expect(s().answersReady).toBe(false);
    expect(s().answers.s1?.[0]?.id).toBe("mem");
    expect(s().askPhase).toBe("idle");
    expect(selectAskAvailability(s()).visible).toBe(false);
  });

  test("playing 跳步停回答并收起；error 换步先解除 interrupted", () => {
    loadReady();
    const stored = answerOf({ id: "play-me", stepId: "s1" });
    s().setAnswers({ s1: [stored] });
    usePlayerStore.setState({ answersReady: true });
    s().playAnswer("play-me");
    const run = s().askPlaybackRun;
    s().goto(2);
    expect(s()).toMatchObject({
      askPhase: "idle",
      currentIndex: 2,
      status: "paused",
      awaitingContinue: false,
      askContext: null,
    });
    expect(s().askPlaybackRun).toBe(run + 1);

    s().goto(0);
    enterDrafting("会失败");
    s().askSent(guard({ token: 3 }));
    s().answerFailed("BAD_REQUEST", false, guard({ token: 3 }));
    expect(s()).toMatchObject({ askPhase: "error", status: "interrupted" });
    s().goto(1);
    expect(s()).toMatchObject({
      askPhase: "idle",
      status: "paused",
      currentIndex: 1,
      draftQuestion: "",
      askErrorCode: null,
    });
  });

  test("空问题或超限不进入 sending", () => {
    loadReady();
    enterDrafting("   ");
    s().askSent(guard({ token: 1 }));
    expect(s().askPhase).toBe("drafting");
    s().setAskQuestion("字".repeat(301));
    s().askSent(guard({ token: 1 }));
    expect(s().askPhase).toBe("drafting");
    s().setAskQuestion("字".repeat(300));
    s().askSent(guard({ token: 1 }));
    expect(s().askPhase).toBe("sending");
  });

  test("error 再进入保留原 prevStatus，不把 interrupted 存回去", () => {
    loadReady();
    s().play();
    enterDrafting("失败重进");
    s().askSent(guard({ token: 1 }));
    s().answerFailed("TIMEOUT", true, guard({ token: 1 }));
    s().enterAsk();
    expect(s()).toMatchObject({ askPhase: "drafting", status: "interrupted" });
    expect(s().askContext).toMatchObject({ prevStatus: "playing", prevAwaitingContinue: false });
    expect(s().askErrorCode).toBeNull();
    expect(s().draftQuestion).toBe("失败重进");
  });
});
