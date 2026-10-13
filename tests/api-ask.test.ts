import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import type { LookupAddress, LookupAllOptions } from "node:dns";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { AI_CONNECTION_ERROR } from "@/lib/ai/egress-guard";
import {
  ASK_BODY_MAX_BYTES,
  askError,
  readAskBody,
} from "@/lib/agent/request";
import type { AskGenerationResult } from "@/lib/agent/ask-generation";
import type { ByokConfig } from "@/lib/agent/provider";
import { resetAskControlForTests } from "@/lib/ask/ask-control";
import { scriptVersion } from "@/lib/ask/script-version";
import type { AnswerSegment, StepAnswer } from "@/lib/ask/types";
import { validateScript } from "@/lib/teaching/validated-script";
import { createFixture } from "./api-fixture";

async function bodyOf(response: Response) {
  return response.json() as Promise<{ code: string; error: string; retryable: boolean; message: string }>;
}

function streamOf(chunks: Uint8Array[], hooks?: { cancel?: () => void; pull?: () => void }) {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      hooks?.pull?.();
      const next = chunks[index];
      index += 1;
      if (!next) controller.close();
      else controller.enqueue(next);
    },
    cancel() {
      hooks?.cancel?.();
    },
  });
}

function requestWith(body: BodyInit | null, headers?: HeadersInit, signal?: AbortSignal) {
  return new Request("http://localhost/api/lecture/ask", {
    method: "POST",
    body,
    headers,
    signal,
    duplex: "half",
  } as RequestInit);
}

test("8. content-length 超限直接 413 且取消 body；非法/负 length 为 BAD_REQUEST", async () => {
  let cancelled = false;
  let pulled = false;
  const oversized = requestWith(streamOf([new Uint8Array([1])], {
    cancel: () => { cancelled = true; },
    pull: () => { pulled = true; },
  }), { "content-length": String(ASK_BODY_MAX_BYTES + 1) });
  const tooBig = await readAskBody(oversized);
  expect(tooBig.ok).toBe(false);
  if (!tooBig.ok) {
    expect(tooBig.response.status).toBe(413);
    expect(await bodyOf(tooBig.response)).toEqual({
      code: "PAYLOAD_TOO_LARGE",
      error: "PAYLOAD_TOO_LARGE",
      retryable: false,
      message: "请求过大，请移除截图后重新提问。",
    });
  }
  expect(cancelled).toBe(true);
  expect(pulled).toBe(false);

  const hugeHeader = requestWith("{}", { "content-length": String(2n ** 80n) });
  const huge = await readAskBody(hugeHeader);
  expect(huge.ok).toBe(false);
  if (!huge.ok) expect(huge.response.status).toBe(413);

  for (const length of ["-1", "12.0", "1e2", "+5", "01", "", "abc"]) {
    const bad = await readAskBody(requestWith("{}", { "content-length": length }));
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.response.status).toBe(400);
      const body = await bodyOf(bad.response);
      expect(body.code).toBe("BAD_REQUEST");
      expect(body.retryable).toBe(false);
    }
  }

  const headerOnly = await readAskBody(new Request("http://localhost/api/lecture/ask", {
    method: "GET",
    headers: { "content-length": String(ASK_BODY_MAX_BYTES + 1) },
  }));
  expect(headerOnly.ok).toBe(false);
  if (!headerOnly.ok) expect(headerOnly.response.status).toBe(413);

  let shortCancelled = false;
  let shortPulled = 0;
  const lying = requestWith(new ReadableStream<Uint8Array>({
    start(controller) {
      shortPulled += 1;
      controller.enqueue(new Uint8Array(100));
      controller.enqueue(new Uint8Array(ASK_BODY_MAX_BYTES));
    },
    cancel() { shortCancelled = true; },
  }), { "content-length": "1" });
  const lied = await readAskBody(lying);
  expect(lied.ok).toBe(false);
  if (!lied.ok) expect(lied.response.status).toBe(413);
  expect(shortCancelled).toBe(true);
  expect(shortPulled).toBe(1);

  let missingCancelled = false;
  const chunked = requestWith(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("x".repeat(100)));
      controller.enqueue(new TextEncoder().encode("y".repeat(ASK_BODY_MAX_BYTES)));
    },
    cancel() { missingCancelled = true; },
  }));
  expect(chunked.headers.get("content-length")).toBeNull();
  const missing = await readAskBody(chunked);
  expect(missing.ok).toBe(false);
  if (!missing.ok) expect(missing.response.status).toBe(413);
  expect(missingCancelled).toBe(true);
});

test("9. 恰 786432 字节通过，多一字节 413；按字节计而不是 string.length", async () => {
  const han = "测";
  expect(Buffer.byteLength(han)).toBe(3);
  const prefix = '{"q":"';
  const suffix = 'a"}';
  const overhead = Buffer.byteLength(prefix + suffix);
  const hanCount = (ASK_BODY_MAX_BYTES - overhead) / Buffer.byteLength(han);
  expect(Number.isInteger(hanCount)).toBe(true);
  const exactText = prefix + han.repeat(hanCount) + suffix;
  expect(Buffer.byteLength(exactText)).toBe(ASK_BODY_MAX_BYTES);
  expect(exactText.length).toBeLessThan(ASK_BODY_MAX_BYTES);

  const exact = await readAskBody(requestWith(exactText));
  expect(exact.ok).toBe(true);
  if (exact.ok) {
    expect(exact.text).toBe(exactText);
    expect(Buffer.byteLength(exact.text)).toBe(ASK_BODY_MAX_BYTES);
  }

  const overText = exactText + "b";
  expect(Buffer.byteLength(overText)).toBe(ASK_BODY_MAX_BYTES + 1);
  const over = await readAskBody(requestWith(overText));
  expect(over.ok).toBe(false);
  if (!over.ok) expect(over.response.status).toBe(413);

  const declaredExact = await readAskBody(requestWith(exactText, { "content-length": String(ASK_BODY_MAX_BYTES) }));
  expect(declaredExact.ok).toBe(true);

  const encoded = new TextEncoder().encode(exactText);
  const mid = Math.floor(encoded.byteLength / 2);
  const multi = await readAskBody(requestWith(streamOf([
    encoded.slice(0, mid),
    encoded.slice(mid),
  ])));
  expect(multi.ok).toBe(true);
  if (multi.ok) expect(Buffer.byteLength(multi.text)).toBe(ASK_BODY_MAX_BYTES);

  const splitOver = await readAskBody(requestWith(streamOf([
    encoded,
    new TextEncoder().encode("测"),
  ])));
  expect(splitOver.ok).toBe(false);
  if (!splitOver.ok) expect(splitOver.response.status).toBe(413);
});

