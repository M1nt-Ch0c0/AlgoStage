/** 增量读取已校验步骤；完整 result 到达前不能当作完成的教案。 */
import { ByokError, resolveByokError, toByokError } from "@/lib/byok/client";
import { teachingStepSchema } from "@/lib/teaching/schema";
import type { TeachingStep } from "@/lib/teaching/types";
export async function readLectureResponse(
  response: Response,
  onProgress: (message: string) => void,
  onStep?: (step: TeachingStep, update: boolean) => void,
): Promise<unknown> {
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw toByokError(
      data,
      "这次备课未能完成，请重试或换用 gpt-6.1-sol。",
    );
  }
  if (
    !(response.headers.get("content-type") ?? "").includes(
      "application/x-ndjson",
    )
  )
    return (await response.json()).script;
  if (!response.body)
    throw new ByokError("EMPTY_BODY", "没有收到教案，请重试或换用 gpt-6.1-sol。");
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let buffer = "",
    script: unknown,
    complete = false;
  const parse = (line: string) => {
    if (!line.trim()) return;
    const event = JSON.parse(line);
    if (
      event.type === "progress" &&
      Number.isInteger(event.attempt) &&
      event.attempt >= 1 &&
      typeof event.message === "string"
    )
      onProgress(event.message);
    else if (event.type === "step" || event.type === "step-update")
      onStep?.(
        teachingStepSchema.parse(event.step),
        event.type === "step-update",
      );
    else if (event.type === "result") {
      script = event.script;
      complete = true;
    } else if (event.type === "error") {
      const resolved = resolveByokError(event);
      if (resolved?.code === "UPSTREAM_ERROR" && resolved.rawMessage) {
        console.warn(resolved.rawMessage);
      }
      throw resolved
        ? new ByokError(resolved.code, resolved.message)
        : new ByokError("STREAM_ERROR", "备课失败，请重试或换用 gpt-6.1-sol。");
    } else
      throw new ByokError("INVALID_STREAM", "备课数据无法读取，请重试或换用 gpt-6.1-sol。");
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      if (buffer.length > 1024 * 1024)
        throw new ByokError("PAYLOAD_TOO_LARGE", "教案数据过大，请重试。");
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
      }
      if (done) break;
    }
    parse(buffer);
    if (!complete)
      throw new ByokError(
        "INCOMPLETE_STREAM",
        "备课中断，未收到完整教案，请重试或换用 gpt-6.1-sol。",
      );
    return script;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
