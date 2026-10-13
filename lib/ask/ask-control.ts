import { isIP } from "node:net";

/** Fixed window length for both local and public admission. */
export const WINDOW_MS = 60_000;

/** Maximum admitted requests per identity inside one window. */
export const MAX_PER_WINDOW = 6;

/** Maximum in-flight public requests for one IP. */
export const MAX_PUBLIC_INFLIGHT = 2;

/** Hard cap on tracked public IP buckets. */
export const MAX_BUCKETS = 10_000;

/** Exact copy returned when a local cache key is already answering. */
export const ASK_BUSY_MESSAGE = "上一个问题还在回答，答完再问";

const RATE_LIMITED_MESSAGE = "提问过于频繁，请稍后再试";

const TRUST_TRUE = new Set(["true", "1", "on", "yes"]);

export type AdmitOk = { ok: true; release: () => void };

export type AdmitFail = {
  ok: false;
  status: 409 | 429;
  code: "ASK_BUSY" | "RATE_LIMITED";
  message: string;
  retryAfterSec?: number;
};

export type AdmitResult = AdmitOk | AdmitFail;

type PublicBucket = {
  count: number;
  windowStart: number;
  inflight: number;
};

/** cacheKey → lock token. Present means that local key is answering. */
const localLocks = new Map<string, symbol>();

/** cacheKey → fixed-window count and the timestamp when that window opened. */
const localWindows = new Map<string, { count: number; windowStart: number }>();

/** ip → public window count, window start, and in-flight slots. */
const publicBuckets = new Map<string, PublicBucket>();

/** ip → token of each in-flight public admission. */
const publicInflight = new Map<string, Set<symbol>>();

function nowMs(): number {
  return Date.now();
}

function retryAfterSec(remainingMs: number): number {
  return Math.max(1, Math.ceil(remainingMs / 1000));
}

function rateLimited(remainingMs: number): AdmitFail {
  return {
    ok: false,
    status: 429,
    code: "RATE_LIMITED",
    message: RATE_LIMITED_MESSAGE,
    retryAfterSec: retryAfterSec(remainingMs),
  };
}

function prunePublicBuckets(now: number): void {
  for (const [ip, bucket] of publicBuckets) {
    const expired = now - bucket.windowStart >= WINDOW_MS;
    if (expired && bucket.inflight === 0) {
      publicBuckets.delete(ip);
      publicInflight.delete(ip);
    }
  }
}

/**
 * ASK_TRUST_PROXY: true only for true / 1 / on / yes after trim, case-insensitive.
 * Missing, blank, and every other value are false.
 */
export function parseAskTrustProxy(raw: string | undefined = process.env.ASK_TRUST_PROXY): boolean {
  if (typeof raw !== "string") return false;
  return TRUST_TRUE.has(raw.trim().toLowerCase());
}

/**
 * Client IP used for public admission.
 * When the proxy is trusted, only X-Real-IP is read. X-Forwarded-For is ignored.
 * A non-IP or untrusted request resolves to "unknown".
 */
export function resolveAskClientIp(headers: Headers, trust: boolean = parseAskTrustProxy()): string {
  if (!trust) return "unknown";
  const raw = headers.get("x-real-ip");
  if (raw == null) return "unknown";
  const ip = raw.trim();
  if (ip.length === 0 || isIP(ip) === 0) return "unknown";
  return ip;
}

/**
 * Local admission: one in-flight answer per cacheKey, then a fixed 60s window of 6.
 * A busy lock returns 409 and does not consume the window.
 * A window rejection releases the lock just taken.
 */
export function admitAskLocal(cacheKey: string): AdmitResult {
  if (localLocks.has(cacheKey)) {
    return { ok: false, status: 409, code: "ASK_BUSY", message: ASK_BUSY_MESSAGE };
  }

  const token = Symbol(cacheKey);
  localLocks.set(cacheKey, token);

  const now = nowMs();
  const window = localWindows.get(cacheKey);
  const open = window != null && now - window.windowStart < WINDOW_MS;
  if (open && window.count >= MAX_PER_WINDOW) {
    const retry = rateLimited(WINDOW_MS - (now - window.windowStart));
    if (localLocks.get(cacheKey) === token) localLocks.delete(cacheKey);
    return retry;
  }
  if (open) {
    window.count += 1;
  } else {
    localWindows.set(cacheKey, { count: 1, windowStart: now });
  }

  return {
    ok: true,
    release: () => {
      if (localLocks.get(cacheKey) === token) localLocks.delete(cacheKey);
    },
  };
}

/**
 * Public admission: per-IP fixed window (≤6) and in-flight cap (≤2), checked before mutation.
 * Expired idle buckets are pruned. A full map refuses an unseen IP.
 */
export function admitAskPublic(ip: string): AdmitResult {
  const now = nowMs();
  prunePublicBuckets(now);

  const existing = publicBuckets.get(ip);
  if (existing) {
    const expired = now - existing.windowStart >= WINDOW_MS;
    const count = expired ? 0 : existing.count;
    if (count >= MAX_PER_WINDOW) {
      return rateLimited(WINDOW_MS - (now - existing.windowStart));
    }
    if (existing.inflight >= MAX_PUBLIC_INFLIGHT) {
      return rateLimited(1_000);
    }
  } else if (publicBuckets.size >= MAX_BUCKETS) {
    return rateLimited(WINDOW_MS);
  }

  const token = Symbol(ip);
  const bucket = publicBuckets.get(ip);
  if (bucket) {
    if (now - bucket.windowStart >= WINDOW_MS) {
      bucket.count = 0;
      bucket.windowStart = now;
    }
    bucket.count += 1;
    bucket.inflight += 1;
  } else {
    publicBuckets.set(ip, { count: 1, windowStart: now, inflight: 1 });
  }

  let tokens = publicInflight.get(ip);
  if (!tokens) {
    tokens = new Set();
    publicInflight.set(ip, tokens);
  }
  tokens.add(token);

  return {
    ok: true,
    release: () => {
      const held = publicInflight.get(ip);
      if (!held || !held.has(token)) return;
      held.delete(token);
      if (held.size === 0) publicInflight.delete(ip);
      const current = publicBuckets.get(ip);
      if (!current) return;
      current.inflight = Math.max(0, current.inflight - 1);
    },
  };
}

/** Delegate to the local lock+window or the public IP bucket. */
export function admitAsk(input: {
  mode: "local" | "public";
  cacheKey: string;
  ip: string;
}): AdmitResult {
  if (input.mode === "local") return admitAskLocal(input.cacheKey);
  return admitAskPublic(input.ip);
}

/** Drop every in-memory lock, window, and bucket. Test-only. */
export function resetAskControlForTests(): void {
  localLocks.clear();
  localWindows.clear();
  publicBuckets.clear();
  publicInflight.clear();
}
