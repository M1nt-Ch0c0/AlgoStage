/** 客户端和服务端共用推荐模型，不引入服务端 SDK。 */
export const DEFAULT_MODEL = "gpt-6.1-sol";

/** 多轮工具生成的总时限，客户端稍晚取消以便展示服务端超时原因。 */
export const LECTURE_TIMEOUT_MS = 240000;
