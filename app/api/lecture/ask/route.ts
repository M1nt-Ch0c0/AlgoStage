/**
 * POST /api/lecture/ask · 对可信缓存中的当前步生成 StepAnswer。
 * 校验顺序见 TECH-v0.3-M3 §4.1。STEP-4 才接入准入、落库和公开跳过写。
 */
import { createHash, randomUUID } from "crypto";
import { NextRequest } from "next/server";
import { generateAsk, InvalidAnswerError, type AskGenerationResult } from "@/lib/agent/ask-generation";
import { askTimeoutMs } from "@/lib/agent/defaults";
import { buildAskPrompt, supportsAskImage } from "@/lib/agent/modes/ask";
import {
  resolveByok,
  ByokConfigurationError,
  ByokKeyRequiredError,
  savedBaseURLOf,
  serverKeyDisabled,
  type ByokConfig,
} from "@/lib/agent/provider";
import {
  askError,
  askRequestSchema,
  badRequest,
  baseURLInvalid,
  byokKeyRequired,
  configurationError,
  readAskBody,
  streamErrorEvent,
  upstreamAuthError,
  upstreamError,
} from "@/lib/agent/request";
import { validateBaseURL } from "@/lib/agent/settings-connection";
import { AI_CONNECTION_ERROR, InvalidAIBaseURLError, ServerAIBaseURLError } from "@/lib/ai/egress-guard";
import { summarizeSelection } from "@/lib/ask/answers";
import { insertAnswer } from "@/lib/ask/answers-repo";
import { admitAsk, resolveAskClientIp } from "@/lib/ask/ask-control";
import { scriptVersion } from "@/lib/ask/script-version";
import { stepAnswerSchema } from "@/lib/ask/schema";
import type { StepAnswer } from "@/lib/ask/types";
import { localSeedSource } from "@/lib/content/local-source";
import { prisma } from "@/lib/db/prisma";
import { askableStepIds, validateScript } from "@/lib/teaching/validated-script";
import type { TeachingScript, TeachingStep } from "@/lib/teaching/types";

export const runtime = "nodejs";

/** Node setTimeout delay ceiling. A larger delay overflows to 1ms, so the timer is chunked. */
const MAX_TIMER_MS = 2_147_483_647;
/** One outbound NDJSON event, including the result line, must fit the client line buffer. */
const EVENT_MAX_BYTES = 64 * 1024;

const STEP_NOT_FOUND_MESSAGE = "这节课已更新或这一步不可用，请刷新。";
const INVALID_ANSWER_MESSAGE = "回答内容暂时没生成好，请重新问。";
const TIMEOUT_MESSAGE = "回答超时，请重新问。";
const CANCELLED_MESSAGE = "已取消。";
const NO_BYOK_MESSAGE = "老师还没接上 AI，先去设置里填自己的 Key。";
const NOT_FOUND_MESSAGE = "没找到这道题，请回路线图重新选择。";

type StopReason = "timeout" | "cancelled";

/** Codes that may appear after the first segment. Anything else stays UPSTREAM_ERROR. */
const LATE_ERROR_CODES = new Set([
  "UPSTREAM_AUTH",
  "TIMEOUT",
  "UPSTREAM_ERROR",
  "INVALID_ANSWER",
  "CANCELLED",
  "STEP_NOT_FOUND",
]);

type AskFailure = {
  status: number;
  error: string;
  message: string;
  retryable: boolean;
};

type CacheOwnership =
  | {
      ok: true;
      script: TeachingScript;
      step: TeachingStep;
      referenceCode: string;
      version: string;
    }
  | { ok: false; db: boolean };

type AskBody = ReturnType<typeof askRequestSchema.parse>;

type AskContext = {
  body: AskBody;
  byok: ByokConfig;
  keySource: "request" | "settings" | "env";
  ownership: Extract<CacheOwnership, { ok: true }>;
  imageUsed: boolean;
  answerId: string;
};

