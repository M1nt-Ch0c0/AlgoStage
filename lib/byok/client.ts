import { apiPath } from "@/lib/runtime";
import { type LocalByok, readLocalByok } from "./storage";

export type SettingsResponse = {
  settings?: Record<string, string>;
  keySource?: string;
  envConfigured?: boolean;
  serverKeyDisabled?: boolean;
};

export const UPSTREAM_ERROR_MESSAGE = "AI 服务暂时连不上，请稍后再试。";

export class ByokError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ByokError";
    this.code = code;
  }
}

export class ServerKeyStatusError extends ByokError {
  constructor(message = UPSTREAM_ERROR_MESSAGE) {
    super("UPSTREAM_ERROR", message);
    this.name = "ServerKeyStatusError";
  }
}

let cachedFetchFn: typeof fetch | null = null;
let cachedValue: boolean | null = null;
let inFlightPromise: Promise<boolean> | null = null;

export function resetServerKeyDisabledCache(): void {
  cachedFetchFn = null;
  cachedValue = null;
  inFlightPromise = null;
}

function createAbortError(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason;
  if (typeof DOMException !== "undefined") {
    return new DOMException("The operation was aborted.", "AbortError");
  }
  const err = new Error("The operation was aborted.");
  err.name = "AbortError";
  return err;
}

function isAbortError(err: unknown): boolean {
  return (
    (typeof DOMException !== "undefined" &&
      err instanceof DOMException &&
      err.name === "AbortError") ||
    (err instanceof Error && err.name === "AbortError")
  );
}

