/** 工具参数与执行共用 schema，代码行号严格约束在本题参考题解内。 */
import { z } from "zod";
import { tool } from "ai";
import { arrayVizFrameSchema, teachingStepSchema } from "@/lib/teaching/schema";
import { EFFECT_WHITELIST, type TeachingStep } from "@/lib/teaching/types";

export function createLectureTools(lineCount: number) {
  const line = z
    .number()
    .int()
    .min(1)
    .max(lineCount)
    .describe(`参考代码行号，从 1 开始，最多 ${lineCount}`);
  const range = z
    .object({
      start: line,
      end: line
        .optional()
        .describe("末行，省略表示只高亮 start 行，不能小于 start"),
    })
    .refine((v) => v.end === undefined || v.end >= v.start, {
      path: ["end"],
      message: "末行不能小于起始行",
    });
  const id = z
    .string()
    .regex(/^s[1-9]\d?$/)
    .describe("步骤编号，如 s1；新增时按顺序递增，修改时指定已存在步骤");
  const target = z
    .union([
      range.safeExtend({ kind: z.literal("code-line") }),
      z.object({
        kind: z.literal("statement"),
        blockId: z
          .enum(["intro", "insight", "summary"])
          .describe("intro 题意，insight 核心洞察，summary 总结"),
      }),
    ])
    .describe("本步先标注的一个锚点；代码行号必须来自本题参考代码");
  const schemas = {
    add_step: z
      .object({
        id,
        narration: z
          .string()
          .min(1)
          .max(500)
          .describe("本步字幕，口语化，一步一个意思，建议不超过 60 字"),
        target,
        effect: z
          .enum(EFFECT_WHITELIST)
          .optional()
          .describe(
            "首播特效，默认代码聚光灯、题面涟漪；修改已存在步骤才用 set_effect",
          ),
        viz: arrayVizFrameSchema
          .optional()
          .describe(
            "可选的数组全量帧；values 必须数字数组，索引合法；修改已有帧才用 set_viz",
          ),
        dwellMs: z
          .number()
          .int()
          .min(0)
          .max(5000)
          .optional()
          .describe("字幕结束后停留毫秒，默认 800"),
      })
      .strict(),
    highlight_lines: z
      .object({ stepId: id, ...range.shape })
      .strict()
      .refine((v) => v.end === undefined || v.end >= v.start, {
        path: ["end"],
        message: "末行不能小于起始行",
      }),
    set_effect: z
      .object({
        stepId: id,
        effect: z
          .enum(EFFECT_WHITELIST)
          .describe("白名单特效：聚光灯、激光笔、粉笔线、舞台压暗、涟漪、对比"),
        targetIndex: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("作用的锚点下标，从 0 开始，不能超过该步 targets 范围"),
        color: z
          .enum(["gold", "cyan", "violet", "rose", "mint"])
          .optional()
          .describe("特效颜色，默认 gold"),
        intensity: z
          .enum(["whisper", "normal", "shout"])
          .optional()
          .describe("强度：轻、标准、强，默认 normal"),
      })
      .strict(),
    set_viz: z
      .object({
        stepId: id,
        viz: arrayVizFrameSchema.describe(
          "数组全量帧：type 必须 array；state.values 数字数组；highlight 下标数组；map 数字到下标；scan -1 或合法下标；hit 布尔；captions 标注 nodeId 与 text",
        ),
      })
      .strict(),
    finish: z.object({}).strict(),
  };
  const tools = {
    add_step: tool({
      description:
        "增加并立即播放一步。id 顺序编号 s1/s2；narration 是字幕；target 指向题面段落或本题代码行；effect 可选白名单特效；viz 可选数组全量帧；dwellMs 可调停留。尽量一次给齐本步内容，已成功步骤不要重复添加。",
      inputSchema: schemas.add_step,
    }),
    highlight_lines: tool({
      description:
        "修改已存在步骤的代码高亮。stepId 指定步骤，start/end 是含首尾的代码行范围，end 可省略。保留本步已有题面锚点，替换本步代码锚点。",
      inputSchema: schemas.highlight_lines,
    }),
    set_effect: tool({
      description:
        "为已存在步骤增加特效。stepId 指定步骤；effect 只能用白名单；targetIndex 指向该步锚点（默认 0）；color 为配色；intensity 为强度。",
      inputSchema: schemas.set_effect,
    }),
    set_viz: tool({
      description:
        "为已存在步骤设置数组演示。stepId 指定步骤；viz.type=array；viz.state.values 为数字数组，highlight/map/scan 均必须在数组下标范围内；captions 为数组格子标注。不支持树/图等类型。",
      inputSchema: schemas.set_viz,
    }),
    finish: tool({
      description:
        "全部步骤和修改成功后完成教案。不传参数。至少已有一步，推荐 6–10 步；最后一步总结方法、时间及空间复杂度。未完成或存在未修复调用时不能 finish。",
      inputSchema: schemas.finish,
    }),
  };
  const steps: TeachingStep[] = [];
  const apply = (
    name: keyof typeof schemas,
    value: unknown,
  ): { step?: TeachingStep; added?: boolean; finished?: boolean } => {
    const data = schemas[name].parse(value);
    if (name === "finish") {
      if (!steps.length) throw new ToolStateError("steps", "empty_script");
      return { finished: true };
    }
    if (name === "add_step") {
      const args = data as z.infer<typeof schemas.add_step>;
      if (steps.length >= 12) throw new ToolStateError("id", "step_limit");
      if (args.id !== `s${steps.length + 1}`)
        throw new ToolStateError("id", "step_sequence");
      const step = teachingStepSchema.parse({
        id: args.id,
        narration: args.narration,
        targets: [args.target],
        effects: [
          {
            effect:
              args.effect ??
              (args.target.kind === "code-line"
                ? "spotlight-beam"
                : "attention-ripple"),
          },
        ],
        viz: args.viz,
        dwellMs: args.dwellMs,
      });
      steps.push(step);
      return { step, added: true };
    }
    const args = data as { stepId: string };
    const index = steps.findIndex((s) => s.id === args.stepId);
    if (index < 0) throw new ToolStateError("stepId", "missing_step");
    let step = { ...steps[index] };
    if (name === "highlight_lines") {
      const a = data as z.infer<typeof schemas.highlight_lines>;
      step = {
        ...step,
        targets: [
          ...step.targets.filter(
            (t) => t.kind !== "code-line" && t.kind !== "code-token",
          ),
          { kind: "code-line", start: a.start, end: a.end ?? a.start },
        ],
      };
    }
    if (name === "set_effect") {
      const { effect: name, targetIndex, color, intensity } = data as z.infer<
        typeof schemas.set_effect
      >;
      const effect = { effect: name, targetIndex, color, intensity };
      if ((effect.targetIndex ?? 0) >= step.targets.length)
        throw new ToolStateError("targetIndex", "target_range");
      step = {
        ...step,
        effects: [
          ...step.effects.filter((e) => e.effect !== effect.effect),
          effect,
        ],
      };
    }
    if (name === "set_viz")
      step = { ...step, viz: (data as z.infer<typeof schemas.set_viz>).viz };
    step = teachingStepSchema.parse(step);
    steps[index] = step;
    return { step, added: false };
  };
  return { tools, schemas, steps, apply };
}
export class ToolStateError extends Error {
  constructor(
    public field: string,
    public failureType: string,
  ) {
    super(failureType);
  }
}
