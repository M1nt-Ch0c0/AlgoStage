import { expect, test } from "vitest";

test("all provider adapters construct models locally and incomplete settings fall back to env", async () => {
  const { byokFromEnv, resolveSavedByok, createModel } = await import("../lib/agent/provider");
  expect(byokFromEnv()).toBeNull();
  process.env.AI_MODEL = "test-env-model";
  process.env.AI_API_KEY = "test-env-key";
  expect(resolveSavedByok({ apiKey: "incomplete" })).toMatchObject({ source: "env", config: { model: "test-env-model" } });
  for (const provider of ["openai-compatible", "anthropic", "google"] as const) {
    const config = { provider, model: "test-model", apiKey: "fake-key" };
    expect(createModel(config).modelId).toBe("test-model");
    expect(resolveSavedByok(config)).toMatchObject({ source: "settings", config });
  }
  process.env.AI_BASE_URL = "invalid-url";
  expect(byokFromEnv()).toBeNull();
});
