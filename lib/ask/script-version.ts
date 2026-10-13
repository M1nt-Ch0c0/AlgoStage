/**
 * scriptVersion of a validated lecture script.
 * `server-only` is not a dependency of this repo, so this module stays importable from tests.
 */
import { createHash } from "node:crypto";

/** sha1 hex of JSON.stringify(validated). Key order is the zod output order. */
export function scriptVersion(validated: unknown): string {
  return createHash("sha1").update(JSON.stringify(validated)).digest("hex");
}
