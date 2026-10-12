/**
 * 学习页 /problem/[slug]（docs/02 §5.4，核心战场）
 * 左讲义（data-statement 锚点）· 中黑板+可视化区+控制台 · 右 AI 导师面板（字幕/教案/提示阶梯）· 底部播放器控制条。
 * 桌面端满屏讲台、各栏内部滚动；手机端整页滚动，播放器吸底。
 * two-sum 直接内置旗舰脚本；其余题走 POST /api/lecture（无 BYOK 时给占位引导）。
 */
"use client";

import { apiPath, IS_DEMO, REPO_URL } from "@/lib/runtime";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ChevronRight, GraduationCap, KeyRound, Lightbulb, Pencil, Play, RotateCcw, Sparkles } from "lucide-react";
import type { ProblemDetail } from "@/lib/content/types";
import { validateScript } from "@/lib/teaching/validated-script";
import type { TeachingScript } from "@/lib/teaching/types";
import { TWO_SUM_SCRIPT } from "@/lib/content/scripts/two-sum";
import { HOT100_CATEGORIES } from "@/lib/content/hot100";
import { DIFFICULTY_DOT, DIFFICULTY_LABEL, DIFFICULTY_TEXT } from "@/lib/content/pattern-labels";
import { usePlayerStore } from "@/lib/player/store";
import EffectStage from "@/components/effects/effect-stage";
import ConfettiAC from "@/components/effects/confetti-ac";
import CodeEditor from "@/components/board/code-editor";
import NarrationBar from "@/components/board/narration-bar";
import PlayerControls from "@/components/board/player-controls";
import LessonPlan from "@/components/board/lesson-plan";
import { InlineMarkdown } from "@/components/board/inline-markdown";
import ArrayVisualizer from "@/components/viz/array-visualizer";

const STATEMENT_IDS = ["intro", "insight", "summary"] as const;
const HINT_LEVELS = ["观察", "模式", "方向", "技巧", "骨架"];

/** 栏目小标题：讲义 / 黑板 / 导师 */
function ColumnLabel({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <h2 className="chalk text-2xl leading-none text-chalk-300">{children}</h2>
      {right}
    </div>
  );
}

