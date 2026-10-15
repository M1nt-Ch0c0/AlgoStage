// @vitest-environment happy-dom
/**
 * ask-client runtime: NDJSON happy path, cancel, deadline, capture, background, dispose.
 * Feeds real Response bodies so readAskResponse runs.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ASK_TIMEOUT_MS } from "@/lib/agent/defaults";
import { answersStorageKey } from "@/lib/ask/answers-storage";
import { cancelAsk, disposeAskRequests, sendAsk } from "@/lib/ask/ask-client";
import { CAPTURE_DEFAULTS, type CaptureResult } from "@/lib/ask/capture";
import { ASK_ERROR_SPECS } from "@/lib/ask/ask-errors";
import type { AnswerSegment, AskSelectionSummary, StepAnswer } from "@/lib/ask/types";
import { resetServerKeyDisabledCache } from "@/lib/byok/client";
import { BYOK_STORAGE_KEY } from "@/lib/byok/storage";
import { usePlayerStore, type LectureAnswerMeta } from "@/lib/player/store";
import type { TeachingScript, TeachingStep } from "@/lib/teaching/types";

const step1: TeachingStep = { id: "s1", narration: "第一步", targets: [], effects: [] };
const step2: TeachingStep = { id: "s2", narration: "第二步", targets: [], effects: [] };

const script: TeachingScript = {
  problemSlug: "3sum",
  mode: "lecture",
  language: "zh",
  solutionLanguage: "typescript",
  steps: [step1, step2],
};

const selection: AskSelectionSummary = {
  mode: "single",
  bbox: { x: 0, y: 0, width: 10, height: 10 },
  targets: [{ kind: "subtitle", id: "sub-1", text: "第一步" }],
};

const QUESTION = "为什么这样移动指针";

const s = () => usePlayerStore.getState();

function meta(storageMode: LectureAnswerMeta["storageMode"]): LectureAnswerMeta {
  return {
    cacheKey: "ck-1",
    scriptVersion: "v1",
    askDisabledStepIds: [],
    storageMode,
  };
}

function segment(id = "seg-a", narration = "这一段解释指针。"): AnswerSegment {
  return { id, narration };
}

function answer(overrides: Partial<StepAnswer> = {}, segments: AnswerSegment[] = [segment()]): StepAnswer {
  return {
    v: 1,
    id: "ans-1",
    stepId: "s1",
    question: QUESTION,
    selection,
    segments,
    createdAt: "2026-10-13T11:00:00.000Z",
    ...overrides,
  };
}

function startLine(extra: Record<string, unknown> = {}) {
  return JSON.stringify({ type: "start", answerId: "ans-1", stepId: "s1", imageUsed: false, ...extra });
}

function segmentLine(item: AnswerSegment = segment()) {
  return JSON.stringify({ type: "segment", segment: item });
}

function resultLine(value: StepAnswer = answer()) {
  return JSON.stringify({ type: "result", answer: value });
}

function ndjson(...lines: string[]) {
  return `${lines.join("\n")}\n`;
}

const ndjsonHeaders = { "Content-Type": "application/x-ndjson; charset=utf-8" };

function responseOf(text: string, init: ResponseInit = {}) {
  return new Response(text, {
    headers: { ...ndjsonHeaders, ...init.headers },
    status: init.status ?? 200,
  });
}

function loadReady(storageMode: LectureAnswerMeta["storageMode"] = "server") {
  s().loadScript(script);
  s().setLectureAnswerMeta(meta(storageMode));
  s().setAnswers(Object.create(null));
  usePlayerStore.setState({ answersReady: true });
}

function enterDrafting(question = QUESTION) {
  s().enterAsk();
  s().setAskSelection(selection);
  s().setAskQuestion(question);
}

function happyBody(value: StepAnswer = answer()) {
  return ndjson(startLine({ answerId: value.id, stepId: value.stepId }), segmentLine(value.segments[0]!), resultLine(value));
}

/** Hang until the request is aborted so the deadline timer can fire. */
function hangingResponse() {
  const body = new ReadableStream<Uint8Array>({
    start() {
      /* never enqueue or close */
    },
  });
  return new Response(body, { headers: ndjsonHeaders, status: 200 });
}

function postedBody(fetchMock: ReturnType<typeof vi.fn>, call = 0): Record<string, unknown> {
  const askCalls = fetchMock.mock.calls.filter((item) => String(item[0]).includes("/api/lecture/ask"));
  const init = askCalls[call]?.[1] as RequestInit | undefined;
  return JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
}

function askCallCount(fetchMock: ReturnType<typeof vi.fn>): number {
  return fetchMock.mock.calls.filter((item) => String(item[0]).includes("/api/lecture/ask")).length;
}

