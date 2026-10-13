import { HOT100, HOT100_CATEGORIES } from "./hot100";
import type { ProblemMeta } from "./types";

/**
 * Same chapter order as app/roadmap/page.tsx:
 * HOT100_CATEGORIES first, unknown categories after in first-seen order,
 * then each chapter sorted by `order`.
 */
export function roadmapOrder(): ProblemMeta[] {
  const byCategory = new Map<string, ProblemMeta[]>();
  for (const problem of HOT100) {
    const list = byCategory.get(problem.category) ?? [];
    list.push(problem);
    byCategory.set(problem.category, list);
  }
  const ordered = [
    ...HOT100_CATEGORIES,
    ...[...byCategory.keys()].filter((c) => !(HOT100_CATEGORIES as readonly string[]).includes(c)),
  ];
  return ordered
    .filter((c) => byCategory.has(c))
    .flatMap((c) => byCategory.get(c)!.sort((a, b) => a.order - b.order));
}

const order = roadmapOrder();
const indexBySlug = new Map(order.map((problem, index) => [problem.slug, index]));

/** Next problem in roadmap order. Null when slug is last or unknown. */
export function nextProblem(slug: string): ProblemMeta | null {
  const index = indexBySlug.get(slug);
  if (index === undefined) return null;
  return order[index + 1] ?? null;
}
