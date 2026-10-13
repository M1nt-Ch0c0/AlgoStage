export type LocalByok = {
  apiKey: string;
  baseURL?: string;
  model?: string;
};

export const BYOK_STORAGE_KEY = "algostage.byok";
export const BYOK_CHANGE_EVENT = "algostage:byok-change";

function sanitizeLocalByok(value: unknown): LocalByok | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.apiKey !== "string") return null;
  const apiKey = record.apiKey.trim();
  if (!apiKey) return null;

  const result: LocalByok = { apiKey };
  if (typeof record.baseURL === "string") {
    const baseURL = record.baseURL.trim();
    if (baseURL) result.baseURL = baseURL;
  }
  if (typeof record.model === "string") {
    const model = record.model.trim();
    if (model) result.model = model;
  }
  return result;
}

export function readLocalByok(): LocalByok | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(BYOK_STORAGE_KEY);
    if (!raw) return null;
    return sanitizeLocalByok(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function writeLocalByok(value: LocalByok): LocalByok | null {
  const sanitized = sanitizeLocalByok(value);
  if (!sanitized || typeof window === "undefined") return null;
  try {
    window.localStorage.setItem(BYOK_STORAGE_KEY, JSON.stringify(sanitized));
  } catch {
    return null;
  }
  window.dispatchEvent(new CustomEvent(BYOK_CHANGE_EVENT, { detail: sanitized }));
  return sanitized;
}

export function clearLocalByok(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(BYOK_STORAGE_KEY);
  } catch {
    // Ignore storage removal errors in restricted environments
  }
  window.dispatchEvent(new CustomEvent(BYOK_CHANGE_EVENT, { detail: null }));
}

export function maskKey(key: string): string {
  const trimmed = typeof key === "string" ? key : "";
  if (trimmed.length <= 8) return "•".repeat(trimmed.length);
  return `••••${trimmed.slice(-4)}`;
}