/** Ask body is the POST whose URL is /api/lecture/ask, not the settings probe. */
function askPost(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const call = fetchMock.mock.calls.find((item) => String(item[0]).includes("/api/lecture/ask"));
  const init = call?.[1] as RequestInit | undefined;
  return JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
}

const settingsResponse = (serverKeyDisabled: boolean) =>
  new Response(JSON.stringify({ settings: {}, keySource: serverKeyDisabled ? "none" : "env", envConfigured: !serverKeyDisabled, serverKeyDisabled }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

/**
 * sendAsk probes /api/settings only when a local key is stored.
 * Pass serverKeyDisabled when the case writes one; otherwise the probe is not called.
 */
function installFetch(
  impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> | Response,
  serverKeyDisabled?: boolean,
) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes("/api/settings")) {
      return settingsResponse(serverKeyDisabled === true);
    }
    return impl(input, init);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  resetServerKeyDisabledCache();
  window.localStorage.clear();
});

afterEach(() => {
  disposeAskRequests();
  s().reset();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
  resetServerKeyDisabledCache();
});

describe("sendAsk happy path", () => {
  test("NDJSON start/segment/result appends the answer and enters playing", async () => {
    loadReady("browser");
    enterDrafting();
    const value = answer();
    const fetchMock = installFetch(async () => responseOf(happyBody(value)));

    await sendAsk(null);

    expect(askCallCount(fetchMock)).toBe(1);
    const askCall = fetchMock.mock.calls.find((item) => String(item[0]).includes("/api/lecture/ask"));
    const [url, init] = askCall as unknown as [string, RequestInit];
    expect(url).toBe("/api/lecture/ask");
    expect(init.method).toBe("POST");
    expect(s().askPhase).toBe("playing");
    expect(s().answers.s1).toEqual([value]);
    expect(s().askErrorCode).toBeNull();
    const stored = window.localStorage.getItem(answersStorageKey("ck-1", "v1"));
    expect(stored).toContain(value.id);
  });

  test("server storage appends the answer and does not write browser answers", async () => {
    loadReady("server");
    enterDrafting();
    const value = answer();
    installFetch(async () => responseOf(happyBody(value)));

    await sendAsk(null);

    expect(s().askPhase).toBe("playing");
    expect(s().answers.s1?.map((item) => item.id)).toEqual([value.id]);
    expect(window.localStorage.getItem(answersStorageKey("ck-1", "v1"))).toBeNull();
  });
});

describe("cancelAsk", () => {
  test("mid-stream cancel returns to drafting, adds no answer, and does not set an error", async () => {
    loadReady("browser");
    enterDrafting();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode(`${startLine()}\n${segmentLine()}\n`));
        await gate;
        controller.enqueue(encoder.encode(`${resultLine()}\n`));
        controller.close();
      },
    });
    installFetch(async () => new Response(body, { headers: ndjsonHeaders }));

    const pending = sendAsk(null);
    await vi.waitFor(() => {
      expect(s().askPhase).toBe("streaming");
    });
    const answersBefore = s().answers.s1?.length ?? 0;

    cancelAsk();
    release?.();
    await pending;

    expect(s().askPhase).toBe("drafting");
    expect(s().answers.s1?.length ?? 0).toBe(answersBefore);
    expect(s().askErrorCode).toBeNull();
    expect(s().draftQuestion).toBe(QUESTION);
    expect(window.localStorage.getItem(answersStorageKey("ck-1", "v1"))).toBeNull();
  });

  test("cancelAsk when askContext has no token falls back to scanning foreground runtime", async () => {
    loadReady("browser");
    enterDrafting();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode(`${startLine()}\n${segmentLine()}\n`));
        await gate;
        controller.enqueue(encoder.encode(`${resultLine()}\n`));
        controller.close();
      },
    });
    installFetch(async () => new Response(body, { headers: ndjsonHeaders }));

    const pending = sendAsk(null);
    await vi.waitFor(() => {
      expect(s().askPhase).toBe("streaming");
    });
    const answersBefore = s().answers.s1?.length ?? 0;
    const ctx = s().askContext;
    expect(ctx).not.toBeNull();
    usePlayerStore.setState({
      askContext: { ...ctx!, token: null },
    });

    cancelAsk();
    release?.();
    await pending;

    expect(s().answers.s1?.length ?? 0).toBe(answersBefore);
    expect(s().askErrorCode).toBeNull();
  });
});

