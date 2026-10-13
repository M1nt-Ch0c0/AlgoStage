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

/** 只按明确的传输错误分类；错误正文、URL 和 Key 都不进入日志。 */
export function isTransientUpstreamError(error: unknown): boolean {
  const visited = new Set<unknown>();
  let current = error;
  let networkFailure = false;
  while (current instanceof Error && !visited.has(current)) {
    visited.add(current);
    if (current instanceof AIEgressError) return current.retryable;
    // HTTP 状态优先：只允许 5xx 和 429，不用未知状态或 2xx 推测传输失败。
    if (APICallError.isInstance(current) && current.statusCode !== undefined)
      return current.statusCode === 429 || (current.statusCode >= 500 && current.statusCode < 600);
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
