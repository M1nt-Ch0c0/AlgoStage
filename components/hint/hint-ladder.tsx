"use client";

import {
  BASE_URL_INVALID_LECTURE_MESSAGE,
  BASE_URL_NOT_ALLOWED_LECTURE_MESSAGE,
  ByokError,
  fetchServerKeyDisabled,
  isBaseUrlInvalid,
  isBaseUrlNotAllowed,
  isNoByokError,
  NO_BYOK_MESSAGE,
  resolveByokError,
  ServerKeyStatusError,
  UPSTREAM_ERROR_MESSAGE,
  withByok,
} from "@/lib/byok/client";
import { readLocalByok } from "@/lib/byok/storage";
import { apiPath } from "@/lib/runtime";
import { Lightbulb, Loader2 } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

const HINT_LEVELS = ["观察", "模式", "方向", "技巧", "骨架"] as const;

const SLOW_MSG = "老师这会儿有点慢，请再试一次。";

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

export default function HintLadder({
  slug,
  userCode,
}: {
  slug: string;
  userCode?: string;
}) {
  const [hints, setHints] = useState<{ level: number; text: string }[]>([]);
  const [hintBusy, setHintBusy] = useState<number | null>(null);
  const [hintError, setHintError] = useState<{
    code: string;
    message: string;
  } | null>(null);
  const [hintElapsed, setHintElapsed] = useState(0);
  const [retryLevel, setRetryLevel] = useState<number | null>(null);
  const inFlightRef = useRef<boolean>(false);
  const abortRef = useRef<AbortController | null>(null);
  const elapsedTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearElapsed = useCallback(() => {
    if (elapsedTimer.current) {
      clearInterval(elapsedTimer.current);
      elapsedTimer.current = null;
    }
  }, []);

  const cancelHint = useCallback(() => {
    inFlightRef.current = false;
    abortRef.current?.abort();
    abortRef.current = null;
    clearElapsed();
    setHintBusy(null);
    setHintError(null);
    setRetryLevel(null);
  }, [clearElapsed]);

  useEffect(() => {
    return () => {
      inFlightRef.current = false;
      abortRef.current?.abort();
      abortRef.current = null;
      clearElapsed();
    };
  }, [slug, clearElapsed]);

  useEffect(() => {
    inFlightRef.current = false;
    setHints([]);
    setHintError(null);
    setRetryLevel(null);
    setHintBusy(null);
    setHintElapsed(0);
  }, [slug]);

  const askHint = useCallback(
    async (level: number) => {
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      clearElapsed();
      setHintBusy(level);
      setHintError(null);
      setRetryLevel(null);
      setHintElapsed(0);
      elapsedTimer.current = setInterval(() => {
        setHintElapsed((s) => s + 1);
      }, 1000);

      try {
        const localByok = readLocalByok();
        const serverKeyDisabled = localByok
          ? await fetchServerKeyDisabled(ac.signal)
          : false;
        if (ac.signal.aborted) return;
        const res = await fetch(apiPath("/api/hint"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            withByok(
              {
                slug,
                level,
                userCode,
              },
              serverKeyDisabled,
              localByok,
            ),
          ),
          signal: ac.signal,
        });
        const j = (await res.json()) as {
          level?: number;
          hint?: string;
          message?: string;
          error?: string;
          code?: string;
        };
        if (!res.ok) {
          const errorCode = j.code ?? j.error;
          if (errorCode === "TIMEOUT" || res.status === 504) {
            throw new ByokError("TIMEOUT", SLOW_MSG);
          }
          if (isBaseUrlInvalid(j)) {
            throw new ByokError(
              "BASE_URL_INVALID",
              BASE_URL_INVALID_LECTURE_MESSAGE,
            );
          }
          if (isBaseUrlNotAllowed(j)) {
            throw new ByokError(
              "BASE_URL_NOT_ALLOWED",
              BASE_URL_NOT_ALLOWED_LECTURE_MESSAGE,
            );
          }
          if (isNoByokError(j)) {
            throw new ByokError("NO_BYOK", NO_BYOK_MESSAGE);
          }
          const resolved = resolveByokError(j);
          if (resolved) {
            throw new ByokError(resolved.code, resolved.message);
          }
          if (errorCode === "UPSTREAM_ERROR" || res.status === 502) {
            throw new ByokError("UPSTREAM_ERROR", UPSTREAM_ERROR_MESSAGE);
          }
          throw new ByokError(errorCode || "HINT_FAILED", SLOW_MSG);
        }
        setHints((h) => [
          ...h.filter((x) => x.level !== j.level),
          { level: j.level!, text: j.hint! },
        ]);
        fetch(apiPath("/api/progress"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "hint", problemSlug: slug, level }),
        }).catch(() => {});
      } catch (e) {
        if (ac.signal.aborted || isAbortError(e)) {
          // cancelled: no scary error
        } else if (e instanceof ServerKeyStatusError) {
          setHintError({ code: "UPSTREAM_ERROR", message: UPSTREAM_ERROR_MESSAGE });
          setRetryLevel(level);
        } else if (e instanceof ByokError) {
          setHintError({ code: e.code, message: e.message });
          setRetryLevel(level);
        } else {
          setHintError({
            code: "HINT_FAILED",
            message: e instanceof Error ? e.message : SLOW_MSG,
          });
          setRetryLevel(level);
        }
      } finally {
        clearElapsed();
        if (abortRef.current === ac) {
          inFlightRef.current = false;
          abortRef.current = null;
          setHintBusy(null);
        } else if (!abortRef.current) {
          inFlightRef.current = false;
          setHintBusy(null);
        }
      }
    },
    [slug, userCode, clearElapsed],
  );

  return (
    <section className="shrink-0 rounded-2xl border border-board-700/70 bg-board-900/80 p-4">
      <h3 className="flex items-center gap-1.5 text-sm font-medium text-chalk-300">
        <Lightbulb size={14} className="text-beam-gold" />
        提示阶梯
        <span className="ml-auto text-[11px] font-normal text-chalk-700">
          用了几级会记在看板上
        </span>
      </h3>
      <div className="mt-3 flex items-end gap-1.5">
        {HINT_LEVELS.map((label, i) => {
          const used = hints.some((h) => h.level === i + 1);
          const busy = hintBusy === i + 1;
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
              {busy ? (
                <Loader2 size={12} className="animate-spin" aria-hidden />
              ) : (
                label
              )}
            </button>
          );
        })}
      </div>
      {hintBusy !== null && (
        <div
          role="status"
          aria-live="polite"
          className="mt-2 flex items-center gap-2 text-xs text-chalk-400"
        >
          <Loader2 size={12} className="animate-spin" aria-hidden />
          <span>已用 {hintElapsed}s</span>
          <button
            type="button"
            onClick={cancelHint}
            className="rounded-full border border-board-600 px-2 py-0.5 text-chalk-300 hover:text-chalk-100"
          >
            取消
          </button>
        </div>
      )}
      {hintError && (
        <div
          role="alert"
          className="mt-2 flex items-center gap-2 text-xs leading-5 text-beam-rose"
        >
          <p>{hintError.message}</p>
          {(hintError.code === "NO_BYOK" ||
            hintError.code === "BASE_URL_NOT_ALLOWED" ||
            hintError.code === "BASE_URL_INVALID") && (
            <Link
              href={
                hintError.code === "NO_BYOK"
                  ? "/settings?focus=apiKey"
                  : "/settings?focus=baseUrl"
              }
              data-testid="goto-settings"
              className="inline-flex min-h-11 shrink-0 items-center whitespace-nowrap rounded-full border border-beam-gold/60 bg-transparent px-2.5 py-0.5 text-beam-gold transition-colors hover:border-beam-gold"
            >
              去设置
            </Link>
          )}
          {retryLevel !== null && (
            <button
              type="button"
              onClick={() => askHint(retryLevel)}
              disabled={hintBusy !== null}
              className="inline-flex min-h-11 shrink-0 items-center whitespace-nowrap rounded-full border border-beam-rose px-2 py-0.5 disabled:opacity-40"
            >
              重试
            </button>
          )}
        </div>
      )}
      {hints.length > 0 && (
        <div className="mt-3 flex max-h-40 flex-col gap-2 overflow-y-auto">
          {hints
            .slice()
            .sort((a, b) => a.level - b.level)
            .map((h) => (
              <div
                key={h.level}
                className="rounded-lg bg-board-800 px-3 py-2 text-sm leading-6 text-chalk-300"
              >
                <span className="mr-2 font-mono text-[11px] text-beam-gold">
                  L{h.level}
                </span>
                {h.text}
              </div>
            ))}
        </div>
      )}
    </section>
  );
}
