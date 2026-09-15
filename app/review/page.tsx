export default function ReviewPage() {
  return (
    <div className="mx-auto max-w-3xl px-6 pb-24 pt-10">
      <header>
        <h1 className="font-chalk text-4xl text-chalk-100">复习队列</h1>
        <p className="mt-1 text-sm text-chalk-500">
          SM-2 间隔复习队列，二期见 docs/04
        </p>
      </header>

      <div className="mt-12 flex flex-col items-center rounded-2xl border border-dashed border-board-700/70 bg-board-900/40 px-8 py-20 text-center backdrop-blur-sm">
        <span
          className="font-chalk text-8xl text-chalk-700"
          style={{ textShadow: "0 0 24px rgba(244, 241, 232, 0.08)" }}
        >
          ?
        </span>
        <p className="mt-6 font-chalk text-2xl text-chalk-300">
          复习卡片还在备课中
        </p>
        <p className="mt-2 max-w-sm text-sm leading-relaxed text-chalk-500">
          题目 AC 后会自动生成 SM-2 复习卡：答得好，间隔拉长；答得差，明天再见。
          二期上线后，这里会列出今日到期的每一张卡片。
        </p>
        <a
          href="/roadmap"
          className="mt-8 rounded-full border border-board-700 px-5 py-2 text-sm text-chalk-300 transition-colors hover:border-beam-gold/60 hover:text-beam-gold"
        >
          先去路线图刷题 →
        </a>
      </div>
    </div>
  );
}
