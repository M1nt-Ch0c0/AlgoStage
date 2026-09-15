/**
 * 特效系统契约 · 详见 docs/02-frontend-design.md §3.1
 * 加一种新特效 = 写一个组件 + registerEffect 一行，不碰播放器主逻辑。
 */
import type { ComponentType } from "react";
import type {
  BeamColor,
  EffectIntensity,
  EffectTarget,
} from "@/lib/teaching/types";

export interface EffectProps {
  target: EffectTarget;
  color?: BeamColor;
  intensity?: EffectIntensity;
  params?: Record<string, unknown>;
  /** 特效播完回调（播放器用它推进节奏） */
  onDone?: () => void;
}

export interface EffectPlugin {
  name: string;
  component: ComponentType<EffectProps>;
  defaultDuration: number;
}

const registry = new Map<string, EffectPlugin>();

export function registerEffect(plugin: EffectPlugin): void {
  registry.set(plugin.name, plugin);
}

export function getEffect(name: string): EffectPlugin | undefined {
  return registry.get(name);
}

export function listEffects(): EffectPlugin[] {
  return [...registry.values()];
}