export async function POST(req: NextRequest) {
  const timeout = new AbortController();
  const generationAbort = new AbortController();
  const combinedSignal = AbortSignal.any([req.signal, timeout.signal]);
  const stop = createStopTracker(req.signal, timeout.signal, combinedSignal, generationAbort);
  const deadline = Date.now() + askTimeoutMs();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cleaned = false;
  let releaseAdmission: (() => void) | undefined;

  const armTimeout = () => {
    if (timeout.signal.aborted) return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      timeout.abort("timeout");
      return;
    }
    timer = setTimeout(armTimeout, Math.min(remaining, MAX_TIMER_MS));
  };
  armTimeout();

  const clearTimer = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    clearTimer();
    stop.detach();
    releaseAdmission?.();
    releaseAdmission = undefined;
  };
  const leave = (response: Response) => {
    cleanup();
    return response;
  };

  const stopped = (): AskFailure | undefined => {
    const reason = stop.reason();
    return reason ? failureFromStop(reason) : undefined;
  };

  try {
    const earlyStop = stopped();
    if (earlyStop) return leave(askFailureResponse(earlyStop));

    const read = await untilStop(readAskBody(req, combinedSignal), combinedSignal, stopped);
    if (isAskFailure(read)) return leave(askFailureResponse(read));
    if (!read.ok) return leave(read.response);

    let input: unknown;
    try {
      input = JSON.parse(read.text);
    } catch {
      return leave(askError("BAD_JSON", 400));
    }
    const parsed = askRequestSchema.safeParse(input);
    if (!parsed.success) return leave(badRequest(parsed.error, "提问参数不正确，请检查问题和选区。"));
    const body = parsed.data;

    const listed = await untilStop(localSeedSource.list(), combinedSignal, stopped);
    if (isAskFailure(listed)) return leave(askFailureResponse(listed));
    if (!listed.some(problem => problem.slug === body.problemSlug)) {
      return leave(Response.json({ error: "NOT_FOUND", message: NOT_FOUND_MESSAGE }, { status: 404 }));
    }

    let resolved: Awaited<ReturnType<typeof resolveByok>>;
    try {
      const pending = untilStop(resolveByok(body.byok), combinedSignal, stopped);
      const value = await pending;
      if (isAskFailure(value)) return leave(askFailureResponse(value));
      resolved = value;
    } catch (error) {
      if (stopped()) return leave(askFailureResponse(stopped()!));
      if (error instanceof ByokKeyRequiredError) return leave(byokKeyRequired());
      if (error instanceof ServerAIBaseURLError) return leave(upstreamError());
      if (error instanceof InvalidAIBaseURLError) return leave(baseURLInvalid());
      if (error instanceof ByokConfigurationError) return leave(configurationError());
      // Unknown resolve failures stay 502. The original exception is not logged.
      console.warn("ask_route", JSON.stringify({ type: "resolve_byok" }));
      return leave(upstreamError());
    }
    const byok = resolved?.config;
    if (!byok || !resolved) {
      return leave(Response.json({ error: "NO_BYOK", message: NO_BYOK_MESSAGE }, { status: 400 }));
    }

    const checkURL = body.byok?.baseURL || savedBaseURLOf(byok);
    if (checkURL) {
      const checked = await untilStop(validateBaseURL(checkURL, combinedSignal), combinedSignal, stopped);
      if (isAskFailure(checked)) return leave(askFailureResponse(checked));
      if (checked) {
        // Runtime preflight is one 502. Schema and resolve errors stay on their own codes.
        const aborted = stopped();
        if (aborted) return leave(askFailureResponse(aborted));
        return leave(upstreamError());
      }
    }

    const ownership = await untilStop(loadOwnership(body, byok), combinedSignal, stopped);
    if (isAskFailure(ownership)) return leave(askFailureResponse(ownership));
    if (!ownership.ok) return leave(ownership.db ? upstreamError() : stepNotFound());

    const mode = serverKeyDisabled() ? "public" as const : "local" as const;
    const admitted = admitAsk({
      mode,
      cacheKey: body.cacheKey,
      ip: resolveAskClientIp(req.headers),
    });
    if (!admitted.ok) {
      const headers =
        admitted.retryAfterSec != null
          ? { "Retry-After": String(admitted.retryAfterSec) }
          : undefined;
      return leave(askError(
        admitted.code as Parameters<typeof askError>[0],
        admitted.status,
        admitted.message,
        headers,
      ));
    }
    releaseAdmission = admitted.release;

    const imageUsed = body.image != null && supportsAskImage(byok);
    const context: AskContext = {
      body,
      byok,
      keySource: resolved.source,
      ownership,
      imageUsed,
      answerId: randomUUID(),
    };
    const wantsNdjson = req.headers.get("accept")?.includes("application/x-ndjson") ?? false;
    return await streamAnswer(req, context, {
      generationAbort,
      combinedSignal,
      stopped,
      recordClientCancel: stop.recordClientCancel,
      clearTimer,
      cleanup,
      wantsNdjson,
    });
  } catch (error) {
    const aborted = stopped();
    cleanup();
    if (aborted) return askFailureResponse(aborted);
    if (error instanceof InvalidAnswerError) return askFailureResponse(invalidAnswer());
    console.warn("ask_route", JSON.stringify({ type: "unhandled" }));
    return upstreamError();
  }
}