test("10. 坏 JSON、空体、非法 UTF-8 为 BAD_JSON；取消为 CANCELLED", async () => {
  for (const raw of ["{bad", "", "   ", "null", "[]", "\"x\"", "1"]) {
    const result = await readAskBody(requestWith(raw));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const body = await bodyOf(result.response);
      expect(body).toMatchObject({ code: "BAD_JSON", error: "BAD_JSON", retryable: false });
      expect(result.response.status).toBe(400);
    }
  }

  const emptyStream = await readAskBody(requestWith(streamOf([])));
  expect(emptyStream.ok).toBe(false);
  if (!emptyStream.ok) expect((await bodyOf(emptyStream.response)).code).toBe("BAD_JSON");

  const badUtf8 = new Uint8Array([0xff, 0xfe, 0xfd]);
  const utf = await readAskBody(requestWith(streamOf([badUtf8])));
  expect(utf.ok).toBe(false);
  if (!utf.ok) expect((await bodyOf(utf.response)).code).toBe("BAD_JSON");

  const splitPayload = new TextEncoder().encode('{"q":"测"}');
  const splitAt = splitPayload.indexOf(0xb5);
  const splitChar = await readAskBody(requestWith(streamOf([
    splitPayload.slice(0, splitAt),
    splitPayload.slice(splitAt),
  ])));
  expect(splitChar.ok).toBe(true);
  if (splitChar.ok) expect(splitChar.text).toBe('{"q":"测"}');

  const already = new AbortController();
  already.abort();
  const pre = await readAskBody(requestWith("{}", undefined, already.signal));
  expect(pre.ok).toBe(false);
  if (!pre.ok) {
    expect(pre.response.status).toBe(499);
    expect(await bodyOf(pre.response)).toMatchObject({ code: "CANCELLED", error: "CANCELLED", retryable: false });
  }

  let midCancelled = false;
  const hanging = new ReadableStream<Uint8Array>({
    pull() {
      return new Promise(() => {});
    },
    cancel() { midCancelled = true; },
  });
  const controller = new AbortController();
  const pending = readAskBody(requestWith(hanging, undefined, controller.signal));
  controller.abort();
  const mid = await pending;
  expect(mid.ok).toBe(false);
  if (!mid.ok) expect((await bodyOf(mid.response)).code).toBe("CANCELLED");
  expect(midCancelled).toBe(true);

  const thrown = new ReadableStream<Uint8Array>({
    pull() {
      return Promise.reject(new DOMException("The operation was aborted.", "AbortError"));
    },
  });
  const thrownResult = await readAskBody(requestWith(thrown));
  expect(thrownResult.ok).toBe(false);
  if (!thrownResult.ok) expect((await bodyOf(thrownResult.response)).code).toBe("CANCELLED");

  const abortedRead = new AbortController();
  const racing = new ReadableStream<Uint8Array>({
    pull() {
      return Promise.reject(new DOMException("The operation was aborted.", "AbortError"));
    },
  });
  const racingRead = readAskBody(requestWith(racing, undefined, abortedRead.signal));
  abortedRead.abort();
  const racingResult = await racingRead;
  expect(racingResult.ok).toBe(false);
  if (!racingResult.ok) expect((await bodyOf(racingResult.response)).code).toBe("CANCELLED");

  const broken = new ReadableStream<Uint8Array>({
    pull() {
      throw new Error("socket reset");
    },
  });
  const brokenResult = await readAskBody(requestWith(broken));
  expect(brokenResult.ok).toBe(false);
  if (!brokenResult.ok) expect((await bodyOf(brokenResult.response)).code).toBe("BAD_JSON");

  const noBody = await readAskBody(new Request("http://localhost/api/lecture/ask", { method: "GET" }));
  expect(noBody.ok).toBe(false);
  if (!noBody.ok) expect((await bodyOf(noBody.response)).code).toBe("BAD_JSON");

  const ok = await readAskBody(requestWith("{\"a\":1}"));
  expect(ok.ok).toBe(true);
  if (ok.ok) expect(JSON.parse(ok.text)).toEqual({ a: 1 });

  const custom = askError("BAD_REQUEST", 400, "自定义", { "x-test": "1" });
  expect(custom.headers.get("x-test")).toBe("1");
  expect(custom.status).toBe(400);
  expect(await bodyOf(custom)).toMatchObject({ code: "BAD_REQUEST", message: "自定义", retryable: false });
});

vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));

const dns = vi.mocked(lookup as (host: string, options: LookupAllOptions) => Promise<LookupAddress[]>);

const KEY = "sk-ask-route-key-do-not-log";
const SLUG = "3sum";
const STEP = "s1";
const BYOK = {
  provider: "openai-compatible" as const,
  model: "gpt-6.1-sol",
  apiKey: KEY,
  baseURL: "https://ai.example/v1",
};

const STEP_NOT_FOUND = {
  code: "STEP_NOT_FOUND",
  error: "STEP_NOT_FOUND",
  retryable: false,
  message: "这节课已更新或这一步不可用，请刷新。",
};
const UPSTREAM_AUTH = {
  code: "UPSTREAM_AUTH",
  error: "UPSTREAM_AUTH",
  retryable: false,
  message: "API Key 无效或没有权限",
};
const UPSTREAM_ERROR = {
  code: "UPSTREAM_ERROR",
  error: "UPSTREAM_ERROR",
  retryable: true,
  message: AI_CONNECTION_ERROR,
};
const INVALID_ANSWER = {
  code: "INVALID_ANSWER",
  error: "INVALID_ANSWER",
  retryable: true,
  message: "回答内容暂时没生成好，请重新问。",
};
const TIMEOUT = {
  code: "TIMEOUT",
  error: "TIMEOUT",
  retryable: true,
  message: "回答超时，请重新问。",
};
const CANCELLED = {
  code: "CANCELLED",
  error: "CANCELLED",
  retryable: false,
  message: "已取消。",
};
const NO_BYOK = { error: "NO_BYOK", message: "老师还没接上 AI，先去设置里接一下吧。" };
const NOT_FOUND = { error: "NOT_FOUND", message: "没找到这道题，请回路线图重新选择。" };

type GenerateInput = Parameters<typeof import("@/lib/agent/ask-generation").generateAsk>[0];

const insertHarness = vi.hoisted(() => {
  type Gate = {
    entered: () => void;
    enteredPromise: Promise<void>;
    release: () => void;
    released: Promise<void>;
    finished: () => void;
    finishedPromise: Promise<void>;
  };
  let gate: Gate | undefined;
  return {
    hold() {
      let entered!: () => void;
      let release!: () => void;
      let finished!: () => void;
      const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
      const released = new Promise<void>((resolve) => { release = resolve; });
      const finishedPromise = new Promise<void>((resolve) => { finished = resolve; });
      gate = { entered, enteredPromise, release, released, finished, finishedPromise };
      return gate;
    },
    reset() {
      gate = undefined;
    },
    current() {
      return gate;
    },
  };
});

