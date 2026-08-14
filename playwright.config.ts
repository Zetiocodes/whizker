import { defineConfig } from "@playwright/test";

const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:3000";

/**
 * Playwright E2E configuration (Part 8).
 *
 * The suite is opt-in: it only runs against a hosted Supabase test project.
 * When the E2E env vars (see .env.example) are absent, every spec skips
 * cleanly instead of failing. When E2E_BASE_URL is set the suite expects an
 * already-running app and does not spawn a dev server.
 *
 * workers: 1 and fullyParallel: false — every spec performs live key exchange
 * between two real browsers and shares a room; ordering must stay serial.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 180_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    video: "retain-on-failure",
  },
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: "npm run dev",
        url: baseURL,
        reuseExistingServer: true,
        timeout: 180_000,
      },
});