type StreamSession = {
  generationAbort: AbortController;
  combinedSignal: AbortSignal;
  stopped: () => AskFailure | undefined;
  recordClientCancel: () => void;
  /** Clear the request timer without releasing the admission slot. */
  clearTimer: () => void;
  cleanup: () => void;
  wantsNdjson: boolean;
};

async function streamAnswer(req: NextRequest, context: AskContext, session: StreamSession): Promise<Response> {
  let ready!: (failure?: AskFailure) => void;
  let settled = false;
  const settle = (failure?: AskFailure) => {
    if (settled) return;
    settled = true;
    ready(failure);
  };
  const firstSegment = new Promise<AskFailure | undefined>(resolve => {
    ready = resolve;
  });

  let opened = false;
  let errorSent = false;
  let disconnected = false;
  // Internal cancel must not record a client disconnect over an existing failure.
  let suppressCancelRecord = false;
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: unknown) => {
        // A cancelled reader cannot take another error line or a result.
        if (!opened || disconnected) return;
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };
      const fail = (failure: AskFailure) => {
        const outbound = opened ? lateFailure(failure) : failure;
        settle(outbound);
        if (opened && !errorSent) {
          errorSent = true;
          send(streamErrorEvent(outbound.error));
        }
      };
      try {
        const prompt = buildAskPrompt({
          script: context.ownership.script,
          step: context.ownership.step,
          referenceCode: context.ownership.referenceCode,
          selection: summarizeSelection(context.body.selection),
          question: context.body.question,
          imageAttached: context.imageUsed,
        });
        const image = context.imageUsed && context.body.image
          ? { mime: context.body.image.mime, dataBase64: context.body.image.dataBase64 }
          : undefined;
        const generated = await generateAsk({
          config: context.byok,
          prompt,
          image,
          signal: session.generationAbort.signal,
          assertNoRequestKey: value => assertNoRequestKey(value, context),
          referenceCode: context.ownership.referenceCode,
          onSegment: segment => {
            const aborted = session.stopped();
            if (aborted) {
              settle(aborted);
              return;
            }
            if (!opened) {
              const startEvent = {
                type: "start" as const,
                answerId: context.answerId,
                stepId: context.body.stepId,
                imageUsed: context.imageUsed,
              };
              const segmentEvent = { type: "segment" as const, segment };
              if (
                Buffer.byteLength(JSON.stringify(startEvent), "utf8") > EVENT_MAX_BYTES ||
                Buffer.byteLength(JSON.stringify(segmentEvent), "utf8") > EVENT_MAX_BYTES
              ) {
                throw new InvalidAnswerError();
              }
              const raced = session.stopped();
              if (raced) {
                settle(raced);
                return;
              }
              opened = true;
              send(startEvent);
              send(segmentEvent);
              settle();
              return;
            }
            const segmentEvent = { type: "segment" as const, segment };
            if (Buffer.byteLength(JSON.stringify(segmentEvent), "utf8") > EVENT_MAX_BYTES) {
              throw new InvalidAnswerError();
            }
            send(segmentEvent);
          },
        });
        const aborted = session.stopped();
        if (aborted) {
          fail(aborted);
          return;
        }
        if (!generated.ok) {
          fail(failureFromGeneration(generated));
          return;
        }
        const built = await completeAnswer(context, generated.segments, session);
        if (isAskFailure(built)) {
          fail(built);
          return;
        }
        const resultEvent = { type: "result" as const, answer: built };
        if (Buffer.byteLength(JSON.stringify(resultEvent), "utf8") > EVENT_MAX_BYTES) {
          fail(invalidAnswer());
          return;
        }
        const late = session.stopped();
        if (late) {
          fail(late);
          return;
        }
        settle();
        send(resultEvent);
      } catch (error) {
        if (error instanceof InvalidAnswerError) fail(invalidAnswer());
        else if (session.stopped()) fail(session.stopped()!);
        else fail(upstreamFailure());
      } finally {
        try {
          if (opened) controller.close();
        } catch {
          // cancel() already closed the controller.
        }
        session.cleanup();
      }
    },
    cancel() {
      disconnected = true;
      // A stop recorded earlier (timeout or a settled failure) keeps its code.
      // Cleanup that cancels this stream must not turn TIMEOUT into CANCELLED.
      if (!session.stopped() && !suppressCancelRecord) session.recordClientCancel();
      if (!session.generationAbort.signal.aborted) {
        session.generationAbort.abort(session.combinedSignal.reason);
      }
    },
  });

  const dropStream = () => {
    suppressCancelRecord = true;
    // Do not await cancel: a producer stuck in a non-abortable upstream would
    // keep start() running and hold this response forever.
    void stream.cancel().catch(() => undefined);
  };

  const failure = await Promise.race([
    firstSegment,
    abortWait(session.combinedSignal).then(() => session.stopped() ?? failureFromStop("cancelled")),
  ]);
  if (!settled) {
    // The producer may still be between awaits. Lock release stays in its
    // finally. Only the timer is cleared so a returned error cannot linger.
    session.clearTimer();
    dropStream();
    return askFailureResponse(session.stopped() ?? failure ?? failureFromStop("cancelled"));
  }
  if (failure) {
    dropStream();
    session.cleanup();
    return askFailureResponse(failure);
  }

  if (!session.wantsNdjson) {
    const collected = await collectJsonAnswer(stream);
    session.cleanup();
    if (isAskFailure(collected)) return askFailureResponse(collected);
    return Response.json({ answer: collected });
  }

  // Keep the request abort listener until the producer finishes. The route
  // returns now; cleanup runs in the producer finally.
  void req;
  return new Response(stream, { headers: ndjsonHeaders() });
}

