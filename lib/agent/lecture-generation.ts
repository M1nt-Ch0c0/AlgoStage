/** 五个教学工具逐步构建教案；错误仅修复当次调用，成功步骤不重新生成。 */
import {
  streamText,
  APICallError,
  type ModelMessage,
  type ToolCallPart,
  type ToolResultPart,
} from "ai";
import { z, ZodError } from "zod";
import { createModel, type ByokConfig } from "./provider";
import { createLectureTools, ToolStateError } from "./lecture-tools";
import { isTransientUpstreamError, UPSTREAM_RETRY_LIMIT, waitForUpstreamRetry } from "./upstream-retry";
import type { TeachingScript, TeachingStep } from "@/lib/teaching/types";

import { LECTURE_TIMEOUT_MS } from "./defaults";
export { LECTURE_TIMEOUT_MS } from "./defaults";
export const TOOL_RETRY_LIMIT = 2;
export class InvalidLectureScriptError extends Error {}
export type LectureProgress = {
  attempt: number;
  phase: "generating" | "retry";
  message: string;
};
export type LectureEvent =
  | ({ type: "progress" } & LectureProgress)
  | { type: "step" | "step-update"; step: TeachingStep };
export type GenerationResult =
  | { ok: true; script: TeachingScript }
  | {
      ok: false;
      status: number;
      error: "INVALID_SCRIPT" | "UPSTREAM_ERROR" | "TIMEOUT" | "CANCELLED";
      message: string;
    };
const recommendation =
  "请点击重试，或换用推荐模型 gpt-6.1-sol；较弱模型可能无法完成讲解。";
const invalid: GenerationResult = {
  ok: false,
  status: 422,
  error: "INVALID_SCRIPT",
  message: `教案工具调用未能通过校验。${recommendation}`,
};

/** 日志只包含固定分类和 schema 字段；不记录参数、字幕、上游错误或密钥。 */
const safeFields = new Set([
  "id",
  "narration",
  "target",
  "kind",
  "blockId",
  "start",
  "end",
  "stepId",
  "effect",
  "targetIndex",
  "color",
  "intensity",
  "viz",
  "type",
  "state",
  "values",
  "highlight",
  "map",
  "scan",
  "hit",
  "captions",
  "nodeId",
  "text",
  "dwellMs",
]);
function failure(error: unknown) {
  if (error instanceof ToolStateError)
    return { type: error.failureType, fields: [error.field] };
  if (error instanceof ZodError)
    return {
      type: "invalid_parameters",
      fields: error.issues
        .map((issue) =>
          issue.path
            .map((p) =>
              typeof p === "number"
                ? "[]"
                : safeFields.has(String(p))
                  ? String(p)
                  : "[key]",
            )
            .join("."),
        )
        .slice(0, 6),
    };
  return { type: "invalid_parameters", fields: ["input"] };
}