describe("timeout", () => {
  test("fake timers: deadline abort becomes TIMEOUT via answerFailed", async () => {
    vi.useFakeTimers();
    loadReady("server");
    enterDrafting();
    installFetch(async () => hangingResponse());

    const pending = sendAsk(null);
    await vi.waitFor(() => {
      expect(s().askPhase).toBe("sending");
    });

    await vi.advanceTimersByTimeAsync(ASK_TIMEOUT_MS + 5000);
    await pending;

    expect(s().askPhase).toBe("error");
    expect(s().askErrorCode).toBe("TIMEOUT");
    expect(s().askErrorRetryable).toBe(ASK_ERROR_SPECS.TIMEOUT?.retryable);
    expect(s().answers.s1).toBeUndefined();
  });
});

describe("capture image", () => {
  test("ok:false still posts with image null", async () => {
    loadReady("server");
    enterDrafting();
    const fetchMock = installFetch(async () => responseOf(happyBody()));
    const capture: CaptureResult = { ok: false, reason: "RENDER_FAILED", fallbackText: "没截到图" };

    await sendAsk(capture);

    expect(askCallCount(fetchMock)).toBe(1);
    expect(postedBody(fetchMock).image).toBeNull();
    expect(s().askPhase).toBe("playing");
  });

  test("oversize decoded bytes still posts with image null", async () => {
    loadReady("server");
    enterDrafting();
    const fetchMock = installFetch(async () => responseOf(happyBody()));
    // decodedBase64Bytes is floor(len * 3 / 4), so the string must be longer than the byte cap.
    const oversize = "A".repeat(Math.ceil(((CAPTURE_DEFAULTS.maxBytes + 1) * 4) / 3));
    const capture: CaptureResult = {
      ok: true,
      encoder: "main",
      image: { mime: "image/webp", dataBase64: oversize },
      bytes: CAPTURE_DEFAULTS.maxBytes + 1,
    };

    await sendAsk(capture);

    expect(postedBody(fetchMock).image).toBeNull();
    expect(s().answers.s1).toHaveLength(1);
  });

  test("ok:true under maxBytes posts with image payload", async () => {
    loadReady("server");
    enterDrafting();
    const fetchMock = installFetch(async () => responseOf(happyBody()));
    const capture: CaptureResult = {
      ok: true,
      encoder: "main",
      image: { mime: "image/webp", dataBase64: "AAAA" },
      bytes: 3,
    };

    await sendAsk(capture);

    expect(askCallCount(fetchMock)).toBe(1);
    expect(postedBody(fetchMock).image).toEqual({ mime: "image/webp", dataBase64: "AAAA" });
    expect(s().askPhase).toBe("playing");
  });
});

describe("background persist", () => {
  test("goto away still appends the answer and does not enter playing", async () => {
    loadReady("server");
    enterDrafting();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const encoder = new TextEncoder();
    const value = answer();
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode(`${startLine()}\n${segmentLine()}\n`));
        await gate;
        controller.enqueue(encoder.encode(`${resultLine(value)}\n`));
        controller.close();
      },
    });
    installFetch(async () => new Response(body, { headers: ndjsonHeaders }));

    const pending = sendAsk(null);
    await vi.waitFor(() => {
      expect(s().askPhase).toBe("streaming");
    });

    s().goto(1);
    expect(s().askPhase).toBe("idle");
    expect(s().currentIndex).toBe(1);

    release?.();
    await pending;

    expect(s().askPhase).toBe("idle");
    expect(s().answers.s1).toEqual([value]);
    expect(s().askErrorCode).toBeNull();
  });
});

describe("disposeAskRequests", () => {
  test("dispose drops a late result so answerArrived never appends", async () => {
    loadReady("browser");
    enterDrafting();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode(`${startLine()}\n`));
        await gate;
        controller.enqueue(encoder.encode(`${segmentLine()}\n${resultLine()}\n`));
        controller.close();
      },
    });
    installFetch(async () => new Response(body, { headers: ndjsonHeaders }));

    const pending = sendAsk(null);
    await vi.waitFor(() => {
      expect(s().askPhase).toBe("streaming");
    });

    disposeAskRequests();
    release?.();
    await pending;

    expect(s().answers.s1).toBeUndefined();
    expect(s().askErrorCode).toBeNull();
    expect(window.localStorage.getItem(answersStorageKey("ck-1", "v1"))).toBeNull();
  });
});