export async function fetchServerKeyDisabled(
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) {
    throw createAbortError(signal);
  }

  const currentFetch = globalThis.fetch;
  if (cachedFetchFn !== currentFetch) {
    cachedFetchFn = currentFetch;
    cachedValue = null;
    inFlightPromise = null;
  }

  if (cachedValue !== null) {
    return cachedValue;
  }

  if (!inFlightPromise) {
    const attemptOnce = async (): Promise<boolean> => {
      const res = await currentFetch(apiPath("/api/settings"), {
        cache: "no-store",
      });
      if (!res || !res.ok) {
        throw new ServerKeyStatusError();
      }
      let data: SettingsResponse | null;
      try {
        data = (await res.json()) as SettingsResponse | null;
      } catch (err) {
        if (isAbortError(err)) {
          throw err;
        }
        throw new ServerKeyStatusError();
      }
      if (!data || typeof data !== "object") {
        throw new ServerKeyStatusError();
      }
      return data.serverKeyDisabled === true;
    };

    const p = (async () => {
      try {
        const disabled = await attemptOnce();
        if (cachedFetchFn === currentFetch) {
          cachedValue = disabled;
        }
        return disabled;
      } catch (err) {
        if (isAbortError(err)) {
          throw err;
        }
        try {
          const disabled = await attemptOnce();
          if (cachedFetchFn === currentFetch) {
            cachedValue = disabled;
          }
          return disabled;
        } catch (retryErr) {
          if (isAbortError(retryErr)) {
            throw retryErr;
          }
          throw retryErr instanceof ServerKeyStatusError
            ? retryErr
            : new ServerKeyStatusError();
        }
      }
    })().finally(() => {
      if (inFlightPromise === p) {
        inFlightPromise = null;
      }
    });
    p.catch(() => {});
    inFlightPromise = p;
  }

  if (!signal) {
    return inFlightPromise;
  }

  return new Promise<boolean>((resolve, reject) => {
    const onAbort = () => {
      reject(createAbortError(signal));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    inFlightPromise!.then(
      (val) => {
        signal.removeEventListener("abort", onAbort);
        resolve(val);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

export function withByok<T extends Record<string, unknown>>(
  body: T,
  serverKeyDisabled?: boolean,
  byok: LocalByok | null = readLocalByok(),
): T & { byok?: LocalByok } {
  if (serverKeyDisabled !== true || !byok || !byok.apiKey) {
    return { ...body };
  }
  const cleanByok: LocalByok = { apiKey: byok.apiKey };
  if (byok.baseURL) cleanByok.baseURL = byok.baseURL;
  if (byok.model) cleanByok.model = byok.model;
  return { ...body, byok: cleanByok };
}

export const NO_BYOK_MESSAGE = "还没填 API Key。先去设置页填入你自己的 API Key 就能开讲。";
export const NO_BYOK_SETTINGS_MESSAGE = "还没填 API Key。在下面填入你自己的 API Key 就能开讲。";
export const ENDPOINT_SAVED_NEED_KEY_MESSAGE = "接口地址已保存，还要填 API Key 才能开讲。";
export const BASE_URL_INVALID_MESSAGE = "接口地址格式不对，要以 http:// 或 https:// 开头";
export const BASE_URL_INVALID_LECTURE_MESSAGE = "接口地址格式不对，要以 http:// 或 https:// 开头，去设置页改一下就能开讲。";
export const BASE_URL_NOT_ALLOWED_MESSAGE = "接口地址只支持公网 http(s) 地址";
export const BASE_URL_NOT_ALLOWED_SETTINGS_MESSAGE = "接口地址只支持公网 http(s) 地址";
export const BASE_URL_NOT_ALLOWED_LECTURE_MESSAGE = "接口地址只支持公网 http(s) 地址，去设置页改一下就能开讲。";
export const UPSTREAM_AUTH_LECTURE_MESSAGE = "API Key 无效或没有权限，去设置页检查一下就能开讲。";
export const UPSTREAM_AUTH_SETTINGS_MESSAGE = "API Key 无效或没有权限";
export const BYOK_KEY_REQUIRED_MESSAGE = "用自定义接口地址时，需要同时填你自己的 API Key";
export const SETTINGS_LOCKED_MESSAGE = "公共实例不支持修改服务器设置";
export const LECTURE_TIMEOUT_MESSAGE = "备课超时（总上限 240 秒），未保存教案。";
export const HINT_TIMEOUT_MESSAGE = "提示请求超时，请重试。";

const BYOK_BASE_URL_STORAGE_KEY = "algostage.byok.baseURL";

export function readLocalBaseUrl(): string {
  if (typeof window === "undefined") return "";
  try {
    const stored = readLocalByok();
    if (stored?.baseURL) return stored.baseURL;
    const raw = window.localStorage.getItem(BYOK_BASE_URL_STORAGE_KEY);
    return typeof raw === "string" ? raw.trim() : "";
  } catch {
    return "";
  }
}

export function writeLocalBaseUrl(baseURL: string): string {
  if (typeof window === "undefined") return "";
  const trimmed = baseURL.trim();
  try {
    if (trimmed) {
      window.localStorage.setItem(BYOK_BASE_URL_STORAGE_KEY, trimmed);
    } else {
      window.localStorage.removeItem(BYOK_BASE_URL_STORAGE_KEY);
    }
  } catch {
    // Ignore storage errors
  }
  return trimmed;
}

export function clearLocalBaseUrl(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(BYOK_BASE_URL_STORAGE_KEY);
  } catch {
    // Ignore storage errors
  }
}

const BYOK_ERROR_MAP: Record<string, string> = {
  BYOK_KEY_REQUIRED: BYOK_KEY_REQUIRED_MESSAGE,
  BASE_URL_INVALID: BASE_URL_INVALID_MESSAGE,
  BASE_URL_NOT_ALLOWED: BASE_URL_NOT_ALLOWED_MESSAGE,
  SETTINGS_LOCKED: SETTINGS_LOCKED_MESSAGE,
  NO_BYOK: NO_BYOK_MESSAGE,
  UPSTREAM_ERROR: UPSTREAM_ERROR_MESSAGE,
  UPSTREAM_AUTH: UPSTREAM_AUTH_LECTURE_MESSAGE,
};

export function isUpstreamAuth(data: unknown): boolean {
  if (!data || typeof data !== "object") return false;
  const rec = data as Record<string, unknown>;
  return rec.error === "UPSTREAM_AUTH" || rec.code === "UPSTREAM_AUTH";
}

export function isBaseUrlInvalid(data: unknown): boolean {
  if (!data || typeof data !== "object") return false;
  const rec = data as Record<string, unknown>;
  return rec.error === "BASE_URL_INVALID" || rec.code === "BASE_URL_INVALID";
}

export function isBaseUrlNotAllowed(data: unknown): boolean {
  if (!data || typeof data !== "object") return false;
  const rec = data as Record<string, unknown>;
  return (
    rec.error === "BASE_URL_NOT_ALLOWED" || rec.code === "BASE_URL_NOT_ALLOWED"
  );
}

export function isNoByokError(data: unknown): boolean {
  if (!data || typeof data !== "object") return false;
  const rec = data as Record<string, unknown>;
  return rec.error === "NO_BYOK" || rec.code === "NO_BYOK";
}

export function parseFocusParam(search: string): "baseURL" | "apiKey" | null {
  try {
    const params = new URLSearchParams(search);
    const focus = params.get("focus")?.trim();
    if (!focus) return null;
    const lower = focus.toLowerCase();
    if (lower === "baseurl") return "baseURL";
    if (lower === "apikey") return "apiKey";
    return null;
  } catch {
    return null;
  }
}

export function isValidHttpBaseUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true;
  if (!/^https?:\/\/[^/\\\s]/i.test(trimmed) || /[\\\s]/.test(trimmed)) {
    return false;
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (!url.hostname) return false;
  return true;
}

function isRawErrorCode(str: string): boolean {
  return /^[A-Z0-9_]+$/.test(str);
}

export function resolveByokError(
  data?: unknown,
  fallbackMessage?: unknown,
): { code: string; message: string; rawMessage?: string } | undefined {
  let code = "";
  let msg = "";

  if (typeof data === "string") {
    code = data.trim();
    if (typeof fallbackMessage === "string") {
      msg = fallbackMessage.trim();
    }
  } else if (data && typeof data === "object") {
    const rec = data as Record<string, unknown>;
    const rawCode = rec.code ?? rec.error;
    if (typeof rawCode === "string") {
      code = rawCode.trim();
    }
    const rawMsg = rec.message ?? fallbackMessage;
    if (typeof rawMsg === "string") {
      msg = rawMsg.trim();
    }
  } else if (typeof fallbackMessage === "string") {
    msg = fallbackMessage.trim();
  }

  if (code && Object.hasOwn(BYOK_ERROR_MAP, code)) {
    const rawMessage =
      msg && msg !== code && !isRawErrorCode(msg) ? msg : undefined;
    return { code, message: BYOK_ERROR_MAP[code], rawMessage };
  }
  if (msg && Object.hasOwn(BYOK_ERROR_MAP, msg)) {
    return { code: msg, message: BYOK_ERROR_MAP[msg] };
  }
  if (msg && msg !== code && !isRawErrorCode(msg)) {
    return { code: code || "UNKNOWN", message: msg };
  }
  return undefined;
}

export function toByokError(
  data?: unknown,
  fallbackMessage?: string,
  fallbackCode = "UNKNOWN",
): ByokError {
  const resolved = resolveByokError(data);
  if (resolved) {
    return new ByokError(resolved.code, resolved.message);
  }
  return new ByokError(fallbackCode, fallbackMessage ?? "");
}

export function mapByokErrorMessage(
  data?: unknown,
  fallbackMessage?: unknown,
): string | undefined {
  return resolveByokError(data, fallbackMessage)?.message;
}
