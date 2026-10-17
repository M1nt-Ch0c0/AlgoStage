/**
 * Ask fetch runtime. One in-flight request per token.
 * Stale generations, identity mismatches, and disposed runtimes drop results.
 */
import { ASK_TIMEOUT_MS } from "@/lib/agent/defaults";
import {
  CAPTURE_DEFAULTS,
  decodedBase64Bytes,
  type CaptureResult,
} from "@/lib/ask/capture";
import { markAskPhase, markAskTiming } from "@/lib/ask/ask-timing";
import { resolveAskError } from "@/lib/ask/ask-errors";
import { readAskResponse } from "@/lib/ask/ask-response";
import { answersStorageKey, writeBrowserAnswers } from "@/lib/ask/answers-storage";
import { askSelectionSchema } from "@/lib/ask/schema";
import { ASK_LIMITS } from "@/lib/ask/types";
import { fetchServerKeyDisabled, withByok } from "@/lib/byok/client";
import { readLocalByok } from "@/lib/byok/storage";
import {
  isStale,
  selectAskAvailability,
  usePlayerStore,
  type AskRequestGuard,
} from "@/lib/player/store";
import { apiPath } from "@/lib/runtime";

type PlayerSnapshot = ReturnType<typeof usePlayerStore.getState>;

interface AskRuntime {
  controller: AbortController;
  guard: AskRequestGuard;
  foreground: boolean;
  timer: ReturnType<typeof setTimeout>;
  userCancel: boolean;
  settled: boolean;
}

const runtimes = new Map<number, AskRuntime>();
let nextToken = 1;

function runtimeAlive(token: number): AskRuntime | undefined {
  const runtime = runtimes.get(token);
  if (!runtime || runtime.settled) return undefined;
  return runtime;
}

/**
 * A request is stale when the player generation/script moved, the lecture
 * identity no longer matches the guard, or this token's runtime is gone.
 */
export function isAskStale(state: PlayerSnapshot, guard: AskRequestGuard): boolean {
  if (isStale(state, guard)) return true;
  if (guard.cacheKey !== state.answerMeta.cacheKey) return true;
  if (guard.scriptVersion !== state.answerMeta.scriptVersion) return true;
  const runtime = runtimes.get(guard.token);
  if (!runtime || runtime.settled) return true;
  return false;
}