async function completeAnswer(
  context: AskContext,
  segments: StepAnswer["segments"],
  session: StreamSession,
): Promise<StepAnswer | AskFailure> {
  const aborted = session.stopped();
  if (aborted) return aborted;
  if (segments.length === 0) return invalidAnswer();

  let answer: StepAnswer;
  try {
    answer = stepAnswerSchema.parse({
      v: 1,
      id: context.answerId,
      stepId: context.body.stepId,
      question: context.body.question,
      selection: summarizeSelection(context.body.selection),
      segments,
      createdAt: new Date().toISOString(),
      imageAttached: context.imageUsed,
    });
  } catch {
    return invalidAnswer();
  }
  if (answer.id !== context.answerId || answer.stepId !== context.body.stepId || answer.question !== context.body.question) {
    return invalidAnswer();
  }
  try {
    assertNoRequestKey(answer, context);
  } catch (error) {
    if (error instanceof InvalidAnswerError) return invalidAnswer();
    throw error;
  }
  const resultEvent = { type: "result" as const, answer };
  if (Buffer.byteLength(JSON.stringify(resultEvent), "utf8") > EVENT_MAX_BYTES) return invalidAnswer();

  const again = await untilStop(reloadOwnership(context), session.combinedSignal, session.stopped);
  if (isAskFailure(again)) return again;
  if (!again.ok) return again.db ? upstreamFailure() : stepNotFoundFailure();

  const late = session.stopped();
  if (late) return late;

  if (serverKeyDisabled()) {
    return answer;
  }

  try {
    await prisma.$transaction(async (tx) => {
      if (session.stopped()) {
        throw Object.assign(new Error("ask-stop"), { askFailure: session.stopped()! });
      }
      const owned = await loadOwnership(context.body, context.byok);
      if (!owned.ok) {
        throw Object.assign(new Error("ask-own"), {
          askFailure: owned.db ? upstreamFailure() : stepNotFoundFailure(),
        });
      }
      if (session.stopped()) {
        throw Object.assign(new Error("ask-stop"), { askFailure: session.stopped()! });
      }
      await insertAnswer(tx, {
        id: answer.id,
        cacheKey: context.body.cacheKey,
        scriptVersion: context.body.scriptVersion,
        stepId: answer.stepId,
        payload: answer,
      });
      if (session.stopped()) {
        throw Object.assign(new Error("ask-stop"), { askFailure: session.stopped()! });
      }
    });
  } catch (error) {
    const tagged = error as { askFailure?: AskFailure };
    if (tagged?.askFailure) return tagged.askFailure;
    if (isAskFailure(error)) return error;
    console.warn("ask_route", JSON.stringify({ type: "insert_answer" }));
    return upstreamFailure();
  }
  return answer;
}

