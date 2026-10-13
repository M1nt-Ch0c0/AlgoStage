/** 仅展示服务端解析出的 Key 来源，不接收或渲染密钥。 */
const sources = {
  settings: {
    label: "设置页",
    color: "border-beam-mint/40 bg-beam-mint/10 text-beam-mint",
  },
  env: {
    label: "环境变量",
    color: "border-beam-cyan/40 bg-beam-cyan/10 text-beam-cyan",
  },
  none: {
    label: "未配置",
    color: "border-board-600 bg-board-800 text-chalk-500",
  },
} as const;
export type KeySource = keyof typeof sources;

export function KeySourceBadge({ source }: { source: KeySource }) {
  const { label, color } = sources[source];
  return (
    <span
      role="status"
      aria-live="polite"
      className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium ${color}`}
    >
      <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
      API Key 来源：{label}
    </span>
  );
}
