import { APICallError, InvalidResponseDataError } from "ai";
import { AIEgressError } from "@/lib/ai/egress-guard";

export const UPSTREAM_RETRY_LIMIT = 1;
const networkCodes = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "ENETRESET",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "UND_ERR_SOCKET",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
]);

/** 保留 SDK HTTP 状态及流内结构化鉴权标志；不解析 message；2xx 时只从 responseBody 的 JSON/SSE 结构里找鉴权标志。 */
export function upstreamStatusCode(error: unknown): number | undefined {
  const visited = new Set<unknown>();
  const pending: unknown[] = [error];
  let fallback: number | undefined;
  while (pending.length) {
    const current = pending.pop();
    if (!current || typeof current !== "object" || visited.has(current)) continue;
    visited.add(current);
    if (APICallError.isInstance(current)) {
      const code = current.statusCode;
      // A 2xx APICallError means the body was unusable (for example an SSE
      // body or `{error:{...}}` sent to a non-stream request). Look for the
      // same structured auth markers the streaming path reads from raw chunks.
      if (code !== undefined && (code < 200 || code >= 300)) return code;
      // Known limit (P3, v0.2.2): if the relay sends an SSE auth-error line and
      // then destroys the socket instead of ending the response, the SDK's
      // non-stream path (`response.text()` in generateText) rejects with
      // TypeError("terminated") <- undici SocketError(UND_ERR_SOCKET) and
      // `responseBody` is undefined: undici drops the partially received
      // bytes, so there is nothing structured to scan here. Hint and
      // test-connection therefore map that case to UPSTREAM_ERROR (502,
      // retryable). Verified with ai 7.0.99 / @ai-sdk/openai-compatible
      // 3.0.48. Fixing it needs those routes to use streaming requests (same
      // change as the known no-body-disconnect P3), not body scraping here.
      pending.push(current.data, ...structuredBodies(current.responseBody));
      if (code !== undefined) fallback ??= code;
    }
    // SSE error parts may be plain objects rather than Error instances.
    // Only known auth markers affect classification; arbitrary upstream codes
    // and text never become client error codes or log fields.
    const details = current as {
      statusCode?: unknown; status?: unknown; code?: unknown; type?: unknown;
      cause?: unknown; error?: unknown;
    };
    for (const value of [details.statusCode, details.status, details.code]) {
      if (value === 401 || value === "401") return 401;
      if (value === 403 || value === "403") return 403;
    }
    for (const value of [details.type, details.code]) {
      if (value === "authentication_error" || value === "invalid_api_key") return 401;
      if (value === "permission_error" || value === "permission_denied" || value === "insufficient_permissions") return 403;
    }
    pending.push(details.error, details.cause, (current as { value?: unknown }).value);
  }
  return fallback;
}

/**
 * Parse a JSON or SSE body into objects for marker checks only; never logged.
 * Intentional cap: bodies over 1,000,000 chars are not parsed, so a 2xx body
 * that large is never read as an auth error and hint/test-connection return
 * 502 UPSTREAM_ERROR. Lecture still reports 400 UPSTREAM_AUTH there because it
 * streams and classifies per chunk, not through this whole-body path. The cap
 * keeps the error path bounded (no multi-MB JSON.parse/split per failure).
 */
function structuredBodies(body: unknown): unknown[] {
  if (typeof body !== "string" || body.length > 1_000_000) return [];
  const parse = (text: string) => { try { return [JSON.parse(text)]; } catch { return []; } };
  const whole = parse(body.trim());
  if (whole.length) return whole;
  return body.split(/\r?\n/)
    .filter(line => line.startsWith("data:"))
    .flatMap(line => parse(line.slice(5).trim()));
}

/** 只按明确的传输错误分类；错误正文、URL 和 Key 都不进入日志。 */
export function isTransientUpstreamError(error: unknown): boolean {
  // HTTP 状态优先：只允许 5xx 和 429，401/403 即使被网络异常包装也不重试。
  const status = upstreamStatusCode(error);
  if (status !== undefined) return status === 429 || (status >= 500 && status < 600);
  const visited = new Set<unknown>();
  let current = error;
  let networkFailure = false;
  while (current instanceof Error && !visited.has(current)) {
    visited.add(current);
    if (current instanceof AIEgressError) return current.retryable;
    if (InvalidResponseDataError.isInstance(current)) {
      // 兼容 SDK 对 SSE 提前关闭的固定错误；其他协议/内容错误不重试。
      networkFailure ||=
        current.message === "Response stream ended without a finish reason.";
    }
    const code = (current as Error & { code?: unknown }).code;
    networkFailure ||= typeof code === "string" && networkCodes.has(code);
    networkFailure ||= current.name === "TimeoutError" || current.name === "NetworkError";
    networkFailure ||=
      current instanceof TypeError &&
      /^(fetch failed|failed to fetch|networkerror when attempting to fetch resource\.?|terminated)$/i.test(
        current.message,
      );
    current = current.cause;
  }
  return networkFailure;
}

/** 短退避也共用请求的总截止时间，取消后不会发出下一次请求。 */
export function waitForUpstreamRetry(
  signal: AbortSignal,
  delayMs = 200,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(new DOMException("请求已取消", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, delayMs);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}
