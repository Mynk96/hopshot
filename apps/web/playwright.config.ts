import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests for the web app (ARCHITECTURE §10).
 *
 * Separate from the Vitest unit tests: these need a real browser, because what they prove —
 * that a URL fragment never reaches the network — is browser behaviour, not something a
 * jsdom stub can demonstrate.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  // A leaked key must never be a flake that gets retried away.
  retries: 0,
  reporter: process.env.CI ? "github" : "list",

  use: {
    baseURL: "http://localhost:4321",
    trace: "on-first-retry",
  },

  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],

  webServer: {
    command: "pnpm dev",
    url: "http://localhost:4321",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
