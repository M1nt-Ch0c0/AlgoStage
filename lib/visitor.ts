/**
 * 当前用户 ID（仅服务端 Route Handler 使用）
 * 本地单用户固定为 local-default。
 */
const LOCAL_USER = "local-default";

export async function currentUserId(): Promise<string> {
  return LOCAL_USER;
}
