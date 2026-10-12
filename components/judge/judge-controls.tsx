"use client";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import type { ProblemDetail } from "@/lib/content/types";
import type { JudgeResult } from "@/lib/judge/types";
import { judgeInBrowser } from "@/lib/judge/browser";
import { pythonWorkerPool } from "@/lib/judge/python-pool";
import { apiPath, IS_DEMO } from "@/lib/runtime";
export default function JudgeControls({ detail, code, language, onLanguage, disabled = false, onResult }: {
  detail: ProblemDetail | null; code: string; language: "typescript" | "python";
  onLanguage: (language: "typescript" | "python") => void;
  disabled?: boolean; onResult?: (result: JudgeResult) => Promise<void> | void;
}) {
  const [busy,setBusy] = useState(false), [message,setMessage] = useState(""), [result,setResult] = useState<JudgeResult | null>(null);
  const [saving, setSaving] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const pythonStatus = useSyncExternalStore(pythonWorkerPool.subscribe, pythonWorkerPool.getStatus, () => "idle");
  useEffect(() => { pythonWorkerPool.preload(); }, []);
  useEffect(() => { setResult(null); setMessage(""); return () => controller.current?.abort(); },[detail?.slug,language]);
  async function run() {
    if (!detail?.judging || busy || disabled) return;
    const abort = new AbortController(); controller.current = abort;
    setBusy(true); setResult(null);
    try {
      let judged = await judgeInBrowser({ code, language, problem: detail.judging },{ signal: abort.signal, onProgress: setMessage });
      if (abort.signal.aborted) { setMessage("已取消运行，没有记录提交。"); return; }
      setResult(judged);
      if (judged.error) { setMessage("运行环境未能加载，请重试。"); return; }
      const needsVerification = judged.verdict === "AC" && language !== "python";
      const clientAc = judged.verdict === "AC" && language === "python";
      if (!IS_DEMO || needsVerification) {
        setSaving(true);
        setMessage(needsVerification ? "本地用例通过，正在等待服务端判定…" : "正在保存提交…");
        const response = await fetch(apiPath(needsVerification ? "/api/judge" : "/api/progress"), {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(needsVerification ? { problemSlug: detail.slug, language, code } : {
            type: clientAc ? "client-ac" : "submission", problemSlug: detail.slug, language, code,
            verdict: judged.verdict, runtimeMs: Math.round(judged.runtimeMs),
          }),
        });
        if (response.status === 429) { setMessage("判题繁忙，结果未保存，请稍后再试"); return; }
        const saved = await response.json();
        if (!response.ok) throw new Error(saved.message ?? "保存结果失败，请重试。");
        if (needsVerification) judged = saved.result as JudgeResult;
      }
      if (abort.signal.aborted) return;
      setResult(judged);
      setMessage(`${judged.verdict} · ${judged.cases.filter(c=>c.verdict==="AC").length}/${detail.judging.cases.length} 个用例通过${IS_DEMO ? "（体验版不保存）" : " · 已保存"}`);
      await onResult?.(judged);
    } catch (error) {
      if (!abort.signal.aborted) setMessage(error instanceof Error ? error.message : "运行或保存结果失败，请重试。");
    }
    finally { if (controller.current === abort) { setBusy(false); setSaving(false); controller.current = null; } }
  }
  const failed = result?.cases.find(c=>c.verdict!=="AC");
  return <div className="shrink-0 rounded-xl border border-board-700 bg-board-900/80 p-3">
    <div className="flex flex-wrap items-center gap-3">
      <label className="text-xs text-chalk-500">代码语言 <select aria-label="代码语言" value={language} disabled={busy || disabled} onChange={e=>{ setResult(null); onLanguage(e.target.value as "typescript"|"python"); }} className="ml-2 rounded bg-board-800 p-1 text-chalk-100">
        <option value="typescript">TypeScript / JS</option><option value="python">Python</option>
      </select></label>
      <button type="button" onClick={run} disabled={busy || disabled || !detail?.judging} className="ml-auto rounded-full bg-beam-mint px-4 py-1.5 text-sm font-semibold text-on-accent disabled:opacity-40">{busy ? "判题中…" : "运行"}</button>
      {!disabled && pythonStatus === "loading" && <span role="status" aria-live="polite" className="text-xs text-chalk-300">正在加载 Python 环境…</span>}
      {busy && !saving && <button type="button" onClick={()=>controller.current?.abort()} className="text-sm text-chalk-300">取消运行</button>}
    </div>
    <p role="status" aria-live="polite" className="mt-2 text-xs text-chalk-300">{message || (detail && !detail.judging ? "这道题暂未配判题用例，目前支持路线图前 20 题。" : disabled ? "切到练习后可运行代码。" : "使用本机浏览器判题，运行时间限制 2 秒，输出上限 32 KiB。")}</p>
    {failed && <div className="mt-3 grid max-h-44 gap-2 overflow-auto text-xs sm:grid-cols-3">
      <div>输入<pre className="whitespace-pre-wrap break-all">{failed.input}</pre></div>
      <div>期望<pre className="whitespace-pre-wrap break-all">{failed.expected}</pre></div>
      <div>你的输出<pre className="whitespace-pre-wrap break-all">{failed.stderr || failed.actual}</pre></div>
    </div>}
    {detail && <Link href={`/judge/${detail.slug}`} target="_blank" rel="noopener" className="mt-2 inline-block text-xs text-chalk-500 hover:text-beam-cyan">打开独立判题页 ↗</Link>}
  </div>;
}
