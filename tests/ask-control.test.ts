import { afterEach, describe, expect, test, vi } from "vitest";
import {
  ASK_BUSY_MESSAGE,
  MAX_BUCKETS,
  MAX_PER_WINDOW,
  MAX_PUBLIC_INFLIGHT,
  WINDOW_MS,
  admitAsk,
  admitAskLocal,
  admitAskPublic,
  parseAskTrustProxy,
  resetAskControlForTests,
  resolveAskClientIp,
} from "../lib/ask/ask-control";

afterEach(() => {
  resetAskControlForTests();
  vi.useRealTimers();
  delete process.env.ASK_TRUST_PROXY;
});

function headers(init: Record<string, string>): Headers {
  return new Headers(init);
}

describe("parseAskTrustProxy", () => {
  test("true only for true/1/on/yes after trim, case-insensitive", () => {
    expect(parseAskTrustProxy(undefined)).toBe(false);
    expect(parseAskTrustProxy("")).toBe(false);
    expect(parseAskTrustProxy("  ")).toBe(false);
    expect(parseAskTrustProxy("false")).toBe(false);
    expect(parseAskTrustProxy("0")).toBe(false);
    expect(parseAskTrustProxy("off")).toBe(false);
    expect(parseAskTrustProxy("no")).toBe(false);
    expect(parseAskTrustProxy("yes please")).toBe(false);

    for (const raw of ["true", "TRUE", " True ", "1", " 1 ", "on", "ON", "yes", "YeS"]) {
      expect(parseAskTrustProxy(raw)).toBe(true);
    }
  });

  test("reads ASK_TRUST_PROXY when raw is omitted", () => {
    delete process.env.ASK_TRUST_PROXY;
    expect(parseAskTrustProxy()).toBe(false);
    process.env.ASK_TRUST_PROXY = " YES ";
    expect(parseAskTrustProxy()).toBe(true);
  });
});

describe("resolveAskClientIp", () => {
  test("untrusted proxy is always unknown and ignores X-Real-IP", () => {
    const h = headers({ "x-real-ip": "203.0.113.8", "x-forwarded-for": "198.51.100.9" });
    expect(resolveAskClientIp(h, false)).toBe("unknown");
    expect(resolveAskClientIp(h)).toBe("unknown");
  });

  test("trusted proxy accepts IPv4 and IPv6, rejects invalid, never uses X-Forwarded-For", () => {
    expect(resolveAskClientIp(headers({ "x-real-ip": " 203.0.113.8 " }), true)).toBe("203.0.113.8");
    expect(resolveAskClientIp(headers({ "x-real-ip": "2001:db8::1" }), true)).toBe("2001:db8::1");
    expect(resolveAskClientIp(headers({ "x-real-ip": "::1" }), true)).toBe("::1");
    expect(resolveAskClientIp(headers({ "x-real-ip": "  ::ffff:127.0.0.1  " }), true)).toBe("::ffff:127.0.0.1");

    expect(resolveAskClientIp(headers({ "x-real-ip": "not-an-ip" }), true)).toBe("unknown");
    expect(resolveAskClientIp(headers({ "x-real-ip": "203.0.113.8, 198.51.100.9" }), true)).toBe("unknown");
    expect(resolveAskClientIp(headers({ "x-real-ip": "" }), true)).toBe("unknown");
    expect(resolveAskClientIp(headers({ "x-real-ip": "   " }), true)).toBe("unknown");
    expect(resolveAskClientIp(headers({}), true)).toBe("unknown");

    const forwardedOnly = headers({ "x-forwarded-for": "198.51.100.9" });
    expect(resolveAskClientIp(forwardedOnly, true)).toBe("unknown");

    const both = headers({
      "x-real-ip": "203.0.113.8",
      "x-forwarded-for": "198.51.100.9",
    });
    expect(resolveAskClientIp(both, true)).toBe("203.0.113.8");
  });
});

