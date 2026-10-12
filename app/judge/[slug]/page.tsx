"use client";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { apiPath } from "@/lib/runtime";
import type { ProblemDetail } from "@/lib/content/types";
import CodeEditor from "@/components/board/code-editor";
import JudgeControls from "@/components/judge/judge-controls";
export default function JudgePage() {
  const { slug } = useParams<{slug:string}>();
  const [detail,setDetail] = useState<ProblemDetail | null>(null), [code,setCode] = useState(""), [language,setLanguage] = useState<"typescript"|"python">("typescript"), [error,setError] = useState("");
  useEffect(()=>{
    const controller = new AbortController();
    fetch(apiPath(`/api/problems/${slug}`),{ signal: controller.signal }).then(async res=>{ if (!res.ok) throw new Error("没有找到这道题。"); return res.json(); }).then(({problem})=>{ setDetail(problem); setCode(problem.referenceSolutions?.find((s:{language:string})=>s.language==="typescript")?.code ?? ""); }).catch(e=>{ if (!controller.signal.aborted) setError(e.message); });
    return ()=>controller.abort();
  },[slug]);
  function changeLanguage(next:"typescript"|"python") { setLanguage(next); setCode(detail?.referenceSolutions?.find(s=>s.language===next)?.code ?? ""); }
  return <div className="mx-auto max-w-5xl space-y-4 px-4 py-8">
    <h1 className="chalk text-3xl text-chalk-100">{detail?.title ?? "正在加载题目…"} · 判题</h1>
    {error && <p role="alert">{error}</p>}
    <div className="h-[32rem] overflow-hidden rounded-xl border border-board-700"><CodeEditor value={code} language={language} readOnly={false} onChange={setCode}/></div>
    <JudgeControls detail={detail} code={code} language={language} onLanguage={changeLanguage}/>
  </div>;
}
