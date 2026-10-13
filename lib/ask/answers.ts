import { ASK_LIMITS } from "@/lib/ask/types";
import type { AskSelection, AskSelectionSummary, AskTarget, StepAnswer, StepAnswersMap } from "@/lib/ask/types";

function createdAtKey(createdAt: string): number {
  return Date.parse(createdAt);
}

function truncateText(text: string): string {
  return text.length > ASK_LIMITS.targetTextMax ? text.slice(0, ASK_LIMITS.targetTextMax) : text;
}

function copyTarget(target: AskTarget): AskTarget {
  return {
    ...target,
    ...(target.codeRange ? { codeRange: { ...target.codeRange } } : {}),
    ...(target.vizHit
      ? {
          vizHit: {
            ...target.vizHit,
            ...(target.vizHit.nodeIds ? { nodeIds: [...target.vizHit.nodeIds] } : {}),
            ...(target.vizHit.indices ? { indices: [...target.vizHit.indices] } : {}),
          },
        }
      : {}),
    ...(target.text !== undefined ? { text: truncateText(target.text) } : {}),
  };
}

/**
 * Immutable insert. Returns a new map and a new array for `a.stepId`.
 * An existing answer with the same id (searched in that step's list) is
 * replaced. The step's list is then stable-sorted by createdAt ascending,
 * comparing Date.parse values with `<` (equal timestamps keep prior order).
 */
export function appendAnswer(map: StepAnswersMap, a: StepAnswer): StepAnswersMap {
  const previous = Object.hasOwn(map, a.stepId) ? map[a.stepId]! : [];
  const without = previous.filter((answer) => answer.id !== a.id);
  const next = [...without, a].sort((left, right) => {
    const delta = createdAtKey(left.createdAt) - createdAtKey(right.createdAt);
    return delta < 0 ? -1 : delta > 0 ? 1 : 0;
  });
  const result = Object.assign(Object.create(null), map) as StepAnswersMap;
  result[a.stepId] = next;
  return result;
}

/**
 * Fold a list into a map with appendAnswer semantics (replace same id, sort
 * by createdAt). When validStepIds is provided, answers whose stepId is not
 * in the set are dropped.
 */
export function groupAnswersByStep(
  list: readonly StepAnswer[],
  validStepIds?: ReadonlySet<string>,
): StepAnswersMap {
  let map: StepAnswersMap = Object.create(null);
  for (const answer of list) {
    if (validStepIds && !validStepIds.has(answer.stepId)) continue;
    map = appendAnswer(map, answer);
  }
  return map;
}

/** Sum of answer counts across every step. */
export function countAnswers(map: StepAnswersMap): number {
  let total = 0;
  for (const answers of Object.values(map)) total += answers.length;
  return total;
}

/**
 * Each duplicated id once, in the order the second occurrence is first seen.
 * An empty-string id is always reported as "", even when it appears only once.
 */
export function findDuplicateStepIds(steps: readonly { id: string }[]): string[] {
  const seen = new Set<string>();
  const reported = new Set<string>();
  const duplicates: string[] = [];
  let empty = false;
  for (const step of steps) {
    if (step.id === "") empty = true;
    if (seen.has(step.id)) {
      if (!reported.has(step.id)) {
        reported.add(step.id);
        duplicates.push(step.id);
      }
    } else {
      seen.add(step.id);
    }
  }
  if (empty && !reported.has("")) duplicates.push("");
  return duplicates;
}

/**
 * { mode, bbox, targets } with each target.text truncated to
 * ASK_LIMITS.targetTextMax characters. Does not mutate the input.
 */
export function summarizeSelection(s: AskSelection): AskSelectionSummary {
  return {
    mode: s.mode,
    bbox: { ...s.bbox },
    targets: s.targets.map(copyTarget),
  };
}