describe("admitAskLocal", () => {
  test("second request on the same cacheKey is ASK_BUSY and does not consume quota", () => {
    const first = admitAskLocal("cache-a");
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const busy = admitAskLocal("cache-a");
    expect(busy).toEqual({
      ok: false,
      status: 409,
      code: "ASK_BUSY",
      message: ASK_BUSY_MESSAGE,
    });
    expect(busy.ok).toBe(false);
    if (!busy.ok) {
      expect(busy.message).toBe("上一个问题还在回答，答完再问");
      expect(busy.retryAfterSec).toBeUndefined();
    }

    // Busy rejection must not count. After release, five more admits still fit
    // (the held request already consumed one of the six).
    first.release();
    for (let i = 0; i < MAX_PER_WINDOW - 1; i += 1) {
      const next = admitAskLocal("cache-a");
      expect(next.ok).toBe(true);
      if (next.ok) next.release();
    }
  });

  test("different cacheKeys admit concurrently", () => {
    const a = admitAskLocal("cache-a");
    const b = admitAskLocal("cache-b");
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
  });

  test("release allows the next request on the same cacheKey", () => {
    const first = admitAskLocal("cache-a");
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(admitAskLocal("cache-a").ok).toBe(false);
    first.release();
    const second = admitAskLocal("cache-a");
    expect(second.ok).toBe(true);
    // A mismatched or repeated release does not drop a newer lock.
    first.release();
    expect(admitAskLocal("cache-a").ok).toBe(false);
    if (second.ok) second.release();
    expect(admitAskLocal("cache-a").ok).toBe(true);
  });

  test("7th request inside the window is 429 and releases the lock it just took", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-14T00:00:00.000Z"));

    for (let i = 0; i < MAX_PER_WINDOW; i += 1) {
      const admitted = admitAskLocal("cache-a");
      expect(admitted.ok).toBe(true);
      if (admitted.ok) admitted.release();
      vi.advanceTimersByTime(1_000);
    }

    const seventh = admitAskLocal("cache-a");
    expect(seventh.ok).toBe(false);
    if (!seventh.ok) {
      expect(seventh.status).toBe(429);
      expect(seventh.code).toBe("RATE_LIMITED");
      expect(seventh.retryAfterSec).toBeGreaterThanOrEqual(1);
      // Window opened at t=0. The 7th call is at t=6s, so 54s remain.
      expect(seventh.retryAfterSec).toBe(Math.ceil((WINDOW_MS - 6_000) / 1000));
    }

    // The rejected call released its lock, so a later window can admit again.
    vi.advanceTimersByTime(WINDOW_MS);
    const after = admitAskLocal("cache-a");
    expect(after.ok).toBe(true);
  });

  test("busy rejection does not consume the 60s window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-14T00:00:00.000Z"));

    const held = admitAskLocal("cache-a");
    expect(held.ok).toBe(true);
    for (let i = 0; i < 5; i += 1) {
      const busy = admitAskLocal("cache-a");
      expect(busy.ok).toBe(false);
      if (!busy.ok) expect(busy.code).toBe("ASK_BUSY");
    }
    if (held.ok) held.release();

    const admitted: Array<() => void> = [];
    for (let i = 0; i < MAX_PER_WINDOW - 1; i += 1) {
      const next = admitAskLocal("cache-a");
      expect(next.ok).toBe(true);
      if (next.ok) {
        next.release();
        admitted.push(next.release);
      }
    }
    // One consumed by `held`, five more just now → 6. The 7th is the first 429.
    const overflow = admitAskLocal("cache-a");
    expect(overflow.ok).toBe(false);
    if (!overflow.ok) expect(overflow.code).toBe("RATE_LIMITED");
    expect(admitted).toHaveLength(MAX_PER_WINDOW - 1);
  });
});

