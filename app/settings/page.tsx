"use client";

import { KeySourceBadge, type KeySource } from "@/components/settings/key-source-badge";
import { DEFAULT_MODEL } from "@/lib/agent/defaults";
import { savedEndpoint } from "@/lib/agent/saved-endpoint";
import { mapByokErrorMessage, type SettingsResponse } from "@/lib/byok/client";
import { maskKey, readLocalByok } from "@/lib/byok/storage";
import { useLocalByok } from "@/lib/byok/use-local-byok";
import { apiPath } from "@/lib/runtime";
import { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { Eye, EyeOff } from "lucide-react";
import { PageHeader, Panel } from "@/components/ui/page-header";
import { applyTheme as persistTheme, readTheme } from "@/lib/theme";

/* 与 lib/agent/provider.ts 的 PROVIDER_PRESETS 保持一致（静态文案，客户端内联避免打包服务端 SDK） */
const PROVIDER_OPTIONS = [
  {
    id: "openai-compatible",
    label: "OpenAI 兼容",
    hint: "DeepSeek · 通义 · Kimi · OpenAI",
    baseURL: "https://api.openai.com/v1",
    modelExample: DEFAULT_MODEL,
  },
  { id: "anthropic", label: "Anthropic", hint: "Claude 系列", modelExample: "claude-sonnet-4-5" },
  { id: "google", label: "Google", hint: "Gemini 系列", modelExample: "gemini-2.5-flash" },
] as const;

const EFFECT_LEVELS = [
  { id: "full", label: "华丽", desc: "所有特效都打开" },
  { id: "calm", label: "克制", desc: "少一些特效，更安静" },
  { id: "minimal", label: "极简", desc: "只标出正在讲的那一行" },
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

const inputClass =
  "w-full rounded-lg border border-board-700/70 bg-board-950/70 px-3 py-2.5 text-sm text-chalk-100 outline-none transition-colors placeholder:text-chalk-700 focus:border-beam-gold/60";

const labelClass = "mb-1.5 block text-xs text-chalk-500";

export default function SettingsPage() {
  const [provider, setProvider] = useState<string>("openai-compatible");
  const [baseURL, setBaseURL] = useState("");
  const [baseURLError, setBaseURLError] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [apiKeyMasked, setApiKeyMasked] = useState("");
  const [keySource, setKeySource] = useState<KeySource>("none");
  const [model, setModel] = useState<string>(DEFAULT_MODEL);
  const [theme, setTheme] = useState("dark");
  const [showKey, setShowKey] = useState(false);
  const [effectLevel, setEffectLevel] = useState("full");
  const [narrationSpeed, setNarrationSpeed] = useState("22");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");
  const [saveError, setSaveError] = useState("");
  const [testState, setTestState] = useState<TestState>({ kind: "idle" });
  const [serverKeyDisabled, setServerKeyDisabled] = useState(false);
  const { byok: localByok, save: saveLocalByok, clear: clearLocalByokState } = useLocalByok();
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 只记录真实编辑；预填文案和从服务端读到的旧值都不能隐式写回。
  const edits = useRef<Record<string, string>>({});
  useEffect(() => () => { if (saveTimer.current) clearTimeout(saveTimer.current); }, []);
  function edit(field: string, value: string, setter: (value: string) => void) {
    edits.current[field] = value;
    setter(value);
    setSaveState("idle");
    setSaveError("");
    if (field === "baseURL") setBaseURLError("");
  }


  // 主题以本机 localStorage 为准（导航栏也能切换），这里只读当前值
  useEffect(() => setTheme(readTheme()), []);

  useEffect(() => {
    fetch(apiPath("/api/settings"))
      .then((r) => r.json())
      .then((data: SettingsResponse) => {
        const settings = data.settings ?? {};
        const disabled = data.serverKeyDisabled === true;
        setServerKeyDisabled(disabled);
        setKeySource((data.keySource as KeySource) ?? "none");
        if (settings.provider) setProvider(settings.provider);
        if (disabled) {
          const stored = readLocalByok();
          setBaseURL(stored?.baseURL ?? savedEndpoint(settings) ?? "");
          if (stored?.model) setModel(stored.model);
          else if (settings.model) setModel(settings.model);
        } else {
          setBaseURL(savedEndpoint(settings) ?? "");
          if (settings.apiKeyMasked) setApiKeyMasked(settings.apiKeyMasked);
          if (settings.model) setModel(settings.model);
        }
        if (settings.effectLevel) setEffectLevel(settings.effectLevel);
        if (settings.narrationSpeed) setNarrationSpeed(settings.narrationSpeed);
      })
      .catch(() => {});
  }, []);

  function applyTheme(next: string) {
    edit("theme", next, setTheme);
    persistTheme(next === "light" ? "light" : "dark");
  }

  // 新 Key 的测试和保存共用整组字段，避免保存后换用另一个接口或模型。
  function credentialFields() {
    return { provider, model: model.trim() || DEFAULT_MODEL, apiKey: apiKey.trim(), baseURL: baseURL.trim() };
  }

  function clearLocalKey() {
    clearLocalByokState();
    setApiKey("");
    delete edits.current.apiKey;
    setSaveState("idle");
    setTestState({ kind: "idle" });
  }

  async function save() {
    if (serverKeyDisabled) {
      const nextKey = apiKey.trim() || localByok?.apiKey || "";
      if (nextKey) {
        saveLocalByok({
          apiKey: nextKey,
          baseURL: baseURL.trim() || undefined,
          model: model.trim() || undefined,
        });
      }
      setApiKey("");
      edits.current = {};
      setSaveState("saved");
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => setSaveState("idle"), 2000);
      return;
    }

    setSaveState("saving");
    setSaveError("");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    const pending = { ...edits.current };
    const settings = { ...pending, ...(apiKey.trim() ? credentialFields() : {}) };
    try {
      const res = await fetch(apiPath("/api/settings"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings }),
      });
      if (!res.ok) {
        const data = await res.json();
        if (data.error === "BASE_URL_NOT_ALLOWED") setBaseURLError(data.message);
        else setSaveError(data.message ?? "设置保存失败，请重试。");
        setSaveState("idle");
        return;
      }
      setBaseURLError("");
      const saved = await fetch(apiPath("/api/settings")).then((r) => r.json());
      setKeySource(saved.keySource ?? "none");
      setApiKeyMasked(saved.settings?.apiKeyMasked ?? "");
      for (const [field, value] of Object.entries(pending)) {
        if (edits.current[field] !== value) continue;
        delete edits.current[field];
        if (field === "apiKey") setApiKey("");
      }
      setSaveState("saved");
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => setSaveState("idle"), 2000);
    } catch {
      setSaveState("idle");
      setSaveError("设置保存失败，请重试。");
    }
  }

  async function testConnection() {
    setTestState({ kind: "testing" });
    setSaveState("idle");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    try {
      const body: Record<string, unknown> = {};
      if (serverKeyDisabled) {
        const keyToUse = apiKey.trim() || localByok?.apiKey || "";
        if (keyToUse) {
          const nextByok: { apiKey: string; baseURL?: string; model?: string } = {
            apiKey: keyToUse,
          };
          const trimmedBase = baseURL.trim() || localByok?.baseURL;
          const trimmedModel = model.trim() || localByok?.model;
          if (trimmedBase) nextByok.baseURL = trimmedBase;
          if (trimmedModel) nextByok.model = trimmedModel;
          body.byok = nextByok;
        }
      } else if (apiKey.trim()) {
        const fields = credentialFields();
        body.byok = { ...fields, baseURL: fields.baseURL || undefined };
      } else {
        const changed = Object.fromEntries(Object.entries(edits.current).filter(([key]) => ["baseURL", "provider", "model"].includes(key)));
        if (Object.keys(changed).length) body.byok = changed;
      }
      const res = await fetch(apiPath("/api/settings/test-connection"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        setBaseURLError("");
        setTestState({ kind: "ok", message: "接通了，老师可以上课了。" });
      } else if (data.error === "BASE_URL_NOT_ALLOWED") {
        setBaseURLError(data.message);
        setTestState({ kind: "idle" });
      } else if (data.error === "NO_BYOK" && !serverKeyDisabled) {
        setTestState({
          kind: "fail",
          message: "请填好 API Key 和模型名，或在环境变量中配置后再测试。",
        });
      } else {
        setTestState({
          kind: "fail",
          message:
            mapByokErrorMessage(data) ??
            data.message ??
            data.error ??
            `请求失败（HTTP ${res.status}）`,
        });
      }
    } catch {
      setTestState({ kind: "fail", message: "连不上 AlgoStage，刷新页面再试一次。" });
    }
  }

  const displayedMaskedKey = serverKeyDisabled
    ? (localByok ? maskKey(localByok.apiKey) : "")
    : apiKeyMasked;
  const effectiveKeySource: KeySource = serverKeyDisabled
    ? (localByok ? "settings" : "none")
    : keySource;

  const preset = PROVIDER_OPTIONS.find((p) => p.id === provider);

  const choice = (on: boolean) =>
    `rounded-xl border px-4 py-3 text-left transition-colors ${
      on ? "border-beam-gold/70 bg-beam-gold/[0.07]" : "border-board-700 hover:border-board-600"
    }`;

  return (
    <div className="mx-auto max-w-3xl px-4 pt-10 pb-24 sm:px-6">
      <PageHeader
        eyebrow="本机设置"
        title="设置"
        desc="这些设置只保存在你自己的电脑上。"
      />

      <div className="mt-8 flex flex-col gap-5">
        {/* BYOK */}
        <Panel
          title="接上你的 AI 老师"
          desc="AlgoStage 自己不带 AI，需要接上一个你自己的 AI 账号，老师才能给其余的题备课。账号的钥匙（API Key）只存在这台电脑上，不会发给任何人。"
        >
          <div className="mb-4"><KeySourceBadge source={effectiveKeySource} /></div>
          {serverKeyDisabled ? (
            <p className="mb-4 text-xs text-chalk-500">Key 只保存在你这台浏览器里，不会存到服务器</p>
          ) : (
            <p className="mb-4 text-xs text-chalk-500">只保存你改动的字段。使用环境变量 Key 时，接口地址和服务商也沿用环境变量；可单独修改模型名。保存新 Key 时，请同时填写对应接口地址和服务商。</p>
          )}
          <fieldset>
            <legend className={labelClass}>用哪家的 AI</legend>
            <div className="grid gap-2 sm:grid-cols-3">
              {PROVIDER_OPTIONS.map((p) => (
                <label key={p.id} className={`${choice(provider === p.id)} cursor-pointer`}>
                  <input
                    type="radio"
                    name="provider"
                    id={`provider-${p.id}`}
                    value={p.id}
                    checked={provider === p.id}
                    onChange={() => {
                      edit("provider", p.id, setProvider);
                      edit("baseURL", "", setBaseURL);
                      setTestState({ kind: "idle" });
                    }}
                    className="sr-only"
                  />
                  <span className={`block text-sm font-medium ${provider === p.id ? "text-beam-gold" : "text-chalk-100"}`}>
                    {p.label}
                  </span>
                  <span className="mt-0.5 block text-xs text-chalk-500">{p.hint}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <div className={provider === "openai-compatible" ? "" : "sm:col-span-2"}>
              <label className={labelClass} htmlFor="model">
                模型名
              </label>
              <input
                id="model"
                value={model}
                onChange={(e) => edit("model", e.target.value, setModel)}
                placeholder={`例如 ${preset?.modelExample ?? DEFAULT_MODEL}`}
                className={`${inputClass} font-mono`}
              />
              <p className="mt-2 text-xs leading-5 text-chalk-500">讲解推荐 gpt-6.1-sol。较弱模型可能无法完成教案或正确调用教学工具；失败时请重试或更换模型。</p>
            </div>
            {(
              <div>
                <label className={labelClass} htmlFor="baseURL">
                  接口地址（使用对应服务商的地址）
                </label>
                <input
                  id="baseURL"
                  value={baseURL}
                  onChange={(e) => edit("baseURL", e.target.value, setBaseURL)}
                  placeholder={provider === "openai-compatible" ? "环境变量 Key 沿用环境地址；新 Key 留空使用默认地址" : "留空使用该服务商官方接口"}
                  className={`${inputClass} font-sans tracking-normal [font-variant-ligatures:none]`}
                  aria-invalid={Boolean(baseURLError)}
                  aria-describedby={["baseURL-policy", provider === "openai-compatible" && !baseURL.trim() && "baseURL-hint", baseURLError && "baseURL-error"].filter(Boolean).join(" ")}
                />
                {baseURLError && <p id="baseURL-error" role="alert" className="mt-2 text-xs leading-5 text-beam-rose">{baseURLError}</p>}
                <p id="baseURL-policy" className="mt-2 text-xs leading-5 text-chalk-500">需要公网 http(s) 地址；自托管实例可由管理员允许连接本地模型。</p>
                {provider === "openai-compatible" && !baseURL.trim() && (
                  <p id="baseURL-hint" className="mt-2 text-xs leading-5 text-chalk-500">
                    {!serverKeyDisabled && keySource === "env" && !apiKey.trim()
                      ? "留空：沿用环境变量里配置的接口地址。"
                      : "留空将使用 OpenAI 官方地址 https://api.openai.com/v1；DeepSeek、通义、Kimi 等请填写对应服务商的地址。"}
                  </p>
                )}
              </div>
            )}
            <div className="sm:col-span-2">
              <label className={labelClass} htmlFor="apiKey">
                API Key
                {displayedMaskedKey && <span className="ml-2 text-beam-mint">已配置 {displayedMaskedKey}</span>}
              </label>
              <div className="relative">
                <input
                  id="apiKey"
                  type={showKey ? "text" : "password"}
                  value={apiKey}
                  onChange={(e) => edit("apiKey", e.target.value, setApiKey)}
                  placeholder={displayedMaskedKey ? "输入新的 Key 以更换" : "sk-…"}
                  className={`${inputClass} pr-10 font-mono`}
                  autoComplete="off"
                />
                <button
                  type="button"
                  onClick={() => setShowKey((v) => !v)}
                  aria-label={showKey ? "隐藏 Key" : "显示 Key"}
                  className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-chalk-500 hover:text-chalk-100"
                >
                  {showKey ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
              {!serverKeyDisabled && apiKeyMasked && <button type="button" className="mt-2 text-xs text-beam-cyan" onClick={() => edit("apiKey", "", setApiKey)}>清除已保存 Key，改用环境变量（保存后生效）</button>}
            </div>
          </div>

          <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-board-700/60 pt-5">
            <button
              type="button"
              onClick={save}
              disabled={saveState === "saving"}
              className="inline-flex items-center gap-2 rounded-full bg-beam-gold px-5 py-2 text-sm font-semibold text-on-accent transition-transform duration-150 hover:scale-105 active:scale-95 disabled:opacity-60"
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
              {saveState === "saving" ? "保存中…" : saveState === "saved" ? "已保存" : "保存设置"}
            </button>
            <button
              type="button"
              onClick={testConnection}
              disabled={testState.kind === "testing"}
              className="rounded-full border border-board-600 px-5 py-2 text-sm text-chalk-300 transition-colors hover:border-beam-cyan/60 hover:text-beam-cyan disabled:opacity-60"
            >
              {testState.kind === "testing" ? "正在试着连一下…" : "测试连接"}
            </button>
            {serverKeyDisabled && (
              <button
                type="button"
                onClick={clearLocalKey}
                className="rounded-full border border-board-600 px-5 py-2 text-sm text-chalk-300 transition-colors hover:border-beam-rose/60 hover:text-beam-rose"
              >
                清除本机 Key
              </button>
            )}
            {testState.kind === "ok" && (
              <motion.span initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} className="text-sm text-beam-mint">
                ✓ {testState.message}
              </motion.span>
            )}
            {testState.kind === "fail" && (
              <motion.span initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} className="text-sm text-beam-rose">
                ✗ {testState.message}
              </motion.span>
            )}
          </div>
          {saveError && <p role="alert" className="mt-2 text-sm text-beam-rose">{saveError}</p>}
        </Panel>

        {/* 外观 */}
        <Panel title="外观与动效" desc="主题点一下就换。如果系统里开了「减少动态效果」，特效也会跟着收敛。">
          <div className="flex flex-col gap-6">
            <fieldset>
              <legend className={labelClass}>主题</legend>
              <div className="grid grid-cols-2 gap-2">
                {[
                  { id: "dark", label: "Chalkboard Dark", desc: "墨绿黑板，光束最亮", bg: "#121b18", ink: "#f4f1e8", accent: "#ffd166" },
                  { id: "light", label: "Paper Light", desc: "米色讲义纸，适合白天", bg: "#fffcf5", ink: "#1b2220", accent: "#b97c00" },
                ].map((t) => (
                  <button key={t.id} type="button" aria-pressed={theme === t.id} onClick={() => applyTheme(t.id)} className={choice(theme === t.id)}>
                    <span
                      className="mb-3 flex h-12 items-end gap-1.5 rounded-lg border border-black/10 px-3 pb-2.5"
                      style={{ background: t.bg }}
                      aria-hidden="true"
                    >
                      <span className="h-1.5 w-10 rounded-full" style={{ background: t.ink, opacity: 0.8 }} />
                      <span className="h-1.5 w-6 rounded-full" style={{ background: t.accent }} />
                      <span className="h-1.5 w-8 rounded-full" style={{ background: t.ink, opacity: 0.35 }} />
                    </span>
                    <span className={`block text-sm font-medium ${theme === t.id ? "text-beam-gold" : "text-chalk-100"}`}>{t.label}</span>
                    <span className="mt-0.5 block text-xs text-chalk-500">{t.desc}</span>
                  </button>
                ))}
              </div>
            </fieldset>

            <fieldset>
              <legend className={labelClass}>特效强度</legend>
              <div className="grid gap-2 sm:grid-cols-3">
                {EFFECT_LEVELS.map((l) => (
                  <button key={l.id} type="button" aria-pressed={effectLevel === l.id} onClick={() => edit("effectLevel", l.id, setEffectLevel)} className={choice(effectLevel === l.id)}>
                    <span className={`block text-sm font-medium ${effectLevel === l.id ? "text-beam-gold" : "text-chalk-100"}`}>{l.label}</span>
                    <span className="mt-0.5 block text-xs text-chalk-500">{l.desc}</span>
                  </button>
                ))}
              </div>
            </fieldset>

            <fieldset>
              <legend className={labelClass}>字幕语速</legend>
              <div className="flex flex-wrap gap-2">
                {SPEEDS.map((sp) => (
                  <button
                    key={sp.id}
                    type="button"
                    aria-pressed={narrationSpeed === sp.id}
                    onClick={() => edit("narrationSpeed", sp.id, setNarrationSpeed)}
                    className={`rounded-full border px-4 py-1.5 text-sm transition-colors ${
                      narrationSpeed === sp.id
                        ? "border-beam-gold/70 text-beam-gold"
                        : "border-board-700 text-chalk-500 hover:text-chalk-300"
                    }`}
                  >
                    {sp.label}
                  </button>
                ))}
              </div>
            </fieldset>

            <p className="text-xs text-chalk-700">特效和语速要点「保存设置」才会记住。</p>
          </div>
        </Panel>

        {/* 数据 */}
        <Panel title="数据" desc="你的学习记录只存在这台电脑上。想备份或者换电脑，可以先导出一份。">
          <button
            type="button"
            onClick={async () => {
              const res = await fetch(apiPath("/api/dashboard"));
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
            className="rounded-full border border-board-600 px-5 py-2 text-sm text-chalk-300 transition-colors hover:border-beam-gold/60 hover:text-beam-gold"
          >
            导出学习记录
          </button>
        </Panel>
      </div>
    </div>
  );
}