const harness = vi.hoisted(() => {
  const calls: GenerateInput[] = [];
  let impl: (input: GenerateInput) => Promise<AskGenerationResult> = async () => ({
    ok: false,
    status: 502,
    error: "UPSTREAM_ERROR",
  });
  let actual: ((input: GenerateInput) => Promise<AskGenerationResult>) | undefined;
  let passthrough = false;
  return {
    calls,
    set(next: typeof impl) {
      passthrough = false;
      impl = next;
    },
    useActual() {
      passthrough = true;
    },
    setActual(fn: (input: GenerateInput) => Promise<AskGenerationResult>) {
      actual = fn;
    },
    reset() {
      calls.length = 0;
      passthrough = false;
      impl = async () => ({ ok: false, status: 502, error: "UPSTREAM_ERROR" });
    },
    async run(input: GenerateInput) {
      calls.push(input);
      if (passthrough && actual) return actual(input);
      return impl(input);
    },
  };
});

vi.mock("@/lib/ask/answers-repo", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ask/answers-repo")>("@/lib/ask/answers-repo");
  return {
    ...actual,
    insertAnswer: async (
      tx: Parameters<typeof actual.insertAnswer>[0],
      input: Parameters<typeof actual.insertAnswer>[1],
    ) => {
      const gate = insertHarness.current();
      if (!gate) return actual.insertAnswer(tx, input);
      gate.entered();
      try {
        await gate.released;
        return await actual.insertAnswer(tx, input);
      } finally {
        gate.finished();
      }
    },
  };
});

vi.mock("@/lib/agent/ask-generation", async () => {
  const actual = await vi.importActual<typeof import("@/lib/agent/ask-generation")>("@/lib/agent/ask-generation");
  harness.setActual(actual.generateAsk);
  return {
    ...actual,
    generateAsk: (input: GenerateInput) => harness.run(input),
  };
});

function selection(stepId = STEP, question = "为什么这样写？") {
  return {
    stepId,
    mode: "single" as const,
    bbox: { x: 0, y: 0, width: 44, height: 44 },
    targets: [{ kind: "subtitle" as const, id: `subtitle-${stepId}`, stepId, text: "当前字幕" }],
    question,
  };
}

function rawScript(stepIds: string[] = [STEP], overrides: Record<string, unknown> = {}) {
  return {
    problemSlug: SLUG,
    mode: "lecture" as const,
    language: "zh" as const,
    solutionLanguage: "typescript" as const,
    steps: stepIds.map((id) => ({
      id,
      narration: "先排序，再用双指针查找。",
      targets: [{ kind: "code-line" as const, start: 1, end: undefined as number | undefined }],
      effects: [] as [],
    })),
    ...overrides,
  };
}

function cacheKeyOf(
  slug: string,
  config: Pick<ByokConfig, "provider" | "baseURL" | "model">,
  solutionLanguage: string,
  narrationLanguage: string,
) {
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

function segment(id = "a1", extra: Record<string, unknown> = {}): AnswerSegment {
  return { id, narration: `讲解 ${id}`, ...extra };
}

function okGeneration(segments: AnswerSegment[] = [segment()], hooks?: {
  before?: (input: GenerateInput) => Promise<void> | void;
  afterFirst?: (input: GenerateInput) => Promise<void> | void;
  hold?: Promise<void>;
}): (input: GenerateInput) => Promise<AskGenerationResult> {
  return async (input) => {
    await hooks?.before?.(input);
    if (input.signal.aborted) return abortResult(input.signal);
    for (const [index, item] of segments.entries()) {
      input.assertNoRequestKey(item);
      input.onSegment(item);
      if (index === 0) await hooks?.afterFirst?.(input);
      if (input.signal.aborted) return abortResult(input.signal);
    }
    if (hooks?.hold) {
      await Promise.race([
        hooks.hold,
        new Promise<void>((resolve) => {
          if (input.signal.aborted) resolve();
          else input.signal.addEventListener("abort", () => resolve(), { once: true });
        }),
      ]);
    }
    if (input.signal.aborted) return abortResult(input.signal);
    return { ok: true, segments };
  };
}

function abortResult(signal: AbortSignal): AskGenerationResult {
  if (signal.reason === "timeout") return { ok: false, status: 504, error: "TIMEOUT" };
  return { ok: false, status: 499, error: "CANCELLED" };
}

function failedGeneration(error: AskGenerationResult & { ok: false }, when: "before" | "after" = "before") {
  return async (input: GenerateInput): Promise<AskGenerationResult> => {
    if (when === "after") {
      const item = segment();
      input.onSegment(item);
    }
    if (input.signal.aborted) return abortResult(input.signal);
    return error;
  };
}

function askRequest(body: unknown, init: { accept?: string; signal?: AbortSignal } = {}) {
  const headers = new Headers({ "content-type": "application/json" });
  if (init.accept) headers.set("accept", init.accept);
  return new NextRequest("http://localhost/api/lecture/ask", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: init.signal,
  });
}

async function post(body: unknown, init: { accept?: string; signal?: AbortSignal } = {}) {
  const { POST } = await import("@/app/api/lecture/ask/route");
  return POST(askRequest(body, init));
}

async function readLines(response: Response) {
  const text = await response.text();
  return text.split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line) as Record<string, unknown>);
}

function askBody(stepId: string, cacheKey: string, version: string, extras: Record<string, unknown> = {}) {
  const question = "为什么这样写？";
  return {
    problemSlug: SLUG,
    cacheKey,
    scriptVersion: version,
    stepId,
    question,
    selection: selection(stepId, question),
    byok: BYOK,
    ...extras,
  };
}

