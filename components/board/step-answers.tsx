/**
 * StepAnswers · 当前步下的提问回答（TECH-v0.3-M5 §6.1）
 * 挂在教案当前步按钮之后。逐条「你问的」可折叠；播放中本地打字，
 * 打完只调 nextAnswerSegment(run)。「回到这一步」收起并停在原步。
 * 回答区不加 data-ask-target，点击不冒泡到父步骤按钮。
 */
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { resolveAskError } from "@/lib/ask/ask-errors";
import type { AnswerSegment, StepAnswer } from "@/lib/ask/types";
import { usePlayerStore } from "@/lib/player/store";
import { usePrefersReducedMotion } from "@/components/effects/fx-context";
import { parseInline, totalChars, InlinePartial } from "./inline-markdown";

const BASE_CHARS_PER_SEC = 24;

function sortByCreatedAt(list: StepAnswer[]): StepAnswer[] {
  return list
    .map((answer, index) => ({ answer, index, time: Date.parse(answer.createdAt) }))
    .sort((a, b) => {
      const at = Number.isNaN(a.time) ? 0 : a.time;
      const bt = Number.isNaN(b.time) ? 0 : b.time;
      if (at !== bt) return at - bt;
      return a.index - b.index;
    })
    .map((item) => item.answer);
}

/** 正在播放的那一段；其余已展开回答显示全文。 */
function AnswerBody({
  answer,
  active,
  segmentIndex,
  run,
  paused,
  speed,
  reduced,
}: {
  answer: StepAnswer;
  active: boolean;
  segmentIndex: number;
  run: number;
  paused: boolean;
  speed: number;
  reduced: boolean;
}) {
  const nextAnswerSegment = usePlayerStore((s) => s.nextAnswerSegment);
  const segment: AnswerSegment | undefined = active ? answer.segments[segmentIndex] : undefined;
  const narration = segment?.narration ?? "";
  const segments = useMemo(() => parseInline(narration), [narration]);
  const total = totalChars(segments);
  const typeKey = `${answer.id}\0${segmentIndex}\0${run}\0${narration}`;
  const [typing, setTyping] = useState({ key: "", count: 0 });
  // 暂停保留已打字数；减少动效或非当前段直接全文。
  const showFull = reduced || !active;
  const typed = showFull ? total : typing.key === typeKey ? typing.count : 0;
  const accRef = useRef(0);
  const done = total === 0 || typed >= total;
  const typingOn = active && !paused && !reduced && segment != null;

  useEffect(() => {
    setTyping((previous) => {
      if (reduced || !active) {
        accRef.current = 0;
        return { key: typeKey, count: total };
      }
      if (previous.key === typeKey) {
        if (!paused) accRef.current = 0;
        return previous;
      }
      accRef.current = 0;
      return { key: typeKey, count: 0 };
    });
  }, [typeKey, total, reduced, active, paused]);

  useEffect(() => {
    if (!typingOn || done) return;
    const perTick = (BASE_CHARS_PER_SEC * speed) / 20;
    const timer = setInterval(() => {
      accRef.current += perTick;
      const n = Math.floor(accRef.current);
      if (n > 0) {
        accRef.current -= n;
        setTyping((t) => ({
          key: typeKey,
          count: Math.min(total, (t.key === typeKey ? t.count : 0) + n),
        }));
      }
    }, 50);
    return () => clearInterval(timer);
  }, [typingOn, done, speed, total, typeKey]);

  useEffect(() => {
    if (!typingOn || !done || segment == null) return;
    nextAnswerSegment(run);
  }, [typingOn, done, segment, run, nextAnswerSegment]);

  if (!active) {
    return (
      <div className="flex flex-col gap-1 text-[13px] leading-5 text-chalk-300">
        {answer.segments.map((seg) => (
          <p key={seg.id}>
            <InlinePartial segments={parseInline(seg.narration)} count={totalChars(parseInline(seg.narration))} />
          </p>
        ))}
      </div>
    );
  }

  return (
    <p className="min-h-6 text-[13px] leading-5 text-chalk-100">
      <InlinePartial segments={segments} count={typed} />
    </p>
  );
}

