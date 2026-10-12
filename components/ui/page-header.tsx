import type { ReactNode } from "react";

/** 页面抬头：小号眉题 + 粉笔大标题 + 一句说明；右侧可放进度或操作 */
export function PageHeader({
  eyebrow,
  title,
  desc,
  aside,
}: {
  eyebrow?: string;
  title: string;
  desc?: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-x-8 gap-y-5">
      <div className="min-w-0">
        {eyebrow && (
          <p className="font-mono text-[11px] tracking-[0.14em] text-chalk-500 uppercase">
            {eyebrow}
          </p>
        )}
        <h1 className="chalk mt-1 text-5xl leading-tight text-chalk-100">{title}</h1>
        {desc && <p className="mt-1 max-w-[60ch] text-sm leading-6 text-chalk-500">{desc}</p>}
      </div>
      {aside}
    </header>
  );
}

/** 面板：页面里需要成块分隔的内容才用它 */
export function Panel({
  title,
  desc,
  action,
  children,
  className = "",
  id,
}: {
  title?: ReactNode;
  desc?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <section
      id={id}
      className={`rounded-2xl border border-board-700/60 bg-board-900/70 p-5 sm:p-6 ${className}`}
    >
      {(title || action) && (
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            {title && <h2 className="text-[15px] font-semibold text-chalk-100">{title}</h2>}
            {desc && <p className="mt-0.5 text-xs leading-5 text-chalk-500">{desc}</p>}
          </div>
          {action}
        </div>
      )}
      {children}
    </section>
  );
}