export async function generateLecture(input: {
  config: ByokConfig;
  prompt: string;
  referenceCode: string;
  metadata: Omit<TeachingScript, "steps">;
  validate: (value: unknown) => TeachingScript;
  signal?: AbortSignal;
  timeoutMs?: number;
  onEvent?: (event: LectureEvent) => void;
}): Promise<GenerationResult> {
  const controller = new AbortController();
  const cancelled: GenerationResult = {
    ok: false,
    status: 499,
    error: "CANCELLED",
    message: "备课已取消，未保存教案。",
  };
  let timer: ReturnType<typeof setTimeout>;
  let cancel = () => {};
  const deadline = new Promise<GenerationResult>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({
        ok: false,
        status: 504,
        error: "TIMEOUT",
        message: `备课超时（总上限 ${Math.round((input.timeoutMs ?? LECTURE_TIMEOUT_MS) / 1000)} 秒），未保存教案。${recommendation}`,
      });
    }, input.timeoutMs ?? LECTURE_TIMEOUT_MS);
    cancel = () => {
      controller.abort();
      resolve(cancelled);
    };
    if (input.signal?.aborted) cancel();
    else input.signal?.addEventListener("abort", cancel, { once: true });
  });
  const run = async (): Promise<GenerationResult> => {
    const kit = createLectureTools(input.referenceCode);
    type Name = keyof typeof kit.tools;
    const stepOf = (name: Name, args: unknown) => {
      // finish 面向整份教案，使用固定编号，避免新增步骤后失去队列匹配。
      if (name === "finish") return 0;
      const parsed = z
        .object({ id: z.string().optional(), stepId: z.string().optional() })
        .safeParse(args);
      const id = parsed.success
        ? (parsed.data.stepId ?? parsed.data.id)
        : undefined;
      const index =
        id && /^s(?:[1-9]|1[0-2])$/.test(id) ? Number(id.slice(1)) : undefined;
      return (
        index ?? Math.max(1, kit.steps.length + (name === "add_step" ? 1 : 0))
      );
    };
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: "请按教案规范调用工具开始讲课，最后调用 finish。",
      },
    ];
    const repairs: {
      name: Name;
      attempt: number;
      step: number;
      fields: string[];
      stepId?: string;
    }[] = [];
    let noCalls = 0,
      upstreamRetries = 0,
      toolRetries = 0;
    for (let round = 1; round <= 48; round++) {
      if (controller.signal.aborted) return cancelled;
      const repair = repairs[0];
      if (repair) toolRetries++;
      input.onEvent?.({
        type: "progress",
        attempt: 1 + toolRetries + upstreamRetries,
        phase: repair ? "retry" : "generating",
        message: repair
          ? `第 ${repair.step} 步调用未通过校验，正在重试该调用（${repair.attempt}/${TOOL_RETRY_LIMIT + 1}）；已生成步骤保留…`
          : `已生成 ${kit.steps.length} 步，正在备课并播放…`,
      });
      const assistant: ToolCallPart[] = [],
        results: ToolResultPart[] = [];
      let finished = false;
      try {
        const stream = streamText({
          model: createModel(input.config),
          system: input.prompt,
          messages,
          tools: kit.tools,
          toolChoice: repair
            ? { type: "tool", toolName: repair.name }
            : "required",
          maxRetries: 0,
          maxOutputTokens: 7000,
          abortSignal: controller.signal,
          // 不输出 SDK 原始异常，避免兼容上游把密钥包含在响应正文中。
          onError: () => {},
          ...(input.config.provider === "openai-compatible" &&
          /^(deepseek-|gpt-)/.test(input.config.model)
            ? {
                providerOptions: {
                  byok: input.config.model.startsWith("deepseek-")
                    ? { thinking: { type: "disabled" } }
                    : { reasoningEffort: "low", parallel_tool_calls: true },
                },
              }
            : {}),
        });
        for await (const part of stream.fullStream) {
          if (controller.signal.aborted) return cancelled;
          if (part.type === "error") throw part.error;
          if (part.type !== "tool-call") continue;
          if (finished) {
            console.warn("lecture_validation", JSON.stringify({
              type: "call_after_finish", fields: ["tool"], step: kit.steps.length,
              attempt: 1 + toolRetries + upstreamRetries,
            }));
            return invalid;
          }
          const name = part.toolName as Name;
          const callStep = stepOf(name, part.input);
          const activeRepair =
            repairs.find(item => item.name === name && item.step === callStep) ??
            (repair && repairs.includes(repair) ? repair : undefined);
          assistant.push({
            type: "tool-call",
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            input: part.input,
          });
          let output: Record<
            string,
            string | number | boolean | null | string[]
          >;
          try {
            if (!Object.hasOwn(kit.tools, name))
              throw new ToolStateError("tool", "unknown_tool");
            if (activeRepair && name !== activeRepair.name)
              throw new ToolStateError("tool", "retry_only_failed_call");
            if (
              name === "finish" &&
              (repairs.length > 1 ||
                (repairs.length === 1 && activeRepair?.name !== "finish"))
            )
              throw new ToolStateError("steps", "unrepaired_call");
            if (
              activeRepair?.stepId &&
              name !== "add_step" &&
              name !== "finish" &&
              (part.input as { stepId?: unknown })?.stepId !==
                activeRepair.stepId
            )
              throw new ToolStateError("stepId", "retry_same_step");
            const applied = kit.apply(name, part.input);
            // finish 的完整校验成功之后才能消费修复队列，失败仍计入同一次调用。
            if (applied.finished)
              input.validate({ ...input.metadata, steps: kit.steps });
            // 同一批可修复多条调用；按工具与步骤移除，而非只消费轮首那一条。
            for (let i = repairs.length - 1; i >= 0; i--) {
              if (repairs[i].name === name && repairs[i].step === callStep) repairs.splice(i, 1);
            }
            if (applied.step) {
              input.onEvent?.({
                type: applied.added ? "step" : "step-update",
                step: applied.step,
              });
              if (applied.added)
                input.onEvent?.({
                  type: "progress",
                  attempt: 1 + toolRetries + upstreamRetries,
                  phase: "generating",
                  message: `已生成 ${kit.steps.length} 步，正在备课并播放…`,
                });
            }
            output = {
              ok: true,
              stepId: applied.step?.id ?? null,
              stepCount: kit.steps.length,
            };
            if (applied.finished) finished = true;
          } catch (error) {
            const info = failure(error),
              attempt = activeRepair?.attempt ?? 1,
              step = activeRepair?.step ?? stepOf(name, part.input);
            console.warn(
              "lecture_validation",
              JSON.stringify({
                type: info.type,
                tool: Object.hasOwn(kit.tools, name) ? name : "unknown",
                fields: info.fields,
                step,
                attempt,
              }),
            );
            if (attempt > TOOL_RETRY_LIMIT || !Object.hasOwn(kit.tools, name))
              return invalid;
            if (activeRepair) {
              activeRepair.attempt++;
              activeRepair.fields = info.fields;
            } else
              repairs.push({
                name,
                attempt: 2,
                step,
                fields: info.fields,
                stepId: kit.steps.some((s) => s.id === `s${step}`)
                  ? `s${step}`
                  : undefined,
              });
            output = {
              ok: false,
              error: info.type,
              fields: info.fields,
              reason:
                error instanceof ZodError
                  ? error.issues
                      .map(
                        (i) =>
                          `${i.path.filter((p) => typeof p === "string" && safeFields.has(p)).join(".")}: ${i.code}${"expected" in i ? ` expected=${i.expected}` : ""}${"maximum" in i ? ` maximum=${i.maximum}` : ""}${"minimum" in i ? ` minimum=${i.minimum}` : ""}`,
                      )
                      .join("; ")
                  : info.type,
              instruction: `只重新调用 ${name}，修正这些字段，不要重复已成功步骤。`,
            };
          }
          results.push({
            type: "tool-result",
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            output: { type: "json", value: output },
          });
          // finish 之后仍须读完本轮，确认没有额外调用且上游正常结束。
        }
      } catch (error) {
        if (controller.signal.aborted) return cancelled;
        const status = APICallError.isInstance(error)
          ? error.statusCode
          : undefined;
        // 只记录固定分类、状态码与进度。原始错误可能包含 Key，绝不打印。
        console.warn(
          "lecture_upstream",
          JSON.stringify({
            type: "upstream_error",
            fields: ["connection"],
            step: kit.steps.length + 1,
            attempt: 1 + toolRetries + upstreamRetries,
            status: status ?? null,
          }),
        );
        if (isTransientUpstreamError(error) && upstreamRetries < UPSTREAM_RETRY_LIMIT) {
          upstreamRetries++;
          // 部分工具已经成功时，将它们的回执带入下一轮，避免从头重生成。
          if (assistant.length)
            messages.push(
              { role: "assistant", content: assistant },
              { role: "tool", content: results },
            );
          input.onEvent?.({
            type: "progress",
            attempt: 1 + toolRetries + upstreamRetries,
            phase: "retry",
            message: "模型连接中断，正在重试本轮调用；已生成步骤保留…",
          });
          try { await waitForUpstreamRetry(controller.signal); }
          catch { return cancelled; }
          continue;
        }
        return {
          ok: false,
          status: 502,
          error: "UPSTREAM_ERROR",
          message: status === 401 || status === 403
            ? "Key 无效或没有权限，请检查设置。"
            : `暂时连不上模型或模型不支持工具调用。${recommendation}`,
        };
      }
      if (finished)
        return {
          ok: true,
          script: input.validate({ ...input.metadata, steps: kit.steps }),
        };
      if (!assistant.length) {
        noCalls++;
        console.warn(
          "lecture_validation",
          JSON.stringify({
            type: "missing_tool_call",
            fields: ["tool"],
            step: kit.steps.length + 1,
            attempt: noCalls,
          }),
        );
        if (noCalls >= 2) return invalid;
        messages.push({
          role: "user",
          content:
            "必须使用教学工具而不是输出文本。请调用 add_step 或 finish。",
        });
      } else {
        messages.push(
          { role: "assistant", content: assistant },
          { role: "tool", content: results },
        );
        if (repairs[0])
          messages.push({
            role: "user",
            content: `仅重试失败的 ${repairs[0].name} 调用（步骤 s${repairs[0].step}），出错字段 ${repairs[0].fields.join(",")}。其他成功调用已经保留，禁止重新添加。`,
          });
      }
    }
    console.warn(
      "lecture_validation",
      JSON.stringify({
        type: "call_limit",
        fields: ["tool"],
        step: kit.steps.length,
        attempt: 48,
      }),
    );
    return invalid;
  };
  try {
    return await Promise.race([deadline, run()]);
  } finally {
    clearTimeout(timer!);
    input.signal?.removeEventListener("abort", cancel);
    controller.abort();
  }
}
