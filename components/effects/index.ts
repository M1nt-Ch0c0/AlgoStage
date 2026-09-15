/**
 * 内置特效注册（docs/02 §3.1）：
 * 加一种新特效 = 写一个组件 + 在这里 registerEffect 一行。
 * 被 effect-stage.tsx 侧效导入，保证舞台就绪时注册表已填充。
 */
import { registerEffect } from "@/lib/effects/registry";
import SpotlightBeam from "./spotlight-beam";
import LaserPointer from "./laser-pointer";
import ChalkUnderline from "./chalk-underline";
import FocusDim from "./focus-dim";
import AttentionRipple from "./attention-ripple";
import ConfettiAC from "./confetti-ac";

registerEffect({ name: "spotlight-beam", component: SpotlightBeam, defaultDuration: 0 });
registerEffect({ name: "laser-pointer", component: LaserPointer, defaultDuration: 450 });
registerEffect({ name: "chalk-underline", component: ChalkUnderline, defaultDuration: 700 });
registerEffect({ name: "focus-dim", component: FocusDim, defaultDuration: 0 });
registerEffect({ name: "attention-ripple", component: AttentionRipple, defaultDuration: 1600 });
registerEffect({ name: "confetti-ac", component: ConfettiAC, defaultDuration: 1800 });
