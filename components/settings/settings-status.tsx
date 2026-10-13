interface SettingsStatusProps {
  id?: string;
  message: string;
  className?: string;
}

/**
 * 常驻的设置状态组件（role="status" aria-live="polite"），
 * 空闲时内容为空，状态变更时仅文字变化以保证辅助技术（屏幕阅读器）能稳定播报。
 */
export function SettingsStatus({
  id = "settings-status",
  message,
  className = "mt-2 text-xs leading-5 text-chalk-300",
}: SettingsStatusProps) {
  return (
    <p id={id} role="status" aria-live="polite" className={className}>
      {message}
    </p>
  );
}
