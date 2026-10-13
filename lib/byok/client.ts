import { apiPath } from "@/lib/runtime";
import { type LocalByok, readLocalByok } from "./storage";

export type SettingsResponse = {
  settings?: Record<string, string>;
  keySource?: string;
  envConfigured?: boolean;
  serverKeyDisabled?: boolean;
};

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
    const p = currentFetch(apiPath("/api/settings"), {
      cache: "no-store",
      signal,
    })
      .then(async (res) => {
        if (!res || !res.ok) return false;
        const data = (await res.json().catch(() => null)) as SettingsResponse | null;
        const disabled = data?.serverKeyDisabled === true;
        if (cachedFetchFn === currentFetch) {
          cachedValue = disabled;
        }
        return disabled;
      })
      .catch((err) => {
        if (
          (typeof DOMException !== "undefined" &&
            err instanceof DOMException &&
            err.name === "AbortError") ||
          (err instanceof Error && err.name === "AbortError")
        ) {
          throw err;
        }
        return false;
      })
      .finally(() => {
        if (inFlightPromise === p) {
          inFlightPromise = null;
        }
      });
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
export const BASE_URL_INVALID_MESSAGE = "接口地址格式不对，要以 http:// 或 https:// 开头";
export const BASE_URL_INVALID_LECTURE_MESSAGE = "接口地址格式不对，要以 http:// 或 https:// 开头，去设置页改一下就能开讲。";
export const BASE_URL_NOT_ALLOWED_MESSAGE = "只支持公网 http(s) 地址";
export const BASE_URL_NOT_ALLOWED_SETTINGS_MESSAGE = "接口地址只支持公网 http(s) 地址";
export const BASE_URL_NOT_ALLOWED_LECTURE_MESSAGE = "接口地址只支持公网 http(s) 地址，去设置页改一下就能开讲。";

const BYOK_ERROR_MAP: Record<string, string> = {
  BYOK_KEY_REQUIRED: "用自定义地址时需要同时填你自己的 Key",
  BASE_URL_INVALID: BASE_URL_INVALID_MESSAGE,
  BASE_URL_NOT_ALLOWED: BASE_URL_NOT_ALLOWED_MESSAGE,
  SETTINGS_LOCKED: "公共实例不支持修改服务器设置",
  NO_BYOK: NO_BYOK_MESSAGE,
};

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

export function mapByokErrorMessage(
  data?: unknown,
  fallbackMessage?: unknown,
): string | undefined {
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

  if (code && code in BYOK_ERROR_MAP) {
    return BYOK_ERROR_MAP[code];
  }
  if (msg && msg in BYOK_ERROR_MAP) {
    return BYOK_ERROR_MAP[msg];
  }
  if (msg && msg !== code && !isRawErrorCode(msg)) {
    return msg;
  }
  return undefined;
}