function selectionImage(
  capture: CaptureResult | null,
): { mime: "image/webp" | "image/jpeg"; dataBase64: string } | null {
  if (!capture?.ok) return null;
  if (decodedBase64Bytes(capture.image.dataBase64) > CAPTURE_DEFAULTS.maxBytes) return null;
  return capture.image;
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

export interface SendAskOptions {
  /** False when the panel session that started this send is gone. */
  isCurrent?: () => boolean;
  /**
   * Called at the instant the ask fetch is issued, with performance.now().
   * The value is a timing mark. The panel's cancel decision is the 取消 hit
   * flag, not this clock.
   */
  onFetch?: (sentAt: number) => void;
}

/**
 * Drop a request the panel abandoned before fetch. Same phase reset as cancelAsk
 * when askSent already moved the player into sending.
 */
function abandonBeforeFetch(token: number | null): void {
  if (token == null) return;
  const runtime = runtimes.get(token);
  if (!runtime || runtime.settled) return;
  runtime.userCancel = true;
  runtime.settled = true;
  clearTimeout(runtime.timer);
  runtime.controller.abort();
  runtimes.delete(token);
  usePlayerStore.getState().askCancelled(runtime.guard);
}

/**
 * Drop a runtime that never reached askSent. The waiting row must not appear
 * for a cancel decided before the fetch is committed, and askPhase stays put.
 */
function disposeRuntimeBeforeAskSent(token: number): void {
  const runtime = runtimes.get(token);
  if (!runtime || runtime.settled) return;
  runtime.userCancel = true;
  runtime.settled = true;
  clearTimeout(runtime.timer);
  runtime.controller.abort();
  runtimes.delete(token);
}

/**
 * Send the current draft. Returns without throwing when the phase, availability,
 * draft, or selection cannot be sent. In-flight work is tracked until settle.
 * The waiting row must not appear before the final cancel decision. Never-send
 * means no fetch. options.isCurrent is checked after the byok / server-key
 * await and before askSent, and again immediately before fetch.
 */
export async function sendAsk(
  capture: CaptureResult | null,
  options?: SendAskOptions,
): Promise<void> {
  const state = usePlayerStore.getState();
  if (
    state.askPhase === "sending" ||
    state.askPhase === "streaming" ||
    state.askPhase === "playing"
  ) {
    return;
  }
  if (state.askPhase !== "drafting" && state.askPhase !== "error") return;
  if (state.answerMeta.storageMode === "pending") return;
  if (selectAskAvailability(state).disabled) return;

  const step = state.steps[state.currentIndex];
  const targets = state.selection?.targets;
  const question = state.draftQuestion.trim();
  if (!step) return;
  if (!targets || targets.length === 0) return;
  if (question.length < 1 || question.length > ASK_LIMITS.questionMax) return;
  if (state.draftStepId !== step.id) return;
  const problemSlug = state.script?.problemSlug;
  const { cacheKey, scriptVersion } = state.answerMeta;
  if (!problemSlug || !cacheKey || !scriptVersion) return;

  const preFetchStarted = typeof performance !== "undefined" ? performance.now() : Date.now();
  const selection = {
    stepId: step.id,
    mode: state.selection!.mode,
    bbox: state.selection!.bbox,
    targets,
    question,
  };
  if (!askSelectionSchema.safeParse(selection).success) return;
  if (options?.isCurrent && !options.isCurrent()) return;

  const token = nextToken++;
  const guard: AskRequestGuard = {
    generation: state.generation,
    problemSlug,
    cacheKey,
    scriptVersion,
    stepId: step.id,
    token,
  };
  const controller = new AbortController();
  const runtime: AskRuntime = {
    controller,
    guard,
    foreground: true,
    timer: setTimeout(() => {
      const current = runtimes.get(token);
      if (!current || current.settled || current.userCancel) return;
      current.controller.abort();
    }, ASK_TIMEOUT_MS + 5000),
    userCancel: false,
    settled: false,
  };
  runtimes.set(token, runtime);

  const image = selectionImage(capture);

  try {
    const localByok = readLocalByok();
    const serverKeyDisabled = localByok
      ? await fetchServerKeyDisabled(controller.signal)
      : false;
    // Final cancel decision before the waiting row. askSent has not run, so
    // a stale session disposes the runtime and does not call askCancelled.
    if (options?.isCurrent && !options.isCurrent()) {
      disposeRuntimeBeforeAskSent(token);
      return;
    }
    usePlayerStore.getState().askSent(guard);
    // A cancel that lands in the turn askSent just opened still must not fetch.
    if (options?.isCurrent && !options.isCurrent()) {
      abandonBeforeFetch(token);
      return;
    }
    const body = withByok(
      {
        problemSlug,
        cacheKey,
        scriptVersion,
        stepId: step.id,
        question,
        selection,
        image,
      },
      serverKeyDisabled,
      localByok,
    );
    const sentAt =
      typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
    markAskTiming("sentAt", sentAt);
    markAskPhase("preFetchMs", sentAt - preFetchStarted);
    options?.onFetch?.(sentAt);
    const res = await fetch(apiPath("/api/lecture/ask"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/x-ndjson",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    // Status-only failures (401 HTML, empty 403) have no error code. Hand the
    // Response to resolveAskError so 401 → settings, and do not keep the body.
    if (!res.ok) {
      const peeked: unknown = await res.clone().json().catch(() => null);
      const record = peeked !== null && typeof peeked === "object" ? (peeked as Record<string, unknown>) : null;
      const rawCode = record?.code ?? record?.error;
      if (typeof rawCode !== "string" || rawCode.trim() === "") throw res;
    }
    const answer = await readAskResponse(
      res,
      {
        onStart: (start) => {
          if (!runtimeAlive(token)) return;
          usePlayerStore.getState().askStarted(start.answerId, guard);
        },
        onSegment: (segment) => {
          if (!runtimeAlive(token)) return;
          usePlayerStore.getState().answerSegmentArrived(segment, guard);
        },
      },
      { signal: controller.signal },
    );

    const latest = usePlayerStore.getState();
    const current = runtimes.get(token);
    if (
      current &&
      !current.settled &&
      !current.userCancel &&
      !isAskStale(latest, guard) &&
      answer.stepId === guard.stepId
    ) {
      latest.answerArrived(answer, guard);
      const after = usePlayerStore.getState();
      if (after.answerMeta.storageMode === "browser") {
        writeBrowserAnswers(after.answerMeta.cacheKey, after.answerMeta.scriptVersion, after.answers);
      }
    }
  } catch (err) {
    const current = runtimes.get(token);
    if (!current || current.settled || current.userCancel) return;
    const timedOut = !current.userCancel && (isAbortError(err) || current.controller.signal.aborted);
    const view = timedOut ? resolveAskError({ code: "TIMEOUT" }) : resolveAskError(err);
    if (view.action === "none" && view.code === "CANCELLED") return;
    usePlayerStore.getState().answerFailed(view.code, view.retryable, guard);
  } finally {
    const current = runtimes.get(token);
    if (current) {
      clearTimeout(current.timer);
      current.settled = true;
    }
    runtimes.delete(token);
  }
}

/**
 * Abort the foreground request and drop anything it already streamed or stored.
 * A press that hit 取消 and released on the button after the fetch must leave
 * no answer, no preview text, no error, and no history or browser-cache row.
 */
export function retroCancelAsk(): void {
  const token = usePlayerStore.getState().askContext?.token;
  let runtime: AskRuntime | undefined;
  if (token != null) runtime = runtimes.get(token);
  if (!runtime || runtime.settled) {
    for (const candidate of runtimes.values()) {
      if (candidate.foreground && !candidate.settled) {
        runtime = candidate;
        break;
      }
    }
  }
  if (runtime && !runtime.settled) {
    runtime.userCancel = true;
    runtime.settled = true;
    clearTimeout(runtime.timer);
    runtime.controller.abort();
    runtimes.delete(runtime.guard.token);
  }
  usePlayerStore.getState().retroCancelAsk();
  const after = usePlayerStore.getState();
  if (after.answerMeta.storageMode !== "browser") return;
  const { cacheKey, scriptVersion } = after.answerMeta;
  if (!cacheKey || !scriptVersion) return;
  const hasAny = Object.values(after.answers).some((list) => list.length > 0);
  if (!hasAny) {
    try {
      window.localStorage.removeItem(answersStorageKey(cacheKey, scriptVersion));
    } catch {
      // Storage can be unavailable. The in-memory map is already clear.
    }
    return;
  }
  writeBrowserAnswers(cacheKey, scriptVersion, after.answers);
}

/** Abort the foreground request for the current ask token. */
export function cancelAsk(): void {
  const token = usePlayerStore.getState().askContext?.token;
  let runtime: AskRuntime | undefined;
  if (token != null) runtime = runtimes.get(token);
  if (!runtime || runtime.settled) {
    for (const candidate of runtimes.values()) {
      if (candidate.foreground && !candidate.settled) {
        runtime = candidate;
        break;
      }
    }
  }
  if (!runtime || runtime.settled) return;
  runtime.userCancel = true;
  usePlayerStore.getState().askCancelled(runtime.guard);
  runtime.controller.abort();
}

/** Drop every in-flight ask. Does not surface a failure to the player. */
export function disposeAskRequests(): void {
  for (const [token, runtime] of runtimes) {
    runtime.userCancel = true;
    runtime.settled = true;
    clearTimeout(runtime.timer);
    runtime.controller.abort();
    runtimes.delete(token);
  }
}