export default function ProblemPage() {
  const { slug } = useParams<{ slug: string }>();
  const [detail, setDetail] = useState<ProblemDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [practice, setPractice] = useState(false);
  const [code, setCode] = useState("");
  const [running, setRunning] = useState(false);
  const [runResult, setRunResult] = useState<string | null>(null);
  const [confetti, setConfetti] = useState<{ key: number; x: number; y: number } | null>(null);

  const [lectureBusy, setLectureBusy] = useState(false);
  const [lectureError, setLectureError] = useState<string | null>(null);

  const [hintBusy, setHintBusy] = useState<number | null>(null);
  const [hintError, setHintError] = useState<string | null>(null);
  const [hints, setHints] = useState<{ level: number; text: string }[]>([]);

  const step = usePlayerStore((s) => s.steps[s.currentIndex]);
  const status = usePlayerStore((s) => s.status);
  const stepCount = usePlayerStore((s) => s.steps.length);
  const { loadScript, play, reset } = usePlayerStore.getState();

  // 题面加载
  useEffect(() => {
    reset();
    setDetail(null);
    setLoadError(null);
    fetch(apiPath(`/api/problems/${slug}`))
      .then(async (res) => {
        if (!res.ok) throw new Error("没找到这道题，回路线图换一道吧。");
        const j = (await res.json()) as { problem: ProblemDetail };
        setDetail(j.problem);
        const ref =
          j.problem.referenceSolutions?.find((s) => s.language === "typescript") ??
          j.problem.referenceSolutions?.[0];
        setCode(ref?.code ?? "");
      })
      .catch((e: Error) => setLoadError(e.message));
  }, [slug, reset]);

  // 讲解进度埋点（看板数据源）
  const lastReportedRef = useRef(-1);
  useEffect(() => {
    if (!step || status === "idle") return;
    const idx = usePlayerStore.getState().currentIndex;
    if (idx === lastReportedRef.current) return;
    lastReportedRef.current = idx;
    fetch(apiPath("/api/progress"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "lecture-step", problemSlug: slug, stepIndex: idx }),
    }).catch(() => {});
  }, [step, status, slug]);

  // 开始讲课：two-sum 用内置旗舰脚本；其余题调 AI 生成（支持 cached JSON 与流式文本容错解析）
  const startLecture = useCallback(async () => {
    setLectureError(null);
    setPractice(false);
    if (slug === "two-sum") {
      loadScript(validateScript(TWO_SUM_SCRIPT, detail?.referenceSolutions?.find((s) => s.language === "typescript")?.code ?? ""));
      play();
      return;
    }
    setLectureBusy(true);
    try {
      const res = await fetch(apiPath("/api/lecture"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(j?.message ?? "老师这次没备好课，稍等一会儿再试吧。");
      }
      const ct = res.headers.get("content-type") ?? "";
      let script: TeachingScript;
      if (ct.includes("application/json")) {
        script = ((await res.json()) as { script: TeachingScript }).script;
      } else {
        // 流式 JSON 文本：拼接完整后整体 parse（流式增量解析二期接入）
        script = JSON.parse(await res.text()) as TeachingScript;
      }
      const referenceCode = detail?.referenceSolutions?.find((s) => s.language === script.solutionLanguage)?.code ?? "";
      const validated = validateScript(script, referenceCode);
      if (validated.problemSlug !== slug) throw new Error("教案与当前题目不匹配，请重试。");
      setCode(referenceCode);
      loadScript(validated);
      play();
    } catch (e) {
      setLectureError(e instanceof Error ? e.message : "老师这次没备好课，稍等一会儿再试吧。");
    } finally {
      setLectureBusy(false);
    }
  }, [slug, detail, loadScript, play]);

  // 运行（执行沙箱二期接入：本期 mock AC → 礼花 + 进度落库）
  const run = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      if (running) return;
      setRunning(true);
      setRunResult(null);
      const r = e.currentTarget.getBoundingClientRect();
      setTimeout(() => {
        setRunning(false);
        setRunResult("全部通过！（自动判题还在完善，这次结果只是演示）");
        setConfetti({ key: Date.now(), x: r.left + r.width / 2, y: r.top + r.height / 2 });
        fetch(apiPath("/api/progress"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "submission",
            problemSlug: slug,
            code,
            language: "typescript",
            verdict: "AC",
          }),
        }).catch(() => {});
      }, 800);
    },
    [running, slug, code],
  );

  // 提示阶梯
  const askHint = useCallback(
    async (level: number) => {
      setHintBusy(level);
      setHintError(null);
      try {
        const res = await fetch(apiPath("/api/hint"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slug, level, userCode: practice ? code : undefined }),
        });
        const j = (await res.json()) as { level?: number; hint?: string; message?: string; error?: string };
        if (!res.ok) {
          throw new Error(
            j.error === "DEMO"
              ? "在线体验版里还不能要提示。装到自己电脑上接上 AI，就能一级一级地问老师。"
              : j.error === "NO_BYOK"
                ? "提示要老师现场想，先在设置里接上你的 AI 吧。"
                : (j.message ?? "这条提示没想出来，稍等一会儿再试吧。"),
          );
        }
        setHints((h) => [...h.filter((x) => x.level !== j.level), { level: j.level!, text: j.hint! }]);
        fetch(apiPath("/api/progress"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "hint", problemSlug: slug, level }),
        }).catch(() => {});
      } catch (e) {
        setHintError(e instanceof Error ? e.message : "这条提示没想出来，稍等一会儿再试吧。");
      } finally {
        setHintBusy(null);
      }
    },
    [slug, practice, code],
  );

  // 讲义段落（data-statement 锚点：intro / insight / summary）
  const paragraphs = useMemo(
    () => (detail?.statement ?? "").split(/\n\s*\n/).filter(Boolean),
    [detail],
  );

  const vizFrame =
    step?.viz ??
    (detail?.vizType === "array"
      ? { type: "array", state: { values: [2, 7, 11, 15], highlight: [], map: {}, scan: -1 } }
      : undefined);

  const chapterIndex = detail ? (HOT100_CATEGORIES as readonly string[]).indexOf(detail.category) + 1 : 0;
  const hasBuiltIn = slug === "two-sum";
  // 在线体验版只有内置的那一课能听
  const lectureLocked = IS_DEMO && !hasBuiltIn;
  const inLecture = status !== "idle";

  if (loadError) {
    return (
      <div className="mx-auto flex max-w-md flex-col items-center gap-4 px-4 py-24 text-center">
        <p className="chalk text-4xl text-chalk-300">这页黑板是空的</p>
        <p className="text-sm text-chalk-500">{loadError}</p>
        <Link href="/roadmap" className="text-sm text-beam-gold hover:underline">
          回到路线图选题
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-3 px-3 py-3 sm:px-4 lg:h-[calc(100dvh-3.5rem)] lg:overflow-hidden">
      {/* ── 顶栏 ── */}
      <header className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="min-w-0">
          <nav aria-label="位置" className="flex items-center gap-1 text-xs text-chalk-500">
            <Link href="/roadmap" className="hover:text-chalk-100">
              路线图
            </Link>
            {detail && (
              <>
                <ChevronRight size={12} className="text-chalk-700" />
                <Link href={`/roadmap#chapter-${chapterIndex}`} className="hover:text-chalk-100">
                  第 {chapterIndex} 章 · {detail.category}
                </Link>
              </>
            )}
          </nav>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1">
            <h1 className="text-xl font-semibold text-chalk-100">
              {detail ? (
                <>
                  <span className="mr-2 font-mono text-base font-normal text-chalk-500">{detail.number}.</span>
                  {detail.title}
                </>
              ) : (
                <span className="text-chalk-500">正在取题…</span>
              )}
            </h1>
            {detail && (
              <span className={`flex items-center gap-1.5 text-xs ${DIFFICULTY_TEXT[detail.difficulty]}`}>
                <span className={`size-1.5 rounded-full ${DIFFICULTY_DOT[detail.difficulty]}`} />
                {DIFFICULTY_LABEL[detail.difficulty]}
              </span>
            )}
          </div>
        </div>

        <div className="ml-auto flex items-center gap-2">
          {/* 讲课 / 练习 模式切换 */}
          <div role="group" aria-label="模式" className="flex rounded-full border border-board-700 bg-board-900/80 p-0.5">
            <button
              type="button"
              aria-pressed={!practice}
              onClick={() => setPractice(false)}
              className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm transition-colors ${
                !practice ? "bg-board-700 text-chalk-100" : "text-chalk-500 hover:text-chalk-300"
              }`}
            >
              <GraduationCap size={15} />
              听课
            </button>
            <button
              type="button"
              aria-pressed={practice}
              onClick={() => {
                // 上台自己写时，老师先停下
                usePlayerStore.getState().pause();
                setPractice(true);
              }}
              className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm transition-colors ${
                practice ? "bg-board-700 text-beam-cyan" : "text-chalk-500 hover:text-chalk-300"
              }`}
            >
              <Pencil size={14} />
              练习
            </button>
          </div>
          <button
            type="button"
            onClick={startLecture}
            disabled={lectureBusy || !detail || lectureLocked}
            className="flex items-center gap-1.5 rounded-full bg-beam-gold px-4 py-2 text-sm font-semibold text-on-accent transition-transform hover:scale-[1.03] disabled:pointer-events-none disabled:opacity-50"
          >
            {lectureBusy ? (
              <Sparkles size={15} className="animate-pulse" />
            ) : inLecture ? (
              <RotateCcw size={15} />
            ) : (
              <Play size={15} />
            )}
            {lectureBusy ? "备课中…" : inLecture ? "从头再讲" : "开始讲课"}
          </button>
        </div>
      </header>

      {/* ── 三栏 ── */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-[minmax(0,3fr)_minmax(0,5fr)_minmax(0,3.6fr)]">
        {/* 讲义 */}
        <section className="flex min-h-0 flex-col gap-3 rounded-2xl border border-board-700/70 bg-board-900/80 p-4 lg:overflow-y-auto">
          <ColumnLabel>讲义</ColumnLabel>
          {paragraphs.length > 0 ? (
            <div className="flex flex-col gap-2 text-[15px] leading-7 text-chalk-300">
              {paragraphs.map((p, i) => (
                <p key={i} data-statement={STATEMENT_IDS[i]} className="rounded-lg px-2 py-1 whitespace-pre-line">
                  <InlineMarkdown text={p} />
                </p>
              ))}
            </div>
          ) : (
            <p className="text-sm leading-6 text-chalk-500">
              {detail ? "这道题的题目还没收录进来。可以先听老师讲，或者到 LeetCode 上对照原题看。" : "正在取题…"}
            </p>
          )}
          {detail?.testCases && detail.testCases.length > 0 && (
            <div className="mt-1">
              <h3 className="mb-2 text-xs font-medium text-chalk-500">示例</h3>
              <table className="w-full border-separate border-spacing-y-1.5 font-mono text-xs">
                <thead className="sr-only">
                  <tr>
                    <th>输入</th>
                    <th>输出</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.testCases.map((t, i) => (
                    <tr key={i} className="bg-board-800">
                      <td className="rounded-l-lg px-3 py-2 text-chalk-300">{t.input}</td>
                      <td className="w-px rounded-r-lg py-2 pr-3 pl-1 whitespace-nowrap text-beam-mint">→ {t.expected}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* 黑板 + 可视化区 + 控制台 */}
        <section className="flex min-h-0 flex-col gap-3">
          <div className="board-surface board-frame flex h-[24rem] flex-col overflow-hidden rounded-xl p-[6px] lg:h-auto lg:min-h-0 lg:flex-1">
            <div className="flex items-center justify-between gap-3 px-3 pt-1.5 pb-2">
              <span className="chalk text-xl leading-none text-chalk-300">黑板</span>
              <span className="flex items-center gap-2 font-mono text-[11px] text-chalk-500">
                TypeScript
                {practice ? (
                  <span className="rounded-full border border-beam-cyan/40 px-2 py-0.5 text-beam-cyan">练习中 · 可编辑</span>
                ) : inLecture ? (
                  <span className="flex items-center gap-1.5 rounded-full border border-beam-gold/40 px-2 py-0.5 text-beam-gold">
                    <span className="size-1.5 rounded-full bg-beam-gold" />
                    讲课中
                  </span>
                ) : (
                  <span className="rounded-full border border-board-600 px-2 py-0.5">参考解法 · 只读</span>
                )}
              </span>
            </div>
            <div className="min-h-0 flex-1 overflow-hidden rounded-md">
              <CodeEditor value={code} readOnly={!practice} onChange={setCode} language="typescript" />
            </div>
          </div>

          {vizFrame && (
            <div className="board-surface shrink-0 rounded-xl border border-board-700 px-4 pt-2 pb-3">
              <div className="mb-1 flex items-center justify-between">
                <span className="font-mono text-[11px] text-chalk-500">可视化 · 数组</span>
                {step && <span className="font-mono text-[11px] text-chalk-700">随讲解同步</span>}
              </div>
              <div className="overflow-x-auto">
                <ArrayVisualizer frame={vizFrame} />
              </div>
            </div>
          )}

          <div className="flex shrink-0 flex-wrap items-center gap-3 rounded-xl border border-board-700/70 bg-board-900/80 px-4 py-2.5">
            <span className="text-xs font-medium text-chalk-500">控制台</span>
            {runResult ? (
              <span className="text-xs text-beam-mint">✓ {runResult}</span>
            ) : (
              <span className="text-xs text-chalk-700">
                {practice ? "写好了就点运行，用示例试试你的代码" : "切到「练习」，就能自己动手写"}
              </span>
            )}
            <button
              type="button"
              onClick={run}
              disabled={running || !practice}
              className="ml-auto flex items-center gap-1.5 rounded-full bg-beam-mint px-4 py-1.5 text-sm font-semibold text-on-accent transition-transform hover:scale-[1.03] disabled:pointer-events-none disabled:opacity-35"
            >
              <Play size={13} />
              {running ? "运行中…" : "运行"}
            </button>
          </div>
        </section>

        {/* AI 导师面板 */}
        <aside className="flex min-h-0 flex-col gap-3">
          <section className="flex min-h-0 flex-1 flex-col gap-3 rounded-2xl border border-board-700/70 bg-board-900/80 p-4">
            <ColumnLabel
              right={
                inLecture && stepCount > 0 ? (
                  <span className="font-mono text-[11px] text-chalk-500">共 {stepCount} 步</span>
                ) : null
              }
            >
              AI 导师
            </ColumnLabel>

            <NarrationBar />

            {inLecture ? (
              <LessonPlan />
            ) : (
              <div className="flex flex-col gap-3 rounded-xl border border-dashed border-board-600 px-4 py-4 text-sm leading-6 text-chalk-500">
                {hasBuiltIn ? (
                  <>
                    <p>
                      这道题老师已经备好课了，直接听就行。一共 {TWO_SUM_SCRIPT.steps.length} 步，从最笨的办法讲起，一直讲到用哈希表一遍搞定。
                    </p>
                    <LessonPlan preview={TWO_SUM_SCRIPT.steps} />
                    <p className="text-xs text-chalk-700">← → 切换步骤 · 空格 暂停/继续</p>
                  </>
                ) : lectureLocked ? (
                  <>
                    <p>在线体验版里，老师只备好了「两数之和」这一课。这道题可以先读题、自己动手练。</p>
                    <p>
                      想听老师讲这道题？
                      <a href={REPO_URL} target="_blank" rel="noreferrer" className="text-beam-gold hover:underline">
                        把 AlgoStage 装到自己电脑上
                      </a>
                      ，接上你的 AI 就行。
                    </p>
                    <Link href="/problem/two-sum" className="text-beam-gold hover:underline">
                      先去听「两数之和」 →
                    </Link>
                  </>
                ) : (
                  <>
                    <p>这道题老师还没备课。点「开始讲课」，老师会先花十几秒准备一下。</p>
                    <Link href="/settings" className="flex items-center gap-1.5 text-beam-gold hover:underline">
                      <KeyRound size={14} />
                      还没接上 AI？去设置
                    </Link>
                  </>
                )}
                {lectureError && <p className="text-beam-rose">{lectureError}</p>}
              </div>
            )}
          </section>

          {/* 提示阶梯（docs/03 §6）：越往上越接近答案 */}
          <section className="shrink-0 rounded-2xl border border-board-700/70 bg-board-900/80 p-4">
            <h3 className="flex items-center gap-1.5 text-sm font-medium text-chalk-300">
              <Lightbulb size={14} className="text-beam-gold" />
              提示阶梯
              <span className="ml-auto text-[11px] font-normal text-chalk-700">用了几级会记在看板上</span>
            </h3>
            <div className="mt-3 flex items-end gap-1.5">
              {HINT_LEVELS.map((label, i) => {
                const used = hints.some((h) => h.level === i + 1);
                return (
                  <button
                    key={label}
                    type="button"
                    onClick={() => askHint(i + 1)}
                    disabled={hintBusy !== null}
                    title={`第 ${i + 1} 级提示：${label}`}
                    className={`flex flex-1 flex-col items-center justify-end rounded-lg border px-1 pb-1.5 text-[11px] transition-colors disabled:opacity-50 ${
                      used
                        ? "border-beam-gold/50 bg-beam-gold/10 text-beam-gold"
                        : "border-board-600 text-chalk-500 hover:border-chalk-500 hover:text-chalk-100"
                    }`}
                    style={{ height: `${2.6 + i * 0.4}rem` }}
                  >
                    <span className="font-mono text-[10px] opacity-70">L{i + 1}</span>
                    {hintBusy === i + 1 ? "…" : label}
                  </button>
                );
              })}
            </div>
            {hintError && <p className="mt-2 text-xs leading-5 text-beam-rose">{hintError}</p>}
            {hints.length > 0 && (
              <div className="mt-3 flex max-h-40 flex-col gap-2 overflow-y-auto">
                {hints
                  .slice()
                  .sort((a, b) => a.level - b.level)
                  .map((h) => (
                    <div key={h.level} className="rounded-lg bg-board-800 px-3 py-2 text-sm leading-6 text-chalk-300">
                      <span className="mr-1.5 font-mono text-xs text-beam-gold">L{h.level}</span>
                      {h.text}
                    </div>
                  ))}
              </div>
            )}
          </section>
        </aside>
      </div>

      {/* ── 底部播放器控制条 ── */}
      <div className="z-30 max-lg:sticky max-lg:bottom-2">
        <PlayerControls />
      </div>

      {/* 特效舞台 + 通关礼花 */}
      <EffectStage />
      {confetti && (
        <ConfettiAC
          key={confetti.key}
          target={{ kind: "dom", selector: "body" }}
          origin={{ x: confetti.x, y: confetti.y }}
          onDone={() => setConfetti(null)}
        />
      )}
    </div>
  );
}
