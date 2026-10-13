import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
      "node:test": fileURLToPath(new URL("./tests/support/node-test.ts", import.meta.url)),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    pool: "forks",
    // API fixtures mutate process.env and use a process-global Prisma client.
    isolate: true,
    fileParallelism: false,
    maxConcurrency: 2,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    setupFiles: ["./tests/support/setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov", "json-summary"],
      include: [
        "lib/teaching/{schema,validated-script}.ts",
        "lib/agent/{provider,request}.ts",
        "lib/agent/lecture-*.ts",
        "lib/agent/{saved-endpoint,upstream-retry}.ts",
        "lib/agent/modes/lecture.ts",
        "lib/agent/ask-generation.ts",
        "lib/agent/modes/ask.ts",
        "lib/player/*.ts",
        "app/api/lecture/route.ts",
        "app/api/progress/route.ts",
        "lib/content/local-source.ts",
        "lib/anchors.ts",
        "lib/ask/**",
        "lib/judge/{browser,compare,worker-common,javascript-worker,python-worker,specs}.ts",
      ],
      thresholds: { perFile: true, statements: 60, branches: 60, functions: 60, lines: 60 },
    },
  },
});
