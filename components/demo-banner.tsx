import { IS_DEMO, REPO_URL } from "@/lib/runtime";

/** 在线体验版顶部的一行说明 */
export function DemoBanner() {
  if (!IS_DEMO) return null;
  return (
    <div className="border-b border-beam-gold/25 bg-beam-gold/10 px-4 py-1.5 text-center text-xs leading-5 text-chalk-300">
      这是在线体验版：「两数之和」可以完整听课，其余题目可以读题和练习。
      <a href={REPO_URL} target="_blank" rel="noreferrer" className="ml-1 text-beam-gold hover:underline">
        装到自己电脑上，100 题都能听 →
      </a>
    </div>
  );
}