async function reloadOwnership(context: AskContext): Promise<CacheOwnership> {
  return loadOwnership(context.body, context.byok);
}

function assertNoRequestKey(value: unknown, context: AskContext) {
  // Same rule as lecture: only a request-sourced key is scanned. A hit is INVALID_ANSWER.
  if (context.keySource === "request" && JSON.stringify(value).includes(context.byok.apiKey)) {
    throw new InvalidAnswerError();
  }
}

function createStopTracker(
  requestSignal: AbortSignal,
  timeoutSignal: AbortSignal,
  combinedSignal: AbortSignal,
  generationAbort: AbortController,
) {
  let reason: StopReason | undefined;
  const record = (next: StopReason) => {
    if (!reason) reason = next;
  };
  // ReadableStream.cancel has no earlier request/timeout abort. Record it here
  // so the first-segment latch and the producer see the same CANCELLED reason.
  const recordClientCancel = () => record("cancelled");
  const onRequestAbort = () => record("cancelled");
  const onTimeoutAbort = () => record("timeout");
  const onCombinedAbort = () => {
    if (!generationAbort.signal.aborted) generationAbort.abort(combinedSignal.reason);
  };
  if (requestSignal.aborted) onRequestAbort();
  else requestSignal.addEventListener("abort", onRequestAbort, { once: true });
  if (timeoutSignal.aborted) onTimeoutAbort();
  else timeoutSignal.addEventListener("abort", onTimeoutAbort, { once: true });
  if (combinedSignal.aborted) onCombinedAbort();
  else combinedSignal.addEventListener("abort", onCombinedAbort, { once: true });
  return {
    reason: () => reason,
    recordClientCancel,
    detach: () => {
      requestSignal.removeEventListener("abort", onRequestAbort);
      timeoutSignal.removeEventListener("abort", onTimeoutAbort);
      combinedSignal.removeEventListener("abort", onCombinedAbort);
    },
  };
}

