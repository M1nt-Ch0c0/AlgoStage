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

/** 保留 SDK HTTP 状态及流内结构化鉴权标志；不解析 message 或 responseBody。 */
export function upstreamStatusCode(error: unknown): number | undefined {
  const visited = new Set<unknown>();
  const pending: unknown[] = [error];
  while (pending.length) {
    const current = pending.pop();
    if (!current || typeof current !== "object" || visited.has(current)) continue;
    visited.add(current);
    if (APICallError.isInstance(current) && current.statusCode !== undefined)
      return current.statusCode;
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
    pending.push(details.error, details.cause);
  }
  return undefined;
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
