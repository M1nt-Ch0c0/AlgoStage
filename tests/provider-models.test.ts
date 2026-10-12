import { expect, test } from "vitest";

test("各 Provider 构造模型，保存配置按字段回退到环境变量", async () => {
  const { byokFromEnv, resolveSavedByok, createModel } = await import("../lib/agent/provider");
  expect(byokFromEnv()).toBeNull();
  process.env.AI_MODEL = "test-env-model";
  process.env.AI_API_KEY = "test-env-key";
  expect(resolveSavedByok({ apiKey: "incomplete" })).toMatchObject({ source: "settings", config: { apiKey: "incomplete", model: "test-env-model" } });
  for (const provider of ["openai-compatible", "anthropic", "google"] as const) {
    const config = { provider, model: "test-model", apiKey: "fake-key" };
    expect(createModel(config).modelId).toBe("test-model");
    expect(resolveSavedByok(config)).toMatchObject({ source: "settings", config });
  }
  process.env.AI_BASE_URL = "invalid-url";
  expect(byokFromEnv()).toBeNull();
});