describe("POST /api/lecture/ask", () => {
  let fixture: Awaited<ReturnType<typeof createFixture>>;

  beforeAll(async () => {
    fixture = await createFixture({ modelServer: false });
  });

  afterAll(async () => {
    await fixture.close();
  });

  beforeEach(async () => {
    resetAskControlForTests();
    insertHarness.reset();
    harness.reset();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    dns.mockReset().mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
    vi.stubEnv("ALGOSTAGE_ALLOW_PRIVATE_BASE_URL", "false");
    vi.stubEnv("ALGOSTAGE_EGRESS_ALLOW_HOSTS", "");
    vi.stubEnv("ALGOSTAGE_DISABLE_SERVER_KEY", "");
    vi.stubEnv("AI_API_KEY", "");
    vi.stubEnv("AI_BASE_URL", "");
    vi.stubEnv("AI_PROVIDER", "");
    vi.stubEnv("AI_MODEL", "");
    vi.stubEnv("ASK_TIMEOUT_MS", "");
    await fixture.prisma.lectureAnswer.deleteMany();
    await fixture.prisma.lectureScriptCache.deleteMany();
    await fixture.prisma.setting.deleteMany();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function seed(raw: unknown = rawScript(), config = BYOK, keySlug = SLUG) {
    const detail = await (await import("@/lib/content/local-source")).localSeedSource.detail(SLUG);
    const referenceCode = detail.referenceSolutions?.find((item) => item.language === "typescript")?.code ?? "";
    const script = validateScript(raw, referenceCode, { stepIds: "lenient" });
    const version = scriptVersion(script);
    const key = cacheKeyOf(keySlug, config, script.solutionLanguage, script.language);
    await fixture.prisma.lectureScriptCache.create({ data: { key, script: JSON.stringify(raw) } });
    return { key, version, script, referenceCode };
  }

  test("#10 schema 不合法不调用后续；未知题目 NOT_FOUND 先于 BYOK 和缓存", async () => {
    const resolveByok = vi.spyOn(await import("@/lib/agent/provider"), "resolveByok");
    const validateBaseURL = vi.spyOn(await import("@/lib/agent/settings-connection"), "validateBaseURL");
    const findUnique = vi.spyOn(fixture.prisma.lectureScriptCache, "findUnique");

    const bad = await post({ problemSlug: SLUG, question: "   " });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: "BAD_REQUEST" });

    const missing = await post({
      ...askBody(STEP, "a".repeat(40), "b".repeat(40)),
      problemSlug: "not-a-problem",
    });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual(NOT_FOUND);

    const stacked = await post({
      ...askBody(STEP, "c".repeat(40), "d".repeat(40)),
      problemSlug: "not-a-problem",
      byok: { baseURL: "https://ai.example/v1" },
    });
    expect(stacked.status).toBe(404);

    expect(resolveByok).not.toHaveBeenCalled();
    expect(validateBaseURL).not.toHaveBeenCalled();
    expect(findUnique).not.toHaveBeenCalled();
    expect(harness.calls).toHaveLength(0);
  });

  test("#11 无题目先于错 BYOK；同题错 BYOK 先于无缓存；地址预检先于 STEP_NOT_FOUND", async () => {
    const absent = await post({
      problemSlug: "not-a-problem",
      cacheKey: "e".repeat(40),
      scriptVersion: "f".repeat(40),
      stepId: STEP,
      question: "为什么",
      selection: selection(STEP, "为什么"),
      byok: { baseURL: "https://ai.example/v1" },
    });
    expect(absent.status).toBe(404);

    const badByok = await post({
      ...askBody(STEP, "1".repeat(40), "2".repeat(40)),
      byok: { baseURL: "not a url" },
    });
    expect(badByok.status).toBe(400);
    expect((await badByok.json()).code).toBe("BASE_URL_INVALID");
    expect(await fixture.prisma.lectureScriptCache.count()).toBe(0);

    dns.mockResolvedValue([{ address: "10.0.0.8", family: 4 }]);
    const blocked = await post(askBody(STEP, "3".repeat(40), "4".repeat(40)));
    expect(blocked.status).toBe(502);
    expect(await blocked.json()).toEqual(UPSTREAM_ERROR);
    expect(harness.calls).toHaveLength(0);
    const logged = JSON.stringify(vi.mocked(console.warn).mock.calls);
    expect(logged).not.toContain(KEY);
    expect(logged).not.toContain("10.0.0.8");
  });

  test("#12 resolveByok 各失败：KEY、地址、配置、NO_BYOK、环境坏地址 502，不打印异常", async () => {
    const secret = "env-secret-should-not-print";
    const cases: Array<{ byok: unknown; env?: Record<string, string>; status: number; match: Record<string, unknown> }> = [
      { byok: { baseURL: "https://ai.example/v1" }, status: 400, match: { code: "BYOK_KEY_REQUIRED", error: "BYOK_KEY_REQUIRED" } },
      { byok: { ...BYOK, baseURL: "ftp://files.example/v1" }, status: 400, match: { code: "BASE_URL_INVALID" } },
      {
        byok: { provider: "anthropic", model: "claude-3-opus", apiKey: KEY },
        env: { AI_API_KEY: KEY, AI_BASE_URL: "https://api.openai.com/v1", AI_PROVIDER: "openai-compatible" },
        status: 400,
        match: { error: "CONFIGURATION_ERROR" },
      },
      { byok: null, status: 400, match: NO_BYOK },
    ];
    for (const item of cases) {
      for (const [name, value] of Object.entries(item.env ?? {})) vi.stubEnv(name, value);
      const response = await post({ ...askBody(STEP, "a".repeat(40), "b".repeat(40)), byok: item.byok });
      expect(response.status, JSON.stringify(item.byok)).toBe(item.status);
      expect(await response.json()).toMatchObject(item.match);
      for (const name of Object.keys(item.env ?? {})) vi.stubEnv(name, "");
    }

    vi.stubEnv("AI_BASE_URL", "not-a-url");
    vi.stubEnv("AI_API_KEY", secret);
    const envBad = await post({ ...askBody(STEP, "a".repeat(40), "b".repeat(40)), byok: null });
    expect(envBad.status).toBe(502);
    expect(await envBad.json()).toEqual(UPSTREAM_ERROR);
    const logged = JSON.stringify(vi.mocked(console.warn).mock.calls);
    expect(logged).not.toContain(secret);
    expect(logged).not.toContain("not-a-url");
    expect(harness.calls).toHaveLength(0);
  });

  test("#13 自定义与已保存地址都预检；预检的 400 重建为 502，不透传", async () => {
    dns.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    const custom = await post(askBody(STEP, "a".repeat(40), "b".repeat(40)));
    expect(custom.status).toBe(502);
    expect(await custom.json()).toEqual(UPSTREAM_ERROR);
    expect(custom.headers.get("content-type")).toContain("application/json");

    await fixture.save({
      apiKey: "saved-key",
      model: "gpt-6.1-sol",
      provider: "openai-compatible",
      baseURL: "https://saved.example/v1",
      baseURLProvider: "openai-compatible",
    });
    dns.mockResolvedValue([{ address: "10.1.1.1", family: 4 }]);
    const saved = await post({
      ...askBody(STEP, "a".repeat(40), "b".repeat(40), { byok: { apiKey: "saved-key", model: "gpt-6.1-sol" } }),
    });
    expect(saved.status).toBe(502);
    expect(await saved.json()).toEqual(UPSTREAM_ERROR);
    expect(dns).toHaveBeenCalled();
    expect(harness.calls).toHaveLength(0);

    dns.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
    const syntax = await post({
      ...askBody(STEP, "a".repeat(40), "b".repeat(40)),
      byok: { ...BYOK, baseURL: "ftp://bad.example/v1" },
    });
    expect(syntax.status).toBe(400);
    expect((await syntax.json()).code).toBe("BASE_URL_INVALID");
  });

  test("#14 运行时私网 DNS、重绑定和 30x 都是 502，且不第二次携带凭据", async () => {
    const seeded = await seed();
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const body = askBody(STEP, seeded.key, seeded.version);

    dns.mockResolvedValue([{ address: "10.0.0.9", family: 4 }]);
    harness.set(okGeneration());
    const privateV4 = await post(body);
    expect(privateV4.status).toBe(502);
    expect(await privateV4.json()).toEqual(UPSTREAM_ERROR);
    expect(fetchMock).not.toHaveBeenCalled();

    dns.mockReset().mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }]).mockResolvedValue([{ address: "10.2.0.1", family: 4 }]);
    harness.useActual();
    const rebound = await post(body);
    expect(rebound.status).toBe(502);
    expect(fetchMock).not.toHaveBeenCalled();

    dns.mockReset().mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
    harness.useActual();
    fetchMock.mockResolvedValue(new Response("redirect-secret", { status: 302, headers: { location: "http://127.0.0.1/private" } }));
    const redirected = await post(body);
    expect(redirected.status).toBe(502);
    expect(await redirected.json()).toEqual(UPSTREAM_ERROR);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.redirect).toBe("manual");
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(KEY);
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain("redirect-secret");
    expect(await fixture.prisma.lectureScriptCache.count()).toBe(1);
  });

  test("#15 缓存缺失、坏 JSON、无法校验、题号或 mode 不符都是 409，且不删缓存、不调模型", async () => {
    const missing = await post(askBody(STEP, "a".repeat(40), "b".repeat(40)));
    expect(missing.status).toBe(409);
    expect(await missing.json()).toEqual(STEP_NOT_FOUND);

    const badKey = cacheKeyOf(SLUG, BYOK, "typescript", "zh");
    await fixture.prisma.lectureScriptCache.create({ data: { key: badKey, script: "{not-json" } });
    const broken = await post(askBody(STEP, badKey, "c".repeat(40)));
    expect(broken.status).toBe(409);

    await fixture.prisma.lectureScriptCache.update({
      where: { key: badKey },
      data: { script: JSON.stringify({ steps: [] }) },
    });
    const invalid = await post(askBody(STEP, badKey, "c".repeat(40)));
    expect(invalid.status).toBe(409);

    const wrongSlug = await seed(rawScript([STEP], { problemSlug: "move-zeroes" }), BYOK, "move-zeroes");
    const slugMismatch = await post(askBody(STEP, wrongSlug.key, wrongSlug.version));
    expect(slugMismatch.status).toBe(409);

    const review = await seed(rawScript([STEP], { mode: "review" }), BYOK, "review-key");
    const modeMismatch = await post(askBody(STEP, review.key, review.version));
    expect(modeMismatch.status).toBe(409);

    expect(await fixture.prisma.lectureScriptCache.count()).toBe(3);
    expect(harness.calls).toHaveLength(0);
  });

  test("#16 正确 version 可问；clamp 后以 validateScript 输出版本为准", async () => {
    harness.set(okGeneration());
    const raw = rawScript();
    raw.steps[0].targets = [{ kind: "code-line", start: 999, end: 2 }];
    const seeded = await seed(raw);
    const detail = await (await import("@/lib/content/local-source")).localSeedSource.detail(SLUG);
    const referenceCode = detail.referenceSolutions?.find((item) => item.language === "typescript")?.code ?? "";
    const rawVersion = scriptVersion(raw);
    expect(rawVersion).not.toBe(seeded.version);
    expect(scriptVersion(validateScript(raw, referenceCode, { stepIds: "lenient" }))).toBe(seeded.version);

    const stale = await post(askBody(STEP, seeded.key, rawVersion));
    expect(stale.status).toBe(409);
    expect(harness.calls).toHaveLength(0);

    const ok = await post(askBody(STEP, seeded.key, seeded.version));
    expect(ok.status).toBe(200);
    const body = await ok.json() as { answer: StepAnswer };
    expect(body.answer.v).toBe(1);
    expect(body.answer.stepId).toBe(STEP);
    expect(body.answer.segments[0]?.narration).toBe("讲解 a1");
    expect(harness.calls).toHaveLength(1);
  });

  test("#17 重复或空 id 禁问，唯一合法步可问，缓存保留", async () => {
    harness.set(okGeneration());
    const seeded = await seed(rawScript(["dup", "dup", "", "only"]));
    const cacheCount = await fixture.prisma.lectureScriptCache.count();

    const duplicate = await post(askBody("dup", seeded.key, seeded.version));
    expect(duplicate.status).toBe(409);
    const empty = await post(askBody("", seeded.key, seeded.version));
    expect(empty.status).toBe(400);
    const absent = await post(askBody("missing", seeded.key, seeded.version));
    expect(absent.status).toBe(409);

    const allowed = await post(askBody("only", seeded.key, seeded.version));
    expect(allowed.status).toBe(200);
    expect((await allowed.json() as { answer: StepAnswer }).answer.stepId).toBe("only");
    expect(await fixture.prisma.lectureScriptCache.count()).toBe(cacheCount);
  });

  test("#18 cacheKey 任一项错配拒绝；只改 apiKey 仍可问", async () => {
    harness.set(okGeneration());
    const seeded = await seed();
    const mismatches = [
      cacheKeyOf("move-zeroes", BYOK, "typescript", "zh"),
      cacheKeyOf(SLUG, { ...BYOK, provider: "anthropic" }, "typescript", "zh"),
      cacheKeyOf(SLUG, { ...BYOK, baseURL: "https://other.example/v1" }, "typescript", "zh"),
      cacheKeyOf(SLUG, { ...BYOK, model: "gpt-4o" }, "typescript", "zh"),
      cacheKeyOf(SLUG, BYOK, "typescript", "en"),
      cacheKeyOf(SLUG, BYOK, "python", "zh"),
    ];
    for (const key of mismatches) {
      await fixture.prisma.lectureScriptCache.create({ data: { key, script: JSON.stringify(rawScript()) } });
      const response = await post(askBody(STEP, key, seeded.version));
      expect(response.status, key).toBe(409);
    }
    const otherKey = "sk-other-key-still-same-cache";
    const ok = await post({
      ...askBody(STEP, seeded.key, seeded.version),
      byok: { ...BYOK, apiKey: otherKey },
    });
    expect(ok.status).toBe(200);
    expect(harness.calls.at(-1)?.config.apiKey).toBe(otherKey);
    expect(await fixture.prisma.lectureScriptCache.count()).toBe(mismatches.length + 1);
  });

  test("#19 生成期间覆盖或删除缓存：流内 STEP_NOT_FOUND，无 result", async () => {
    const seeded = await seed();
    harness.set(async (input) => {
      input.onSegment(segment());
      await fixture.prisma.lectureScriptCache.delete({ where: { key: seeded.key } });
      return { ok: true, segments: [segment()] };
    });
    const removed = await post(askBody(STEP, seeded.key, seeded.version), { accept: "application/x-ndjson" });
    expect(removed.status).toBe(200);
    const removedLines = await readLines(removed);
    expect(removedLines.at(-1)).toEqual({ type: "error", code: "STEP_NOT_FOUND", retryable: false });
    expect(removedLines.some((line) => line.type === "result")).toBe(false);

    const again = await seed();
    harness.set(async (input) => {
      input.onSegment(segment());
      await fixture.prisma.lectureScriptCache.update({
        where: { key: again.key },
        data: { script: JSON.stringify(rawScript(["other"])) },
      });
      return { ok: true, segments: [segment()] };
    });
    const replaced = await post(askBody(STEP, again.key, again.version), { accept: "application/x-ndjson" });
    expect(replaced.status).toBe(200);
    const replacedLines = await readLines(replaced);
    expect(replacedLines.at(-1)).toEqual({ type: "error", code: "STEP_NOT_FOUND", retryable: false });
    expect(replacedLines.some((line) => line.type === "result")).toBe(false);
    expect(await fixture.prisma.lectureAnswer.count()).toBe(0);
  });

  test("#21 首段非法是 422；首段后非法只发 error，不发 result", async () => {
    const seeded = await seed();
    const body = askBody(STEP, seeded.key, seeded.version);
    harness.set(failedGeneration({ ok: false, status: 422, error: "INVALID_ANSWER" }, "before"));
    const early = await post(body, { accept: "application/x-ndjson" });
    expect(early.status).toBe(422);
    expect(await early.json()).toEqual(INVALID_ANSWER);
    expect(early.headers.get("content-type")).toContain("application/json");

    harness.set(failedGeneration({ ok: false, status: 422, error: "INVALID_ANSWER" }, "after"));
    const late = await post(body, { accept: "application/x-ndjson" });
    expect(late.status).toBe(200);
    const lines = await readLines(late);
    expect(lines.map((line) => line.type)).toEqual(["start", "segment", "error"]);
    expect(lines.at(-1)).toEqual({ type: "error", code: "INVALID_ANSWER", retryable: true });
    expect(Object.keys(lines.at(-1) ?? {}).sort()).toEqual(["code", "retryable", "type"]);
  });

  test("#24 首段前 401/403 即使声明 NDJSON 也是 HTTP 400，且无 start", async () => {
    const seeded = await seed();
    for (const status of [401, 403]) {
      harness.set(failedGeneration({ ok: false, status: 400, error: "UPSTREAM_AUTH" }));
      const response = await post(askBody(STEP, seeded.key, seeded.version), { accept: "application/x-ndjson" });
      expect(response.status, String(status)).toBe(400);
      expect(await response.json()).toEqual(UPSTREAM_AUTH);
      expect(response.headers.get("content-type")).not.toContain("ndjson");
    }
  });

  test("#25 首段前连接错误是 502 固定文案；首段后是 200 且 error 只有三键", async () => {
    const seeded = await seed();
    const body = askBody(STEP, seeded.key, seeded.version);
    harness.set(failedGeneration({ ok: false, status: 502, error: "UPSTREAM_ERROR" }));
    const early = await post(body, { accept: "application/x-ndjson" });
    expect(early.status).toBe(502);
    expect(await early.json()).toEqual(UPSTREAM_ERROR);

    harness.set(failedGeneration({ ok: false, status: 502, error: "UPSTREAM_ERROR" }, "after"));
    const late = await post(body, { accept: "application/x-ndjson" });
    expect(late.status).toBe(200);
    const lines = await readLines(late);
    expect(lines[0]).toMatchObject({ type: "start", stepId: STEP, imageUsed: false });
    expect(lines.at(-1)).toEqual({ type: "error", code: "UPSTREAM_ERROR", retryable: true });
    expect(JSON.stringify(lines)).not.toContain(KEY);
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(KEY);
  });

  test("#26 首段通过后、上游未结束时已能读到 start 然后 segment", async () => {
    const seeded = await seed();
    let release: (() => void) | undefined;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    harness.set(okGeneration([segment("a1"), segment("a2")], { hold }));
    const response = await post(askBody(STEP, seeded.key, seeded.version), { accept: "application/x-ndjson" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/x-ndjson; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store, no-transform");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    const first = await reader.read();
    buffered += decoder.decode(first.value, { stream: true });
    const newline = buffered.indexOf("\n");
    expect(newline).toBeGreaterThan(0);
    const start = JSON.parse(buffered.slice(0, newline)) as { type: string };
    expect(start.type).toBe("start");
    release?.();
    let rest = buffered.slice(newline + 1);
    while (!rest.includes("result")) {
      const next = await reader.read();
      if (next.done) break;
      rest += decoder.decode(next.value, { stream: true });
    }
    const types = rest.split("\n").filter(Boolean).map((line) => (JSON.parse(line) as { type: string }).type);
    expect(types[0]).toBe("segment");
    expect(types.filter((type) => type === "start")).toHaveLength(0);
    expect(types.at(-1)).toBe("result");
  });

  test("#27 首段后认证错误是 UPSTREAM_AUTH 且不可重试；晚错误不含原文", async () => {
    const seeded = await seed();
    harness.set(failedGeneration({ ok: false, status: 400, error: "UPSTREAM_AUTH" }, "after"));
    const auth = await post(askBody(STEP, seeded.key, seeded.version), { accept: "application/x-ndjson" });
    expect(auth.status).toBe(200);
    const authLines = await readLines(auth);
    expect(authLines.at(-1)).toEqual({ type: "error", code: "UPSTREAM_AUTH", retryable: false });

    harness.set(async (input) => {
      input.onSegment(segment());
      return { ok: false, status: 429, error: "RATE_LIMITED" as never };
    });
    const unknown = await post(askBody(STEP, seeded.key, seeded.version), { accept: "application/x-ndjson" });
    const unknownLines = await readLines(unknown);
    expect(unknownLines.at(-1)).toEqual({ type: "error", code: "UPSTREAM_ERROR", retryable: true });
    const packed = JSON.stringify(unknownLines);
    expect(packed).not.toContain("https://");
    expect(packed).not.toContain(KEY);
    expect(packed).not.toContain("stack");
  });

  test("#30 JSON Accept 成功返回 {answer}；失败保留 HTTP 状态", async () => {
    const seeded = await seed();
    harness.set(okGeneration());
    const ok = await post(askBody(STEP, seeded.key, seeded.version), { accept: "application/json" });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toContain("application/json");
    const body = await ok.json() as { answer: StepAnswer };
    expect(body.answer.segments).toHaveLength(1);
    expect(body.answer.question).toBe("为什么这样写？");
    expect(body.answer.selection).toEqual({
      mode: "single",
      bbox: { x: 0, y: 0, width: 44, height: 44 },
      targets: selection().targets,
    });
    expect(body.answer).not.toHaveProperty("image");

    harness.set(failedGeneration({ ok: false, status: 422, error: "INVALID_ANSWER" }));
    const failed = await post(askBody(STEP, seeded.key, seeded.version));
    expect(failed.status).toBe(422);
    expect(await failed.json()).toEqual(INVALID_ANSWER);
  });

  test("#32 首段前取消返回 499，读体和地址预检挂起时也能取消", async () => {
    const seeded = await seed();
    let release: ((value: AskGenerationResult) => void) | undefined;
    harness.set((input) => new Promise((resolve) => {
      release = resolve;
      input.signal.addEventListener("abort", () => resolve(abortResult(input.signal)), { once: true });
    }));
    const controller = new AbortController();
    const pending = post(askBody(STEP, seeded.key, seeded.version), { accept: "application/x-ndjson", signal: controller.signal });
    await vi.waitFor(() => {
      if (harness.calls.length === 0) throw new Error("not started");
    });
    controller.abort();
    const response = await pending;
    expect(response.status).toBe(499);
    expect(await response.json()).toEqual(CANCELLED);
    expect(harness.calls[0]?.signal.aborted).toBe(true);

    const bodyController = new AbortController();
    const hanging = new NextRequest("http://localhost/api/lecture/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new ReadableStream({ pull: () => new Promise(() => {}) }),
      signal: bodyController.signal,
      duplex: "half",
    });
    const { POST } = await import("@/app/api/lecture/ask/route");
    const reading = POST(hanging);
    bodyController.abort();
    const cancelledBody = await reading;
    expect(cancelledBody.status).toBe(499);

    let dnsCalled = false;
    dns.mockImplementation(() => {
      dnsCalled = true;
      return new Promise<LookupAddress[]>(() => {});
    });
    const preflight = new AbortController();
    const checking = post(askBody(STEP, seeded.key, seeded.version), { signal: preflight.signal });
    await vi.waitFor(() => {
      if (!dnsCalled) throw new Error("preflight has not started");
    }, { timeout: 5_000 });
    preflight.abort();
    const cancelledCheck = await checking;
    expect(cancelledCheck.status).toBe(499);
    expect(await cancelledCheck.json()).toEqual(CANCELLED);
    release?.( { ok: false, status: 499, error: "CANCELLED" });
  });

  test("#33 首段后取消发 CANCELLED 且无 result；reader.cancel 停止 enqueue", async () => {
    const seeded = await seed();
    let release: (() => void) | undefined;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    harness.set(okGeneration([segment()], { hold }));
    const controller = new AbortController();
    const response = await post(askBody(STEP, seeded.key, seeded.version), {
      accept: "application/x-ndjson",
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('"type":"start"');
    controller.abort();
    release?.();
    let text = "";
    const decoder = new TextDecoder();
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      text += decoder.decode(next.value, { stream: true });
    }
    const lines = text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as { type: string; code?: string });
    expect(lines.some((line) => line.type === "result")).toBe(false);
    expect(lines.at(-1)).toMatchObject({ type: "error", code: "CANCELLED" });

    let parked = false;
    let releasePark: (() => void) | undefined;
    const park = new Promise<void>((resolve) => {
      releasePark = resolve;
    });
    harness.set(okGeneration([segment()], {
      afterFirst: () => {
        parked = true;
      },
      hold: park,
    }));
    const streaming = await post(askBody(STEP, seeded.key, seeded.version), { accept: "application/x-ndjson" });
    await vi.waitFor(() => {
      if (!parked) throw new Error("producer has not parked");
    });
    await streaming.body!.cancel();
    expect(harness.calls.at(-1)?.signal.aborted).toBe(true);
    releasePark?.();
    expect(await fixture.prisma.lectureAnswer.count()).toBe(0);
  });

  test("#34 首段前挂起是 504；首段后挂起是 200 + TIMEOUT，无 result", async () => {
    vi.stubEnv("ASK_TIMEOUT_MS", "30");
    const seeded = await seed();
    harness.set((input) => new Promise((resolve) => {
      input.signal.addEventListener("abort", () => resolve(abortResult(input.signal)), { once: true });
    }));
    const early = await post(askBody(STEP, seeded.key, seeded.version), { accept: "application/x-ndjson" });
    expect(early.status).toBe(504);
    expect(await early.json()).toEqual(TIMEOUT);

    vi.stubEnv("ASK_TIMEOUT_MS", "200");
    harness.set(okGeneration([segment()], {
      hold: new Promise(() => {}),
    }));
    const late = await post(askBody(STEP, seeded.key, seeded.version), { accept: "application/x-ndjson" });
    expect(late.status).toBe(200);
    const lines = await readLines(late);
    expect(lines[0]?.type).toBe("start");
    expect(lines.at(-1)).toEqual({ type: "error", code: "TIMEOUT", retryable: true });
    expect(lines.some((line) => line.type === "result")).toBe(false);
    expect(await fixture.prisma.lectureAnswer.count()).toBe(0);
  });

  test("#35 先发生的终止原因胜出；上游的 AbortError 分类不能改写它", async () => {
    vi.stubEnv("ASK_TIMEOUT_MS", "30");
    const seeded = await seed();
    const controller = new AbortController();
    harness.set((input) => new Promise((resolve) => {
      const timer = setTimeout(() => controller.abort(), 200);
      input.signal.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve({ ok: false, status: 499, error: "CANCELLED" });
      }, { once: true });
    }));
    const timed = await post(askBody(STEP, seeded.key, seeded.version), {
      accept: "application/x-ndjson",
      signal: controller.signal,
    });
    expect(timed.status).toBe(504);
    expect(await timed.json()).toEqual(TIMEOUT);

    vi.stubEnv("ASK_TIMEOUT_MS", "500");
    const user = new AbortController();
    harness.set((input) => new Promise((resolve) => {
      input.signal.addEventListener("abort", () => {
        resolve({ ok: false, status: 504, error: "TIMEOUT" });
      }, { once: true });
    }));
    const pending = post(askBody(STEP, seeded.key, seeded.version), { signal: user.signal });
    await vi.waitFor(() => {
      if (harness.calls.length < 2) throw new Error("waiting");
    });
    user.abort();
    const cancelled = await pending;
    expect(cancelled.status).toBe(499);
    expect(await cancelled.json()).toEqual(CANCELLED);
  });

  test("#38 请求 Key 出现在 segment 或最终 answer 时不发 result", async () => {
    const seeded = await seed();
    const warn = JSON.stringify(vi.mocked(console.warn).mock.calls);
    harness.set(async (input) => {
      const leaked = segment("a1", { narration: `泄漏 ${KEY}` });
      input.assertNoRequestKey(leaked);
      input.onSegment(leaked);
      return { ok: true, segments: [leaked] };
    });
    const early = await post(askBody(STEP, seeded.key, seeded.version), { accept: "application/x-ndjson" });
    expect(early.status).toBe(422);
    expect(await early.json()).toEqual(INVALID_ANSWER);
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(KEY);

    harness.set(async (input) => {
      const safe = segment();
      input.onSegment(safe);
      return { ok: true, segments: [safe] };
    });
    const poisoned = askBody(STEP, seeded.key, seeded.version);
    poisoned.question = `请解释 ${KEY}`;
    poisoned.selection = selection(STEP, poisoned.question);
    const late = await post(poisoned, { accept: "application/x-ndjson" });
    expect(late.status).toBe(200);
    const lines = await readLines(late);
    expect(lines.at(-1)).toEqual({ type: "error", code: "INVALID_ANSWER", retryable: true });
    expect(lines.some((line) => line.type === "result")).toBe(false);
    expect(JSON.stringify(lines)).not.toContain(KEY);
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(KEY);
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(KEY);
    expect(warn).not.toContain(KEY);
    expect(await fixture.prisma.lectureAnswer.count()).toBe(0);
  });

  test("two-sum 没有讲课缓存时 409 STEP_NOT_FOUND", async () => {
    const response = await post({
      ...askBody(STEP, "a".repeat(40), "b".repeat(40)),
      problemSlug: "two-sum",
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual(STEP_NOT_FOUND);
    expect(harness.calls).toHaveLength(0);
    expect(await fixture.prisma.lectureScriptCache.count()).toBe(0);
  });

  test('stepId "__proto__" 与 "constructor" 作为真实可问步成功，不存在的步 409', async () => {
    harness.set(okGeneration());
    const seeded = await seed(rawScript(["__proto__", "constructor", "plain"]));
    for (const stepId of ["__proto__", "constructor"]) {
      const response = await post(askBody(stepId, seeded.key, seeded.version));
      expect(response.status, stepId).toBe(200);
      const body = await response.json() as { answer: StepAnswer };
      expect(body.answer.stepId).toBe(stepId);
      expect(body.answer.segments[0]?.id).toBe("a1");
    }
    const missing = await post(askBody("toString", seeded.key, seeded.version));
    expect(missing.status).toBe(409);
    expect(await missing.json()).toEqual(STEP_NOT_FOUND);
    expect(await fixture.prisma.lectureScriptCache.count()).toBe(1);
  });

  test("#40 same cacheKey concurrent/second → 409 ASK_BUSY", async () => {
    const seeded = await seed();
    let release: (() => void) | undefined;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    harness.set(okGeneration([segment()], { hold }));
    const first = post(askBody(STEP, seeded.key, seeded.version), { accept: "application/x-ndjson" });
    await vi.waitFor(() => {
      if (harness.calls.length < 1) throw new Error("waiting");
    });
    const second = await post(askBody(STEP, seeded.key, seeded.version));
    expect(second.status).toBe(409);
    const body = await second.json() as { error: string; message: string };
    expect(body.error).toBe("ASK_BUSY");
    expect(body.message).toBe("上一个问题还在回答，答完再问");
    release?.();
    const opened = await first;
    expect(opened.status).toBe(200);
    await opened.text();
  });

  test("#37 success local creates one LectureAnswer row", async () => {
    const seeded = await seed();
    harness.set(okGeneration());
    const response = await post(askBody(STEP, seeded.key, seeded.version));
    expect(response.status).toBe(200);
    const body = await response.json() as { answer: StepAnswer };
    const rows = await fixture.prisma.lectureAnswer.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(body.answer.id);
    expect(rows[0]?.cacheKey).toBe(seeded.key);
    expect(rows[0]?.scriptVersion).toBe(seeded.version);
    expect(rows[0]?.stepId).toBe(STEP);
    expect(JSON.parse(rows[0]?.payload ?? "{}")).toMatchObject({
      id: body.answer.id,
      stepId: STEP,
      question: body.answer.question,
    });
  });

  test("#36 abort/timeout during insert → no row", async () => {
    const seeded = await seed();
    harness.set(okGeneration());
    const gate = insertHarness.hold();
    const original = fixture.prisma.$transaction.bind(fixture.prisma);
    let settled = Promise.resolve();
    vi.spyOn(fixture.prisma, "$transaction").mockImplementation(((...args: unknown[]) => {
      const pending = (original as (...inner: unknown[]) => Promise<unknown>)(...args);
      settled = pending.then(() => undefined, () => undefined);
      return pending;
    }) as typeof fixture.prisma.$transaction);
    const controller = new AbortController();
    const pending = post(askBody(STEP, seeded.key, seeded.version), {
      accept: "application/x-ndjson",
      signal: controller.signal,
    });
    await gate.enteredPromise;
    controller.abort();
    gate.release();
    const response = await pending;
    expect(response.status).toBe(200);
    const lines = await readLines(response);
    expect(lines.some((line) => line.type === "result")).toBe(false);
    expect(lines.at(-1)).toMatchObject({ type: "error", code: "CANCELLED" });
    await settled;
    expect(await fixture.prisma.lectureAnswer.count()).toBe(0);
  });

  test("#39 public success never calls lectureAnswer create/findMany/deleteMany", async () => {
    vi.stubEnv("ALGOSTAGE_DISABLE_SERVER_KEY", "true");
    const seeded = await seed();
    harness.set(okGeneration());
    const create = vi.spyOn(fixture.prisma.lectureAnswer, "create");
    const findMany = vi.spyOn(fixture.prisma.lectureAnswer, "findMany");
    const deleteMany = vi.spyOn(fixture.prisma.lectureAnswer, "deleteMany");
    const response = await post(askBody(STEP, seeded.key, seeded.version));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ answer: { stepId: STEP } });
    expect(create).not.toHaveBeenCalled();
    expect(findMany).not.toHaveBeenCalled();
    expect(deleteMany).not.toHaveBeenCalled();
    expect(await fixture.prisma.lectureAnswer.count()).toBe(0);
  });

  test("#41 public: 3rd concurrent same IP → 429; 7th in window → 429 with Retry-After", async () => {
    vi.stubEnv("ALGOSTAGE_DISABLE_SERVER_KEY", "true");
    const seeded = await seed();
    let release: (() => void) | undefined;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    harness.set(okGeneration([segment()], { hold }));
    const body = askBody(STEP, seeded.key, seeded.version);
    const first = post(body, { accept: "application/x-ndjson" });
    const second = post(body, { accept: "application/x-ndjson" });
    await vi.waitFor(() => {
      if (harness.calls.length < 2) throw new Error("waiting");
    });
    const third = await post(body);
    expect(third.status).toBe(429);
    expect((await third.json()).error).toBe("RATE_LIMITED");

    release?.();
    const opened = await Promise.all([first, second]);
    for (const response of opened) {
      expect(response.status).toBe(200);
      await response.text();
    }

    harness.set(okGeneration());
    for (let i = 0; i < 4; i += 1) {
      const next = await post(body);
      expect(next.status, `follow-up ${i}`).toBe(200);
      await next.json();
    }
    const seventh = await post(body);
    expect(seventh.status).toBe(429);
    expect((await seventh.json()).error).toBe("RATE_LIMITED");
    const retryAfter = seventh.headers.get("retry-after");
    expect(retryAfter).toBeTruthy();
    expect(Number(retryAfter)).toBeGreaterThan(0);
  });

  test("#43 after success, next admit works", async () => {
    const seeded = await seed();
    harness.set(okGeneration());
    const first = await post(askBody(STEP, seeded.key, seeded.version));
    expect(first.status).toBe(200);
    await first.json();
    const second = await post(askBody(STEP, seeded.key, seeded.version));
    expect(second.status).toBe(200);
    await second.json();
    expect(await fixture.prisma.lectureAnswer.count()).toBe(2);
  });
});