describe("admitAskPublic", () => {
  test("two in-flight requests on one IP succeed; the third is 429", () => {
    const a = admitAskPublic("203.0.113.1");
    const b = admitAskPublic("203.0.113.1");
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);

    const third = admitAskPublic("203.0.113.1");
    expect(third.ok).toBe(false);
    if (!third.ok) {
      expect(third.status).toBe(429);
      expect(third.code).toBe("RATE_LIMITED");
      expect(third.retryAfterSec).toBeGreaterThanOrEqual(1);
    }

    // A different IP is independent and may take its own two slots.
    const other = admitAskPublic("203.0.113.2");
    const other2 = admitAskPublic("203.0.113.2");
    expect(other.ok).toBe(true);
    expect(other2.ok).toBe(true);
    expect(admitAskPublic("203.0.113.2").ok).toBe(false);
  });

  test("Retry-After is the remaining window, at least 1 second", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-14T00:00:00.000Z"));

    const releases: Array<() => void> = [];
    for (let i = 0; i < MAX_PER_WINDOW; i += 1) {
      const admitted = admitAskPublic("203.0.113.8");
      expect(admitted.ok).toBe(true);
      if (admitted.ok) {
        releases.push(admitted.release);
        admitted.release();
      }
    }

    vi.advanceTimersByTime(10_500);
    const blocked = admitAskPublic("203.0.113.8");
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.retryAfterSec).toBe(Math.max(1, Math.ceil((WINDOW_MS - 10_500) / 1000)));
    }

    // Inflight cap uses a 1s Retry-After and does not depend on the window.
    const heldA = admitAskPublic("203.0.113.9");
    const heldB = admitAskPublic("203.0.113.9");
    expect(heldA.ok && heldB.ok).toBe(true);
    const inflight = admitAskPublic("203.0.113.9");
    expect(inflight.ok).toBe(false);
    if (!inflight.ok) expect(inflight.retryAfterSec).toBe(1);

    expect(releases).toHaveLength(MAX_PER_WINDOW);
    expect(MAX_PUBLIC_INFLIGHT).toBe(2);
  });

  test("release frees an in-flight slot and a second release is a no-op", () => {
    const first = admitAskPublic("203.0.113.4");
    const second = admitAskPublic("203.0.113.4");
    expect(first.ok && second.ok).toBe(true);
    expect(admitAskPublic("203.0.113.4").ok).toBe(false);
    if (!first.ok) return;
    first.release();
    first.release();
    const third = admitAskPublic("203.0.113.4");
    expect(third.ok).toBe(true);
  });

  test("window count is checked before mutation and resets after WINDOW_MS", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-14T00:00:00.000Z"));

    for (let i = 0; i < MAX_PER_WINDOW; i += 1) {
      const admitted = admitAskPublic("203.0.113.5");
      expect(admitted.ok).toBe(true);
      if (admitted.ok) admitted.release();
    }
    expect(admitAskPublic("203.0.113.5").ok).toBe(false);

    vi.advanceTimersByTime(WINDOW_MS);
    const again = admitAskPublic("203.0.113.5");
    expect(again.ok).toBe(true);
  });

  test("refuses a new IP once 10000 buckets are held", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-14T00:00:00.000Z"));

    for (let i = 0; i < MAX_BUCKETS; i += 1) {
      const admitted = admitAskPublic(`10.0.0.${i}`);
      expect(admitted.ok).toBe(true);
      if (admitted.ok) admitted.release();
    }

    const overflow = admitAskPublic("203.0.113.50");
    expect(overflow.ok).toBe(false);
    if (!overflow.ok) {
      expect(overflow.status).toBe(429);
      expect(overflow.code).toBe("RATE_LIMITED");
      expect(overflow.retryAfterSec).toBeGreaterThanOrEqual(1);
    }

    // An IP already present can still be admitted inside its window.
    const known = admitAskPublic("10.0.0.0");
    expect(known.ok).toBe(true);

    // Expired idle buckets are pruned, so a new IP fits afterwards.
    vi.advanceTimersByTime(WINDOW_MS);
    if (known.ok) known.release();
    const afterPrune = admitAskPublic("203.0.113.50");
    expect(afterPrune.ok).toBe(true);
  });

  test("expired idle buckets are pruned; an in-flight bucket keeps its slot", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-14T00:00:00.000Z"));

    const held = admitAskPublic("10.0.0.0");
    expect(held.ok).toBe(true);
    for (let i = 1; i < MAX_BUCKETS; i += 1) {
      const admitted = admitAskPublic(`10.1.${Math.floor(i / 256)}.${i % 256}`);
      expect(admitted.ok).toBe(true);
      if (admitted.ok) admitted.release();
    }
    expect(admitAskPublic("203.0.113.77").ok).toBe(false);

    vi.advanceTimersByTime(WINDOW_MS);
    // Idle buckets are gone, so a new IP fits. The held IP still occupies one in-flight slot.
    const fresh = admitAskPublic("203.0.113.77");
    expect(fresh.ok).toBe(true);
    const secondOnHeld = admitAskPublic("10.0.0.0");
    expect(secondOnHeld.ok).toBe(true);
    const thirdOnHeld = admitAskPublic("10.0.0.0");
    expect(thirdOnHeld.ok).toBe(false);
    if (!thirdOnHeld.ok) expect(thirdOnHeld.retryAfterSec).toBe(1);
  });
});

describe("admitAsk", () => {
  test("delegates local and public modes", () => {
    const local = admitAsk({ mode: "local", cacheKey: "k", ip: "203.0.113.1" });
    expect(local.ok).toBe(true);
    const busy = admitAsk({ mode: "local", cacheKey: "k", ip: "203.0.113.1" });
    expect(busy.ok).toBe(false);
    if (!busy.ok) expect(busy.code).toBe("ASK_BUSY");

    const pub = admitAsk({ mode: "public", cacheKey: "k", ip: "203.0.113.1" });
    expect(pub.ok).toBe(true);
    if (local.ok) local.release();
    if (pub.ok) pub.release();
  });
});

describe("resetAskControlForTests", () => {
  test("clears local locks, local windows, and public buckets", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-14T00:00:00.000Z"));

    const local = admitAskLocal("cache-a");
    expect(local.ok).toBe(true);
    for (let i = 0; i < MAX_PER_WINDOW; i += 1) {
      const admitted = admitAskPublic("203.0.113.8");
      expect(admitted.ok).toBe(true);
      if (admitted.ok) admitted.release();
    }
    expect(admitAskPublic("203.0.113.8").ok).toBe(false);

    resetAskControlForTests();

    for (let i = 0; i < MAX_PER_WINDOW; i += 1) {
      const admitted = admitAskLocal("cache-a");
      expect(admitted.ok).toBe(true);
      if (admitted.ok) admitted.release();
    }
    // A full fresh window: the pre-reset admits no longer count, and the 7th is limited.
    const localOverflow = admitAskLocal("cache-a");
    expect(localOverflow.ok).toBe(false);
    if (!localOverflow.ok) expect(localOverflow.code).toBe("RATE_LIMITED");

    const pub = admitAskPublic("203.0.113.8");
    expect(pub.ok).toBe(true);
  });
});
