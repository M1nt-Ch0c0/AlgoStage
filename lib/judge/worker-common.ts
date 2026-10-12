import type { JudgeCaseResult, WorkerReply } from "./types";
export const scope = self as unknown as { postMessage(message: WorkerReply): void; onmessage: ((event: MessageEvent) => void) | null };
export const OUTPUT_LIMIT = 32768;
export function outputCollector() {
  let bytes = 0, text = "", exceeded = false;
  const decoder = new TextDecoder();
  return {
    write(buffer: Uint8Array) {
      bytes += buffer.byteLength;
      if (bytes > OUTPUT_LIMIT) {
        if (!exceeded) scope.postMessage({ type: "output-limit" });
        exceeded = true;
        throw new Error("输出超过 32 KiB");
      }
      text += decoder.decode(buffer, { stream: true });
      return buffer.byteLength;
    },
    print(...values: unknown[]) { this.write(new TextEncoder().encode(values.map(String).join(" ") + "\n")); },
    text() { return text; },
  };
}
export function display(value: unknown): string {
  const text = JSON.stringify(value) ?? "undefined";
  if (new TextEncoder().encode(text).byteLength > OUTPUT_LIMIT) { scope.postMessage({ type: "output-limit" }); throw new Error("返回值过大"); }
  return text;
}
export function postResult(result: JudgeCaseResult) { scope.postMessage({ type: "case-result", result }); }
