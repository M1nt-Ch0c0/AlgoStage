"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { KeyRound } from "lucide-react";
import { apiPath } from "@/lib/runtime";
import { useLocalByok } from "@/lib/byok/use-local-byok";

/** 未获取到设置或请求失败时不推断为未配置，避免误导已接入的用户。 */
export default function AiSetupPrompt({ problemSlug }: { problemSlug?: string }) {
  const [keySource, setKeySource] = useState<unknown>(null);
  const [serverKeyDisabled, setServerKeyDisabled] = useState(false);
  const { byok, ready } = useLocalByok();

  useEffect(() => {
    if (problemSlug === "two-sum") return;
    const abort = new AbortController();
    setKeySource(null);
    setServerKeyDisabled(false);
    fetch(apiPath("/api/settings"), { signal: abort.signal, cache: "no-store" })
      .then(async res => {
        if (!res.ok) return;
        const settings = await res.json();
        if (!abort.signal.aborted) {
          setServerKeyDisabled(settings.serverKeyDisabled === true);
          setKeySource(settings.keySource);
        }
      })
      .catch(() => {});
    return () => abort.abort();
  }, [problemSlug]);

  if (problemSlug === "two-sum") return null;
  if (serverKeyDisabled) {
    if (!ready || Boolean(byok?.apiKey)) return null;
  } else if (keySource !== "none") {
    return null;
  }
  return (
    <div className={`flex w-full ${problemSlug ? "" : "max-w-[34rem] "}shrink-0 flex-col gap-3 rounded-xl border border-board-700/70 bg-board-900/80 p-4 text-sm leading-6 text-chalk-300`}>
      <p>{problemSlug
        ? "这道题的 AI 讲解需要你自己的 API Key。"
        : "两数之和可以直接看 AI 讲解。其他题需要先在设置页填入你自己的 API Key。"}</p>
      <div className="flex flex-wrap items-center gap-3">
        <Link href="/settings" className="inline-flex items-center gap-1.5 rounded-full shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-beam-gold)_60%,transparent)] bg-transparent px-4 py-2 text-sm font-semibold text-beam-gold transition-colors hover:bg-beam-gold/10 pointer-coarse:min-h-11">
          <KeyRound size={14} aria-hidden="true" />去设置
        </Link>
        {problemSlug && (
          <Link href="/problem/two-sum" className="text-beam-gold hover:underline">
            先看两数之和
          </Link>
        )}
      </div>
    </div>
  );
}
