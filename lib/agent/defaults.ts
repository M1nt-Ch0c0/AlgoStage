/** 客户端和服务端共用推荐模型，不引入服务端 SDK。 */
export const DEFAULT_MODEL = "gpt-6.1-sol";

/** 多轮工具生成的总时限，客户端稍晚取消以便展示服务端超时原因。 */
export const LECTURE_TIMEOUT_MS = 240000;

/** 提示接口上游总时限（毫秒），可用 HINT_TIMEOUT_MS 覆盖。 */
export const HINT_TIMEOUT_MS = 60_000;

/** 解析 HINT_TIMEOUT_MS：仅正整数毫秒生效，其余回退默认。 */
export function hintTimeoutMs(raw = process.env.HINT_TIMEOUT_MS): number {
  if (typeof raw !== "string") return HINT_TIMEOUT_MS;
  const trimmed = raw.trim();
  if (!/^[1-9]\d*$/.test(trimmed)) return HINT_TIMEOUT_MS;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : HINT_TIMEOUT_MS;
}

/** 提问接口总时限（毫秒），可用 ASK_TIMEOUT_MS 覆盖。覆盖读体、预检、上游与落库。 */
export const ASK_TIMEOUT_MS = 90_000;

/** 解析 ASK_TIMEOUT_MS：仅正整数毫秒生效，其余回退 90 秒。大于 2^31-1 的安全整数原样返回。 */
export function askTimeoutMs(raw = process.env.ASK_TIMEOUT_MS): number {
  if (typeof raw !== "string") return ASK_TIMEOUT_MS;
  const trimmed = raw.trim();
  if (!/^[1-9]\d*$/.test(trimmed)) return ASK_TIMEOUT_MS;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : ASK_TIMEOUT_MS;
}
