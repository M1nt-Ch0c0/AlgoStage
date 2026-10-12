import { describe, test as vitestTest } from "vitest";

type Options = { timeout?: number; concurrency?: number };
type Context = { test: (name: string, run: () => unknown) => Promise<void> };
type Run = (context: Context) => unknown;

/** Adapter for the two node:test signatures used by the unchanged legacy tests. */
export function test(name: string, run: Run): void;
export function test(name: string, options: Options, run: Run): void;
export function test(name: string, optionsOrRun: Options | Run, callback?: Run): void {
  const options = typeof optionsOrRun === "function" ? {} : optionsOrRun;
  const run = typeof optionsOrRun === "function" ? optionsOrRun : callback!;
  if (run.length === 0) {
    vitestTest(name, { timeout: options.timeout }, () => run({
      test: () => { throw new Error("Subtests need an explicit context parameter"); },
    }));
    return;
  }

  // The judge matrix discovers subtests asynchronously. Collect their callbacks
  // in a suite, then let Vitest execute/count each one (never run them at import).
  describe(name, async () => {
    const children: { name: string; run: () => unknown }[] = [];
    let parentError: unknown;
    let failed = false;
    try {
      await run({ test: async (name, run) => { children.push({ name, run }); } });
    } catch (error) {
      failed = true;
      parentError = error;
    }
    // node:test counts the parent too; preserve its discovery-time assertions.
    vitestTest("parent assertions", () => { if (failed) throw parentError; });
    for (const child of children) {
      vitestTest(child.name, {
        timeout: options.timeout,
        concurrent: (options.concurrency ?? 1) > 1,
      }, child.run);
    }
  });
}
