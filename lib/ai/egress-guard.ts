import { lookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";
import { Agent } from "undici";

export const INVALID_AI_BASE_URL = "接口地址只支持公网 http(s) 地址。";
export const AI_CONNECTION_ERROR = "无法连接到 AI 服务，请检查接口地址。";

export class InvalidAIBaseURLError extends Error {
  constructor() {
    super(INVALID_AI_BASE_URL);
    this.name = "InvalidAIBaseURLError";
  }
}

export class AIEgressError extends Error {
  constructor(readonly retryable = false) {
    super(AI_CONNECTION_ERROR);
    this.name = "AIEgressError";
  }
}

/** Policy failures are field errors while editing settings, fixed 502s at runtime. */
export class AIBaseURLNotAllowedError extends AIEgressError {}

function httpURL(value: string): URL {
  if (!/^https?:\/\/[^/\\\s]/i.test(value) || /[\\\s]/.test(value)) throw new InvalidAIBaseURLError();
  const url = new URL(value);
  if (!url.hostname || !["http:", "https:"].includes(url.protocol))
    throw new InvalidAIBaseURLError();
  // Userinfo never identifies the destination or supplies SDK credentials.
  // Strip it so fetch accepts these URLs in self-hosted mode as well.
  url.username = "";
  url.password = "";
  return url;
}

/** 空值交给 provider 使用默认地址；WHATWG URL 同时规范化非常规 IP 写法。 */
export function normalizeAIBaseURL(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  try {
    const url = httpURL(trimmed);
    const path = url.pathname.replace(/\/v1(?:\/v1)+(?=\/|$)/g, "/v1").replace(/\/+$/, "");
    return `${url.origin}${path}${url.search}${url.hash}`;
  } catch {
    throw new InvalidAIBaseURLError();
  }
}

function blockedIPv4(address: string): boolean {
  const [a, b, c] = address.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113);
}

/** Fail closed for special/reserved ranges, including IPv4 hidden inside IPv6. */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return blockedIPv4(address);
  if (family !== 6) return true;
  // URL converts dotted IPv4 suffixes to hex, so both mapped forms share a check.
  let canonical: string;
  try { canonical = new URL(`http://[${address}]`).hostname.slice(1, -1); }
  catch { return true; }
  const halves = canonical.split("::");
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const groups = halves.length === 1 ? left : [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right];
  const value = groups.reduce((n, group) => (n << 16n) | BigInt(`0x${group}`), 0n);
  if (value >> 32n === 0xffffn) {
    const v4 = Number(value & 0xffffffffn);
    return blockedIPv4([v4 >>> 24, (v4 >>> 16) & 255, (v4 >>> 8) & 255, v4 & 255].join("."));
  }
  // Only global unicast 2000::/3, excluding IETF special use, documentation and
  // 6to4 (which can tunnel to a private IPv4 destination). This also excludes
  // unspecified, loopback, ULA, link/site local, multicast and NAT64 ranges.
  return value >> 125n !== 1n || // outside 2000::/3
    value >> 105n === (0x2001n << 7n) || // 2001::/23
    value >> 96n === 0x20010db8n || // 2001:db8::/32
    value >> 112n === 0x2002n || // 2002::/16
    value >> 108n === 0x3fff0n; // 3fff::/20
}

async function lookupAddresses(hostname: string, signal?: AbortSignal | null) {
  if (!signal) return lookup(hostname, { all: true });
  signal.throwIfAborted();
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([lookup(hostname, { all: true }), cancelled]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

function normalizedHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, "");
}

function isAllowlisted(hostname: string): boolean {
  const name = normalizedHostname(hostname);
  return (process.env.ALGOSTAGE_EGRESS_ALLOW_HOSTS ?? "").split(",").some(entry => {
    const host = entry.trim();
    return host !== "" && !host.includes("*") && normalizedHostname(host) === name;
  });
}