describe("isCurrent session guard", () => {
  test("isCurrent false before any mutation does not fetch and leaves the phase", async () => {
    loadReady("server");
    enterDrafting();
    const fetchMock = installFetch(async () => responseOf(happyBody()));

    await sendAsk(null, { isCurrent: () => false });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(s().askPhase).toBe("drafting");
    expect(s().askStartedAt).toBeNull();
  });

  test("isCurrent flipping false during the server-key await does not fetch", async () => {
    loadReady("server");
    enterDrafting();
    window.localStorage.setItem(BYOK_STORAGE_KEY, JSON.stringify({ apiKey: "sk-fake-e2e-0000" }));
    let current = true;
    let releaseSettings: (() => void) | undefined;
    const settingsGate = new Promise<void>((resolve) => {
      releaseSettings = resolve;
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/api/settings")) {
        await settingsGate;
        return settingsResponse(true);
      }
      return responseOf(happyBody());
    });
    vi.stubGlobal("fetch", fetchMock);

    const pending = sendAsk(null, {
      isCurrent: () => current,
    });
    await vi.waitFor(() => {
      expect(s().askPhase).toBe("sending");
    });
    expect(askCallCount(fetchMock)).toBe(0);

    current = false;
    releaseSettings?.();
    await pending;

    expect(askCallCount(fetchMock)).toBe(0);
    expect(s().askPhase).toBe("drafting");
    expect(s().askErrorCode).toBeNull();
    expect(s().askStartedAt).toBeNull();
  });
});

describe("in-flight guard", () => {
  test("a second sendAsk while sending starts only one fetch", async () => {
    loadReady("server");
    enterDrafting();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const encoder = new TextEncoder();
    const fetchMock = installFetch(async () => {
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(encoder.encode(`${startLine()}\n${segmentLine()}\n`));
          await gate;
          controller.enqueue(encoder.encode(`${resultLine()}\n`));
          controller.close();
        },
      });
      return new Response(body, { headers: ndjsonHeaders });
    });

    const first = sendAsk(null);
    await vi.waitFor(() => {
      expect(s().askPhase).toBe("streaming");
    });
    const second = sendAsk(null);
    await second;
    expect(askCallCount(fetchMock)).toBe(1);

    release?.();
    await first;
    expect(askCallCount(fetchMock)).toBe(1);
    expect(s().answers.s1).toHaveLength(1);
  });
});

describe("HTTP errors", () => {
  test("401 is mapped by resolveAskError to settings and the raw body is not stored", async () => {
    loadReady("server");
    enterDrafting();
    const secret = "<html>provider token sk-live-secret</html>";
    installFetch(async () => new Response(secret, { status: 401, headers: { "Content-Type": "text/html" } }));

    await sendAsk(null);

    expect(s().askPhase).toBe("error");
    expect(s().askErrorCode).toBe("UPSTREAM_AUTH");
    expect(s().askErrorRetryable).toBe(false);
    expect(ASK_ERROR_SPECS.UPSTREAM_AUTH?.action).toBe("settings");
    const snapshot = JSON.stringify(s());
    expect(snapshot).not.toContain(secret);
    expect(snapshot).not.toContain("sk-live-secret");
    expect(snapshot).not.toContain("<html>");
    expect(s().answers.s1).toBeUndefined();
  });
});

describe("public instance BYOK", () => {
  const fakeKey = "sk-fake-e2e-0000";

  test("serverKeyDisabled=true and a local key puts byok on the ask body", async () => {
    loadReady("server");
    enterDrafting();
    window.localStorage.setItem(
      BYOK_STORAGE_KEY,
      JSON.stringify({ apiKey: fakeKey, baseURL: "https://api.example.com/v1", model: "fake-model" }),
    );
    const fetchMock = installFetch(async () => responseOf(happyBody()), true);

    await sendAsk(null);

    expect(askPost(fetchMock).byok).toEqual({
      apiKey: fakeKey,
      baseURL: "https://api.example.com/v1",
      model: "fake-model",
    });
    expect(s().askPhase).toBe("playing");
  });

  test("serverKeyDisabled=false omits byok even when a local key is stored", async () => {
    loadReady("server");
    enterDrafting();
    window.localStorage.setItem(BYOK_STORAGE_KEY, JSON.stringify({ apiKey: fakeKey }));
    const fetchMock = installFetch(async () => responseOf(happyBody()), false);

    await sendAsk(null);

    expect(askPost(fetchMock)).not.toHaveProperty("byok");
    expect(s().askPhase).toBe("playing");
  });

  test("no local key skips the settings probe and posts without byok", async () => {
    loadReady("server");
    enterDrafting();
    const fetchMock = installFetch(async () => responseOf(happyBody()));

    await sendAsk(null);

    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("/api/settings"))).toBe(false);
    expect(askPost(fetchMock)).not.toHaveProperty("byok");
    expect(s().askPhase).toBe("playing");
  });
});
