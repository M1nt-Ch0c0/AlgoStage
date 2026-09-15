/**
 * 学习页 /problem/[slug]（docs/02 §5.4，核心战场）
 * 左讲义（data-statement 锚点）· 中黑板+可视化区+控制台 · 右 AI 导师面板 · 底部播放器控制条。
 * two-sum 直接内置旗舰脚本；其余题走 POST /api/lecture（无 BYOK 时给占位引导）。
 */
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, GraduationCap, Lightbulb, Pencil, Play, Sparkles } from "lucide-react";
import type { ProblemDetail } from "@/lib/content/types";
import type { TeachingScript } from "@/lib/teaching/types";
import { TWO_SUM_SCRIPT } from "@/lib/content/scripts/two-sum";
import { usePlayerStore } from "@/lib/player/store";
import EffectStage from "@/components/effects/effect-stage";
import ConfettiAC from "@/components/effects/confetti-ac";
import CodeEditor from "@/components/board/code-editor";
import NarrationBar from "@/components/board/narration-bar";
import PlayerControls from "@/components/board/player-controls";
import { InlineMarkdown } from "@/components/board/inline-markdown";
import ArrayVisualizer from "@/components/viz/array-visualizer";

const DIFFICULTY_STYLE: Record<string, string> = {
  easy: "text-beam-mint border-beam-mint/40",
  medium: "text-beam-gold border-beam-gold/40",
  hard: "text-beam-rose border-beam-rose/40",
};
const DIFFICULTY_LABEL: Record<string, string> = {
  easy: "简单",
  medium: "中等",
  hard: "困难",
};
const STATEMENT_IDS = ["intro", "insight", "summary"] as const;
const HINT_LEVELS = ["观察", "模式", "方向", "技巧", "骨架"];

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
  const { loadScript, play, reset } = usePlayerStore.getState();

  // 题面加载
  useEffect(() => {
    reset();
    setDetail(null);
    setLoadError(null);
    fetch(`/api/problems/${slug}`)
      .then(async (res) => {
        if (!res.ok) throw new Error("题目不存在");
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
    fetch("/api/progress", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "lecture-step", problemSlug: slug, stepIndex: idx }),
    }).catch(() => {});
  }, [step, status, slug]);

  // 开始讲课：two-sum 用内置旗舰脚本；其余题调 AI 生成（支持 cached JSON 与流式文本容错解析）
  const startLecture = useCallback(async () => {
    setLectureError(null);
    if (slug === "two-sum") {
      loadScript(TWO_SUM_SCRIPT);
      play();
      return;
    }
    setLectureBusy(true);
    try {
      const res = await fetch("/api/lecture", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(j?.message ?? "讲解脚本生成失败");
      }
      const ct = res.headers.get("content-type") ?? "";
      let script: TeachingScript;
      if (ct.includes("application/json")) {
        script = ((await res.json()) as { script: TeachingScript }).script;
      } else {
        // 流式 JSON 文本：拼接完整后整体 parse（流式增量解析二期接入）
        script = JSON.parse(await res.text()) as TeachingScript;
      }
      loadScript(script);
      play();
    } catch (e) {
      setLectureError(e instanceof Error ? e.message : "讲解脚本生成失败");
    } finally {
      setLectureBusy(false);
    }
  }, [slug, loadScript, play]);

  // 运行（执行沙箱二期接入：本期 mock AC → 礼花 + 进度落库）
  const run = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      if (running) return;
      setRunning(true);
      setRunResult(null);
      const r = e.currentTarget.getBoundingClientRect();
      setTimeout(() => {
        setRunning(false);
        setRunResult("AC · 全部测试通过（本地执行沙箱二期接入，本次为模拟结果）");
        setConfetti({ key: Date.now(), x: r.left + r.width / 2, y: r.top + r.height / 2 });
        fetch("/api/progress", {
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
        const res = await fetch("/api/hint", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slug, level, userCode: practice ? code : undefined }),
        });
        const j = (await res.json()) as { level?: number; hint?: string; message?: string };
        if (!res.ok) throw new Error(j.message ?? "提示生成失败");
        setHints((h) => [
          ...h.filter((x) => x.level !== j.level),
          { level: j.level!, text: j.hint! },
        ]);
        fetch("/api/progress", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "hint", problemSlug: slug, level }),
        }).catch(() => {});
      } catch (e) {
        setHintError(e instanceof Error ? e.message : "提示生成失败");
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

  if (loadError) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-3">
        <p className="text-chalk-300">{loadError}</p>
        <Link href="/" className="text-beam-gold underline">
          返回首页
        </Link>
      </main>
    );
  }

  return (
    <main className="mx-auto flex h-[calc(100dvh-3.5rem)] max-w-[1600px] flex-col gap-3 overflow-hidden p-4">
      {/* ── 顶栏 ── */}
      <header className="flex flex-wrap items-center gap-3">
        <Link
          href="/"
          className="flex h-8 w-8 items-center justify-center rounded-full text-chalk-500 hover:bg-board-700 hover:text-chalk-100"
          aria-label="返回"
        >
          <ArrowLeft size={16} />
        </Link>
        <h1 className="text-lg font-semibold text-chalk-100">
          {detail ? `${detail.number}. ${detail.title}` : "加载中…"}
        </h1>
        {detail && (
          <>
            <span
              className={`rounded-full border px-2 py-0.5 text-xs ${DIFFICULTY_STYLE[detail.difficulty]}`}
            >
              {DIFFICULTY_LABEL[detail.difficulty]}
            </span>
            <span className="rounded-full bg-board-700 px-2 py-0.5 text-xs text-chalk-300">
              {detail.category}
            </span>
          </>
        )}
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={startLecture}
            disabled={lectureBusy || !detail}
            className="flex items-center gap-1.5 rounded-full bg-beam-gold px-4 py-1.5 text-sm font-medium text-board-950 transition-transform hover:scale-105 disabled:pointer-events-none disabled:opacity-50"
          >
            {lectureBusy ? <Sparkles size={15} className="animate-pulse" /> : <Play size={15} />}
            {lectureBusy ? "备课中…" : status === "idle" ? "开始讲课" : "重新讲课"}
          </button>
          <button
            onClick={() => setPractice((p) => !p)}
            className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition-colors ${
              practice
                ? "border-beam-cyan/50 text-beam-cyan"
                : "border-board-600 text-chalk-300 hover:text-chalk-100"
            }`}
          >
            {practice ? <GraduationCap size={15} /> : <Pencil size={15} />}
            {practice ? "回到讲课" : "练习"}
          </button>
        </div>
      </header>

      {/* ── 三栏 ── */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-[3fr_5fr_4fr]">
        {/* 讲义 */}
        <section className="min-h-0 overflow-y-auto rounded-2xl border border-board-700 bg-board-900 p-4">
          <h2 className="mb-3 font-chalk text-xl text-chalk-300">讲义</h2>
          {paragraphs.length > 0 ? (
            <div className="flex flex-col gap-3 text-[15px] leading-7 text-chalk-300">
              {paragraphs.map((p, i) => (
                <p
                  key={i}
                  data-statement={STATEMENT_IDS[i]}
                  className="rounded-lg px-2 py-1 whitespace-pre-line"
                >
                  <InlineMarkdown text={p} />
                </p>
              ))}
            </div>
          ) : (
            <p className="text-sm text-chalk-500">
              {detail ? "本题题面由题目源插件提供（docs/01 §2-①），当前源暂无内容。" : "加载中…"}
            </p>
          )}
          {detail?.testCases && detail.testCases.length > 0 && (
            <div className="mt-4">
              <h3 className="mb-2 text-xs tracking-wide text-chalk-500">测试用例</h3>
              <div className="flex flex-col gap-1.5">
                {detail.testCases.map((t, i) => (
                  <div key={i} className="rounded-lg bg-board-800 px-3 py-1.5 font-mono text-xs">
                    <span className="text-chalk-300">{t.input}</span>
                    <span className="mx-1.5 text-chalk-500">→</span>
                    <span className="text-beam-mint">{t.expected}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>

        {/* 黑板 + 可视化区 + 控制台 */}
        <section className="flex min-h-0 flex-col gap-3">
          <div className="min-h-0 flex-1">
            <CodeEditor
              value={code}
              readOnly={!practice}
              onChange={setCode}
              language="typescript"
            />
          </div>
          {vizFrame && (
            <div className="shrink-0 overflow-x-auto rounded-2xl border border-board-700 bg-board-900 p-3">
              <ArrayVisualizer frame={vizFrame} />
            </div>
          )}
          <div className="flex shrink-0 items-center gap-3 rounded-2xl border border-board-700 bg-board-900 px-4 py-2.5">
            <span className="text-xs tracking-wide text-chalk-500">控制台</span>
            <button
              onClick={run}
              disabled={running || !practice}
              title={practice ? undefined : "切换到「练习」模式后可运行"}
              className="ml-auto flex items-center gap-1.5 rounded-full bg-beam-mint px-4 py-1 text-sm font-medium text-board-950 transition-transform hover:scale-105 disabled:pointer-events-none disabled:opacity-40"
            >
              <Play size={13} />
              {running ? "运行中…" : "运行"}
            </button>
            {runResult && <span className="text-xs text-beam-mint">{runResult}</span>}
          </div>
        </section>

        {/* AI 导师面板 */}
        <aside className="flex min-h-0 flex-col gap-3 overflow-y-auto">
          <NarrationBar />

          {/* 对话历史（占位：追问二期接入） */}
          <div className="flex-1 rounded-2xl border border-board-700 bg-board-900 p-4">
            <h3 className="mb-2 font-chalk text-lg text-chalk-300">AI 导师</h3>
            {status !== "idle" ? (
              <p className="text-sm leading-6 text-chalk-500">
                讲课进行中。追问与自由对话二期接入——先把这堂课听完，老师讲到哪，光就指到哪。
              </p>
            ) : slug === "two-sum" ? (
              <p className="text-sm leading-6 text-chalk-500">
                这道题有内置的旗舰讲解，点击「开始讲课」即可体验完整特效教学。
              </p>
            ) : (
              <div className="text-sm leading-6 text-chalk-500">
                <p>该题讲解脚本由 AI 生成，请到设置页配置 API Key 后点击「开始讲课」。</p>
                {lectureError && <p className="mt-2 text-beam-rose">{lectureError}</p>}
              </div>
            )}
            <div className="mt-3 flex gap-2">
              <input
                disabled
                placeholder="向老师追问…（二期）"
                className="min-w-0 flex-1 rounded-full border border-board-600 bg-board-800 px-3 py-1.5 text-sm text-chalk-100 placeholder:text-chalk-700 disabled:opacity-50"
              />
            </div>
          </div>

          {/* 提示阶梯（docs/03 §6） */}
          <div className="rounded-2xl border border-board-700 bg-board-900 p-4">
            <h3 className="mb-2 flex items-center gap-1.5 text-sm text-chalk-300">
              <Lightbulb size={14} className="text-beam-gold" />
              提示阶梯
            </h3>
            <div className="flex flex-wrap gap-1.5">
              {HINT_LEVELS.map((label, i) => (
                <button
                  key={label}
                  onClick={() => askHint(i + 1)}
                  disabled={hintBusy !== null}
                  className={`rounded-full border px-2.5 py-1 text-xs transition-colors disabled:opacity-50 ${
                    hints.some((h) => h.level === i + 1)
                      ? "border-beam-gold/50 text-beam-gold"
                      : "border-board-600 text-chalk-500 hover:text-chalk-100"
                  }`}
                >
                  {hintBusy === i + 1 ? "…" : `L${i + 1} ${label}`}
                </button>
              ))}
            </div>
            {hintError && <p className="mt-2 text-xs text-beam-rose">{hintError}</p>}
            <div className="mt-2 flex flex-col gap-2">
              {hints
                .sort((a, b) => a.level - b.level)
                .map((h) => (
                  <div
                    key={h.level}
                    className="rounded-lg border border-board-700 bg-board-800 px-3 py-2 text-sm leading-6 text-chalk-300"
                  >
                    <span className="mr-1.5 font-mono text-xs text-beam-gold">L{h.level}</span>
                    {h.text}
                  </div>
                ))}
            </div>
          </div>
        </aside>
      </div>

      {/* ── 底部播放器控制条 ── */}
      <PlayerControls />

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
    </main>
  );
}