async function validatedAddresses(url: URL, signal?: AbortSignal | null) {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const allowPrivate = process.env.ALGOSTAGE_ALLOW_PRIVATE_BASE_URL?.trim().toLowerCase() !== "false" || isAllowlisted(url.hostname);
  const name = normalizedHostname(hostname);
  if (!allowPrivate && (name === "localhost" || name.endsWith(".localhost"))) throw new AIBaseURLNotAllowedError();

  const family = isIP(hostname);
  const addresses = family ? [{ address: hostname, family }] : await lookupAddresses(hostname, signal);
  signal?.throwIfAborted();
  if (!addresses.length || addresses.some(item =>
    !isIP(item.address) || isIP(item.address) !== item.family || (!allowPrivate && isBlockedAddress(item.address)),
  )) throw new AIBaseURLNotAllowedError();
  return { hostname, family, addresses };
}

/** Save-time validation does no HTTP I/O; every later connection validates again. */
export async function validateAIBaseURL(value: string, signal?: AbortSignal | null): Promise<string> {
  const normalized = normalizeAIBaseURL(value);
  if (!normalized) return normalized;
  try {
    await validatedAddresses(httpURL(normalized), signal);
    return normalized;
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (error instanceof AIEgressError) throw error;
    throw new AIEgressError(true);
  }
}

async function pinnedAgent(url: URL, signal?: AbortSignal | null): Promise<Agent> {
  const { hostname, family, addresses } = await validatedAddresses(url, signal);

  // A new dispatcher per request cannot reuse a pool validated for another DNS
  // answer. The lookup hook never resolves again, even on connection retries.
  const pinned = { ...addresses[0] };
  const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
    if (options.all) callback(null, [pinned]);
    else callback(null, pinned.address, pinned.family);
  };
  return new Agent({ connect: { lookup: pinnedLookup, ...(!family ? { servername: hostname } : {}) } });
}

/** Every server AI SDK must use this fetch; neither DNS nor redirects may bypass it. */
export const aiEgressFetch: typeof fetch = async (input, init) => {
  let dispatcher: Agent | undefined;
  let signal: AbortSignal | null | undefined;
  try {
    let target: string;
    let requestInit: RequestInit & { duplex?: "half" } = { ...init };
    if (input instanceof Request) {
      const request = new Request(input, init);
      target = request.url;
      // Next's patched fetch merges Request + init into a Request, which drops
      // the nonstandard dispatcher. Pass a URL plus init so pinning survives.
      requestInit = {
        ...requestInit,
        method: request.method,
        headers: request.headers,
        body: request.body,
        signal: request.signal,
        credentials: request.credentials,
        integrity: request.integrity,
        keepalive: request.keepalive,
        mode: request.mode,
        referrer: request.referrer,
        referrerPolicy: request.referrerPolicy,
        duplex: "half",
      };
    } else {
      // Snapshot mutable URL objects before awaiting DNS.
      target = String(input);
    }
    signal = requestInit.signal;
    signal?.throwIfAborted();
    const url = httpURL(target);
    dispatcher = await pinnedAgent(url, signal);
    signal?.throwIfAborted();
    const options: RequestInit & { dispatcher: Agent } = { ...requestInit, cache: "no-store", redirect: "manual", dispatcher };
    const response = await globalThis.fetch(url.href, options);
    if (response.status >= 300 && response.status < 400) {
      void response.body?.cancel().catch(() => {});
      throw new AIEgressError();
    }
    if (!response.ok) {
      // SDK errors retain only the status, never an upstream body that can echo
      // credentials. 401/403 still produce the existing invalid-key message.
      void response.body?.cancel().catch(() => {});
      return new Response(null, { status: response.status });
    }
    return response;
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (error instanceof AIEgressError) throw error;
    throw new AIEgressError(true);
  } finally {
    // close() drains in-flight bodies (including SSE) before closing sockets;
    // do not await it here, since the SDK has not consumed the response yet.
    if (dispatcher) void dispatcher.close().catch(() => {});
  }
};
