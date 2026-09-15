"use client";

import { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";

/* 与 lib/agent/provider.ts 的 PROVIDER_PRESETS 保持一致（静态文案，客户端内联避免打包服务端 SDK） */
const PROVIDER_OPTIONS = [
  {
    id: "openai-compatible",
    label: "OpenAI 兼容（DeepSeek / 通义 / Moonshot / OpenAI…）",
    baseURL: "https://api.deepseek.com/v1",
    modelExample: "deepseek-chat",
  },
  { id: "anthropic", label: "Anthropic Claude", modelExample: "claude-sonnet-4-5" },
  { id: "google", label: "Google Gemini", modelExample: "gemini-2.5-flash" },
] as const;

const EFFECT_LEVELS = [
  { id: "full", label: "华丽", desc: "全部特效" },
  { id: "calm", label: "克制", desc: "关闭压暗与激光教鞭" },
  { id: "minimal", label: "极简", desc: "只留静态高亮" },
] as const;

const SPEEDS = [
  { id: "15", label: "慢 · 15 字/秒" },
  { id: "22", label: "标准 · 22 字/秒" },
  { id: "30", label: "快 · 30 字/秒" },
] as const;

type TestState =
  | { kind: "idle" }
  | { kind: "testing" }
  | { kind: "ok"; message: string }
  | { kind: "fail"; message: string };

function Card({
  title,
  desc,
  children,
}: {
  title: string;
  desc?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-board-700/50 bg-board-900/50 p-6 backdrop-blur-md">
      <h2 className="font-chalk text-2xl text-chalk-100">{title}</h2>
      {desc && <p className="mt-1 text-xs text-chalk-500">{desc}</p>}
      <div className="mt-5">{children}</div>
    </section>
  );
}

const inputClass =
  "w-full rounded-lg border border-board-700/70 bg-board-950/70 px-3 py-2 text-sm text-chalk-100 outline-none transition-colors placeholder:text-chalk-700 focus:border-beam-gold/60";

const labelClass = "mb-1.5 block text-xs text-chalk-500";

export default function SettingsPage() {
  const [provider, setProvider] = useState<string>("openai-compatible");
  const [baseURL, setBaseURL] = useState("https://api.deepseek.com/v1");
  const [apiKey, setApiKey] = useState("");
  const [apiKeyMasked, setApiKeyMasked] = useState("");
  const [model, setModel] = useState("");
  const [theme, setTheme] = useState("dark");
  const [effectLevel, setEffectLevel] = useState("full");
  const [narrationSpeed, setNarrationSpeed] = useState("22");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");
  const [testState, setTestState] = useState<TestState>({ kind: "idle" });
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then(({ settings }) => {
        if (settings.provider) setProvider(settings.provider);
        if (settings.baseURL) setBaseURL(settings.baseURL);
        if (settings.apiKeyMasked) setApiKeyMasked(settings.apiKeyMasked);
        if (settings.model) setModel(settings.model);
        if (settings.theme) {
          setTheme(settings.theme);
          document.documentElement.dataset.theme = settings.theme;
        }
        if (settings.effectLevel) setEffectLevel(settings.effectLevel);
        if (settings.narrationSpeed) setNarrationSpeed(settings.narrationSpeed);
      })
      .catch(() => {});
  }, []);

  function applyTheme(next: string) {
    setTheme(next);
    document.documentElement.dataset.theme = next;
  }

  async function save() {
    setSaveState("saving");
    const settings: Record<string, string> = {
      provider,
      model,
      theme,
      effectLevel,
      narrationSpeed,
    };
    if (provider === "openai-compatible") settings.baseURL = baseURL;
    if (apiKey) settings.apiKey = apiKey;
    try {
      await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings }),
      });
      if (apiKey) {
        setApiKeyMasked(
          apiKey.length > 8 ? `${apiKey.slice(0, 4)}…${apiKey.slice(-4)}` : "已配置",
        );
        setApiKey("");
      }
      setSaveState("saved");
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => setSaveState("idle"), 2000);
    } catch {
      setSaveState("idle");
    }
  }

  async function testConnection() {
    setTestState({ kind: "testing" });
    try {
      const body: Record<string, unknown> = { slug: "two-sum", level: 1 };
      if (apiKey) {
        body.byok = {
          provider,
          model,
          apiKey,
          ...(provider === "openai-compatible" ? { baseURL } : {}),
        };
      }
      const res = await fetch("/api/hint", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (res.ok && data.hint) {
        setTestState({ kind: "ok", message: "连通成功，模型回复正常。" });
      } else if (data.error === "NO_BYOK") {
        setTestState({
          kind: "fail",
          message: apiKey
            ? "服务端未读到 Key，请先保存再试。"
            : "请先输入 API Key 再测试（已保存的 Key 不回传给浏览器）。",
        });
      } else {
        setTestState({
          kind: "fail",
          message: data.message ?? data.error ?? `请求失败（HTTP ${res.status}）`,
        });
      }
    } catch {
      setTestState({ kind: "fail", message: "网络错误，无法连接到本地服务。" });
    }
  }

  const preset = PROVIDER_OPTIONS.find((p) => p.id === provider);

  return (
    <div className="mx-auto max-w-3xl px-6 pb-24 pt-10">
      <header>
        <h1 className="font-chalk text-4xl text-chalk-100">设置</h1>
        <p className="mt-1 text-sm text-chalk-500">
          所有配置只写入本机 SQLite，不出你的电脑
        </p>
      </header>

      <div className="mt-8 space-y-5">
        {/* BYOK */}
        <Card
          title="BYOK · 自带模型"
          desc="请求从本机直连厂商，Key 仅存本地数据库，服务端只回传掩码。"
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className={labelClass} htmlFor="provider">
                Provider
              </label>
              <select
                id="provider"
                value={provider}
                onChange={(e) => setProvider(e.target.value)}
                className={inputClass}
              >
                {PROVIDER_OPTIONS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelClass} htmlFor="model">
                Model Name
              </label>
              <input
                id="model"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder={preset?.modelExample ?? "model-name"}
                className={inputClass}
              />
            </div>
            {provider === "openai-compatible" && (
              <div className="sm:col-span-2">
                <label className={labelClass} htmlFor="baseURL">
                  Base URL
                </label>
                <input
                  id="baseURL"
                  value={baseURL}
                  onChange={(e) => setBaseURL(e.target.value)}
                  placeholder="https://api.deepseek.com/v1"
                  className={`${inputClass} font-mono`}
                />
              </div>
            )}
            <div className="sm:col-span-2">
              <label className={labelClass} htmlFor="apiKey">
                API Key
              </label>
              <input
                id="apiKey"
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={
                  apiKeyMasked ? `已配置（${apiKeyMasked}），输入以更换` : "sk-…"
                }
                className={`${inputClass} font-mono`}
                autoComplete="off"
              />
            </div>
          </div>

          <div className="mt-5 flex flex-wrap items-center gap-3">
            <button
              onClick={save}
              disabled={saveState === "saving"}
              className="inline-flex items-center gap-2 rounded-full bg-beam-gold px-5 py-2 text-sm font-semibold text-board-950 transition-transform duration-150 hover:scale-105 active:scale-95 disabled:opacity-60"
            >
              {saveState === "saved" ? (
                <motion.svg
                  viewBox="0 0 24 24"
                  className="size-4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={3}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <motion.path
                    d="M4 12.5l5 5L20 6.5"
                    initial={{ pathLength: 0 }}
                    animate={{ pathLength: 1 }}
                    transition={{ duration: 0.35, ease: "easeOut" }}
                  />
                </motion.svg>
              ) : null}
              {saveState === "saving"
                ? "保存中…"
                : saveState === "saved"
                  ? "已保存"
                  : "保存"}
            </button>
            <button
              onClick={testConnection}
              disabled={testState.kind === "testing"}
              className="rounded-full border border-board-700 px-5 py-2 text-sm text-chalk-300 transition-colors hover:border-beam-cyan/60 hover:text-beam-cyan disabled:opacity-60"
            >
              {testState.kind === "testing" ? "测试请求中…" : "测一下"}
            </button>
            {testState.kind === "ok" && (
              <motion.span
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                className="text-sm text-beam-mint"
              >
                ✓ {testState.message}
              </motion.span>
            )}
            {testState.kind === "fail" && (
              <motion.span
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                className="text-sm text-beam-rose"
              >
                ✗ {testState.message}
              </motion.span>
            )}
          </div>
        </Card>

        {/* 外观 */}
        <Card title="外观与动效" desc="动效强度是与系统减少动效偏好取更保守者生效。">
          <div className="space-y-5">
            <div>
              <span className={labelClass}>主题</span>
              <div className="flex gap-2">
                {[
                  { id: "dark", label: "Chalkboard Dark" },
                  { id: "light", label: "Paper Light" },
                ].map((t) => (
                  <button
                    key={t.id}
                    onClick={() => applyTheme(t.id)}
                    className={`rounded-full border px-4 py-1.5 text-sm transition-colors ${
                      theme === t.id
                        ? "border-beam-gold/70 text-beam-gold"
                        : "border-board-700 text-chalk-500 hover:text-chalk-300"
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <span className={labelClass}>特效强度</span>
              <div className="grid gap-2 sm:grid-cols-3">
                {EFFECT_LEVELS.map((l) => (
                  <button
                    key={l.id}
                    onClick={() => setEffectLevel(l.id)}
                    className={`rounded-xl border p-3 text-left transition-colors ${
                      effectLevel === l.id
                        ? "border-beam-gold/70 bg-beam-gold/5"
                        : "border-board-700 hover:border-chalk-700"
                    }`}
                  >
                    <span
                      className={`block text-sm ${effectLevel === l.id ? "text-beam-gold" : "text-chalk-100"}`}
                    >
                      {l.label}
                    </span>
                    <span className="mt-0.5 block text-xs text-chalk-500">
                      {l.desc}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            <div>
              <span className={labelClass}>字幕语速</span>
              <div className="flex flex-wrap gap-2">
                {SPEEDS.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => setNarrationSpeed(s.id)}
                    className={`rounded-full border px-4 py-1.5 text-sm transition-colors ${
                      narrationSpeed === s.id
                        ? "border-beam-gold/70 text-beam-gold"
                        : "border-board-700 text-chalk-500 hover:text-chalk-300"
                    }`}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </div>

            <p className="text-xs text-chalk-700">
              外观与动效改动随「保存」一并写入本地设置。
            </p>
          </div>
        </Card>

        {/* 数据 */}
        <Card title="数据" desc="所有数据仅存在本机 SQLite（prisma/algostage.db），不经过任何云服务器。">
          <button
            onClick={async () => {
              const res = await fetch("/api/dashboard");
              const data = await res.json();
              const blob = new Blob([JSON.stringify(data, null, 2)], {
                type: "application/json",
              });
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = `algostage-dashboard-${new Date().toISOString().slice(0, 10)}.json`;
              a.click();
              URL.revokeObjectURL(url);
            }}
            className="rounded-full border border-board-700 px-5 py-2 text-sm text-chalk-300 transition-colors hover:border-beam-gold/60 hover:text-beam-gold"
          >
            导出看板数据（JSON）
          </button>
        </Card>
      </div>
    </div>
  );
}
