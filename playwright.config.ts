import { defineConfig, devices } from "@playwright/test";

const port = process.env.E2E_PORT || "4173";
const byokPort = process.env.E2E_BYOK_PORT || "4174";
const baseURL = `http://127.0.0.1:${port}`;
const byokBaseURL = `http://127.0.0.1:${byokPort}`;

export default defineConfig({
  globalSetup: "./e2e/global-setup.ts",
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    serviceWorkers: "block",
  },
  projects: [
    { name: "chromium", testIgnore: /byok-baseurl\.spec\.ts/, use: { ...devices["Desktop Chrome"] } },
    { name: "byok-baseurl", testMatch: /byok-baseurl\.spec\.ts/, use: { ...devices["Desktop Chrome"], baseURL: byokBaseURL } },
  ],
  webServer: [
    {
      command: "node --import tsx e2e/server.ts",
      env: { E2E_PORT: port },
      url: baseURL,
      reuseExistingServer: false,
      timeout: 120_000,
      gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
    },
    {
      command: "node --import tsx e2e/server.ts",
      env: {
        E2E_PORT: byokPort,
        ALGOSTAGE_DISABLE_SERVER_KEY: "true",
        ALGOSTAGE_ALLOW_PRIVATE_BASE_URL: "false",
      },
      url: byokBaseURL,
      reuseExistingServer: false,
      timeout: 120_000,
      gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
    },
  ],
});