function PreviewBody({ segments }: { segments: AnswerSegment[] }) {
  return (
    <div data-testid="ask-preview" className="flex flex-col gap-1 text-[13px] leading-5 text-chalk-300">
      {segments.map((seg) => (
        <p key={seg.id}>
          <InlinePartial segments={parseInline(seg.narration)} count={totalChars(parseInline(seg.narration))} />
        </p>
      ))}
    </div>
  );
}

export default function StepAnswers({ stepId }: { stepId: string }) {
  const answers = usePlayerStore((s) => s.answers[stepId]);
  const askPhase = usePlayerStore((s) => s.askPhase);
  const askContext = usePlayerStore((s) => s.askContext);
  const previewSegments = usePlayerStore((s) => s.previewSegments);
  const expandedAnswerIds = usePlayerStore((s) => s.expandedAnswerIds);
  const askErrorCode = usePlayerStore((s) => s.askErrorCode);
  const askPlaybackRun = usePlayerStore((s) => s.askPlaybackRun);
  const askPlaybackPaused = usePlayerStore((s) => s.askPlaybackPaused);
  const speed = usePlayerStore((s) => s.speed);
  const toggleAnswer = usePlayerStore((s) => s.toggleAnswer);
  const playAnswer = usePlayerStore((s) => s.playAnswer);
  const returnToStep = usePlayerStore((s) => s.returnToStep);
  const reduced = usePrefersReducedMotion();

  const list = useMemo(() => sortByCreatedAt(answers ?? []), [answers]);
  const sameStep = askContext?.stepId === stepId;
  const showPreview =
    sameStep && (askPhase === "streaming" || askPhase === "sending") && previewSegments.length > 0;
  const showError = sameStep && askPhase === "error" && askErrorCode != null;
  const errorView = showError ? resolveAskError({ code: askErrorCode }) : null;
  const playingHere = sameStep && askPhase === "playing" && askContext?.answerId != null;

  if (list.length === 0 && !showPreview && !showError) return null;

  return (
    <div
      data-testid="step-answers"
      data-ask-exclude=""
      className="mb-1 ml-8 flex flex-col gap-1"
      onClick={(event) => event.stopPropagation()}
    >
      {list.map((answer) => {
        const expanded = expandedAnswerIds.has(answer.id);
        const panelId = `step-answer-${answer.id}`;
        const active =
          playingHere && askContext?.answerId === answer.id && (askContext?.segmentIndex ?? -1) >= 0;
        const showReturn = active || (sameStep && askPhase === "done" && askContext?.answerId === answer.id && expanded);
        return (
          <div key={answer.id} className="rounded-lg bg-board-800/70 px-2.5 py-1.5">
            <button
              type="button"
              aria-expanded={expanded}
              aria-controls={panelId}
              aria-label={`你问的 ${answer.question}`}
              className="flex w-full items-baseline gap-2 text-left text-[13px] leading-5 text-chalk-300"
              onClick={() => toggleAnswer(answer.id)}
            >
              <span className="shrink-0 font-mono text-[10px] tracking-widest text-beam-gold">你问的</span>
              <span className="line-clamp-1">{answer.question}</span>
            </button>
            {expanded && (
              <div id={panelId} className="mt-1 flex flex-col gap-1.5">
                <AnswerBody
                  answer={answer}
                  active={active}
                  segmentIndex={askContext?.segmentIndex ?? 0}
                  run={askPlaybackRun}
                  paused={askPlaybackPaused}
                  speed={speed}
                  reduced={reduced}
                />
                {!active && (
                  <button
                    type="button"
                    className="self-start text-xs text-beam-gold/90 hover:text-beam-gold"
                    onClick={() => playAnswer(answer.id)}
                  >
                    播放回答
                  </button>
                )}
                {showReturn && (
                  <button
                    type="button"
                    className="self-start text-xs text-chalk-300 hover:text-chalk-100"
                    onClick={() => returnToStep()}
                  >
                    回到这一步
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })}
      {showPreview && <PreviewBody segments={previewSegments} />}
      {errorView && errorView.message && (
        <p role="alert" className="text-xs text-beam-gold/90">
          {errorView.message}
        </p>
      )}
    </div>
  );
}
