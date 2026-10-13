/**
 * Browser-only StepAnswersMap storage.
 * Key: algostage.answers.<cacheKey>.<scriptVersion>
 * Module init must not touch localStorage.
 */
import { groupAnswersByStep } from "@/lib/ask/answers";
import { stepAnswersMapSchema } from "@/lib/ask/schema";
import type { StepAnswer, StepAnswersMap } from "@/lib/ask/types";

const PREFIX = "algostage.answers.";

export function answersStorageKey(cacheKey: string, version: string): string {
  return `${PREFIX}${cacheKey}.${version}`;
}

function storage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function emptyMap(): StepAnswersMap {
  return Object.create(null);
}

function flatten(map: StepAnswersMap): StepAnswer[] {
  const list: StepAnswer[] = [];
  for (const answers of Object.values(map)) {
    if (Array.isArray(answers)) list.push(...answers);
  }
  return list;
}

export function readBrowserAnswers(
  cacheKey: string,
  version: string,
  validStepIds: ReadonlySet<string>,
): StepAnswersMap {
  if (!cacheKey || !version) return emptyMap();
  const store = storage();
  if (!store) return emptyMap();
  const key = answersStorageKey(cacheKey, version);
  let raw: string | null;
  try {
    raw = store.getItem(key);
  } catch {
    return emptyMap();
  }
  if (raw == null) return emptyMap();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    try { store.removeItem(key); } catch { /* best-effort */ }
    return emptyMap();
  }
  const checked = stepAnswersMapSchema.safeParse(parsed);
  if (!checked.success) {
    try { store.removeItem(key); } catch { /* best-effort */ }
    return emptyMap();
  }
  return groupAnswersByStep(flatten(checked.data), validStepIds);
}

export function writeBrowserAnswers(cacheKey: string, version: string, map: StepAnswersMap): void {
  if (!cacheKey || !version) return;
  const store = storage();
  if (!store) return;
  const checked = stepAnswersMapSchema.safeParse(map);
  if (!checked.success) return;
  try {
    store.setItem(answersStorageKey(cacheKey, version), JSON.stringify(checked.data));
  } catch {
    // QuotaExceededError / SecurityError: keep the in-memory answer, do not surface storage failure.
  }
}

export function clearBrowserAnswersAfterRegenerate(cacheKey: string): void {
  if (!cacheKey) return;
  const store = storage();
  if (!store) return;
  const prefix = `${PREFIX}${cacheKey}.`;
  let keys: string[];
  try {
    keys = [];
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (key && key.startsWith(prefix)) keys.push(key);
    }
  } catch {
    return;
  }
  for (const key of keys) {
    try { store.removeItem(key); } catch { /* best-effort */ }
  }
}