/** Race a blocking await against the recorded stop so the first-segment latch can settle. */
async function untilStop<T>(
  work: Promise<T>,
  signal: AbortSignal,
  stopped: () => AskFailure | undefined,
): Promise<T | AskFailure> {
  const early = stopped();
  if (early) return early;
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<AskFailure>(resolve => {
    onAbort = () => {
      const failure = stopped();
      resolve(failure ?? failureFromStop("cancelled"));
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  // A losing rejection must not surface as unhandled after the abort wins the race.
  const guarded = work.then(
    (value) => ({ settled: "value" as const, value }),
    (error: unknown) => ({ settled: "error" as const, error }),
  );
  try {
    const winner = await Promise.race([guarded, aborted]);
    if (isAskFailure(winner)) return winner;
    if (winner.settled === "error") {
      const failure = stopped();
      if (failure) return failure;
      throw winner.error;
    }
    return winner.value;
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

function abortWait(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function isAskFailure(value: unknown): value is AskFailure {
  return typeof value === "object" && value !== null && "status" in value && "error" in value && !("ok" in value);
}

async function collectJsonAnswer(stream: ReadableStream<Uint8Array>): Promise<StepAnswer | AskFailure> {
  const text = await new Response(stream).text();
  const lines = text.split("\n").filter(line => line.length > 0);
  const last = lines.at(-1);
  if (!last) return invalidAnswer();
  let event: { type?: string; answer?: StepAnswer; code?: string };
  try {
    event = JSON.parse(last) as { type?: string; answer?: StepAnswer; code?: string };
  } catch {
    return invalidAnswer();
  }
  if (event.type === "error") return failureFromCode(event.code ?? "UPSTREAM_ERROR");
  if (event.type === "result" && event.answer) return event.answer;
  return invalidAnswer();
}

function failureFromGeneration(result: Extract<AskGenerationResult, { ok: false }>): AskFailure {
  return failureFromCode(result.error);
}

function failureFromStop(reason: StopReason): AskFailure {
  return reason === "timeout"
    ? { status: 504, error: "TIMEOUT", message: TIMEOUT_MESSAGE, retryable: true }
    : { status: 499, error: "CANCELLED", message: CANCELLED_MESSAGE, retryable: false };
}

function failureFromCode(code: string): AskFailure {
  const known = streamErrorEvent(code);
  return {
    status: statusFor(known.code),
    error: known.code,
    message: messageFor(known.code),
    retryable: known.retryable,
  };
}

/** After the first segment, only the §6.4 late-error whitelist may leave the route. */
function lateFailure(failure: AskFailure): AskFailure {
  if (LATE_ERROR_CODES.has(failure.error)) return failure;
  return upstreamFailure();
}

function statusFor(code: string): number {
  switch (code) {
    case "UPSTREAM_AUTH": return 400;
    case "TIMEOUT": return 504;
    case "INVALID_ANSWER": return 422;
    case "CANCELLED": return 499;
    case "STEP_NOT_FOUND": return 409;
    default: return 502;
  }
}

function messageFor(code: string): string {
  switch (code) {
    case "UPSTREAM_AUTH": return "API Key 无效或没有权限";
    case "TIMEOUT": return TIMEOUT_MESSAGE;
    case "INVALID_ANSWER": return INVALID_ANSWER_MESSAGE;
    case "CANCELLED": return CANCELLED_MESSAGE;
    case "STEP_NOT_FOUND": return STEP_NOT_FOUND_MESSAGE;
    default: return AI_CONNECTION_ERROR;
  }
}

function ndjsonHeaders(): HeadersInit {
  return {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-store, no-transform",
    "X-Accel-Buffering": "no",
  };
}

function askFailureResponse(failure: AskFailure): Response {
  if (failure.error === "UPSTREAM_AUTH") return upstreamAuthError();
  if (failure.error === "UPSTREAM_ERROR") return upstreamError();
  if (failure.error === "STEP_NOT_FOUND") return stepNotFound();
  if (
    failure.error === "BAD_JSON" ||
    failure.error === "BAD_REQUEST" ||
    failure.error === "PAYLOAD_TOO_LARGE" ||
    failure.error === "CANCELLED"
  ) {
    return askError(failure.error, failure.status, failure.message);
  }
  return Response.json(
    { code: failure.error, error: failure.error, retryable: failure.retryable, message: failure.message },
    { status: failure.status },
  );
}

function stepNotFound(): Response {
  return Response.json(
    { code: "STEP_NOT_FOUND", error: "STEP_NOT_FOUND", retryable: false, message: STEP_NOT_FOUND_MESSAGE },
    { status: 409 },
  );
}

function stepNotFoundFailure(): AskFailure {
  return { status: 409, error: "STEP_NOT_FOUND", message: STEP_NOT_FOUND_MESSAGE, retryable: false };
}

function invalidAnswer(): AskFailure {
  return { status: 422, error: "INVALID_ANSWER", message: INVALID_ANSWER_MESSAGE, retryable: true };
}

function upstreamFailure(): AskFailure {
  return { status: 502, error: "UPSTREAM_ERROR", message: AI_CONNECTION_ERROR, retryable: true };
}

/**
 * Same formula as lecture cacheKeyOf. Kept private; the ask route only re-derives it.
 * apiKey is not part of the hash.
 */
function cacheKeyOf(slug: string, config: ByokConfig, solutionLanguage: string, narrationLanguage: string) {
  return createHash("sha1")
    .update(JSON.stringify([
      slug,
      config.provider,
      config.baseURL ?? "",
      config.model,
      solutionLanguage,
      narrationLanguage,
      "lecture",
    ]))
    .digest("hex");
}

async function loadOwnership(body: AskBody, byok: ByokConfig): Promise<CacheOwnership> {
  let cached: { script: string } | null;
  try {
    cached = await prisma.lectureScriptCache.findUnique({ where: { key: body.cacheKey } });
  } catch {
    return { ok: false, db: true };
  }
  if (!cached) return { ok: false, db: false };

  let raw: unknown;
  try {
    raw = JSON.parse(cached.script);
  } catch {
    return { ok: false, db: false };
  }
  const language = readSolutionLanguage(raw);

  let referenceCode: string;
  try {
    const detail = await localSeedSource.detail(body.problemSlug);
    referenceCode =
      detail.referenceSolutions?.find(solution => solution.language === language)?.code ??
      detail.referenceSolutions?.[0]?.code ??
      "";
  } catch {
    return { ok: false, db: false };
  }

  let script: TeachingScript;
  try {
    script = validateScript(raw, referenceCode, { stepIds: "lenient" });
  } catch {
    return { ok: false, db: false };
  }
  const version = scriptVersion(script);
  const validStepIds = askableStepIds(script);
  // Map.has is the membership check. Object.prototype names are ordinary step ids.
  if (
    script.problemSlug !== body.problemSlug ||
    script.mode !== "lecture" ||
    version !== body.scriptVersion ||
    !validStepIds.has(body.stepId)
  ) {
    return { ok: false, db: false };
  }
  const derived = cacheKeyOf(body.problemSlug, byok, script.solutionLanguage, script.language);
  if (derived !== body.cacheKey) return { ok: false, db: false };
  const stepsById = new Map(script.steps.map(item => [item.id, item]));
  const step = stepsById.get(body.stepId);
  if (!step) return { ok: false, db: false };
  return { ok: true, script, step, referenceCode, version };
}

function readSolutionLanguage(raw: unknown): "typescript" | "python" {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "typescript";
  const value = (raw as { solutionLanguage?: unknown }).solutionLanguage;
  return value === "python" ? "python" : "typescript";
}
