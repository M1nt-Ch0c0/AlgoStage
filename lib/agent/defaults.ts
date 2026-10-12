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
