import { afterAll, vi } from "vitest";

// Keep each legacy API fixture as isolated as node --test's per-file process.
delete (globalThis as { prisma?: unknown }).prisma;
for (const key of ["AI_API_KEY", "AI_MODEL", "AI_PROVIDER", "AI_BASE_URL", "NEXT_PUBLIC_ALGOSTAGE_DEMO"]) {
  vi.stubEnv(key, "");
}
afterAll(() => vi.unstubAllEnvs());
