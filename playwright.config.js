import { defineConfig, devices } from "@playwright/test";
import fs from "node:fs";

// Load e2e credentials from an uncommitted .env.e2e if present. With no
// creds the authenticated specs skip themselves; the unauthenticated smoke
// always runs. (Parsed by hand to avoid adding a dotenv dependency.)
try {
  const raw = fs.readFileSync(new URL(".env.e2e", import.meta.url), "utf8");
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch { /* no .env.e2e — fine, authed specs will skip */ }

const PORT = process.env.E2E_PORT || "4173";
const BASE_URL = process.env.E2E_BASE_URL || `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.js",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
    // Reuse the installed Google Chrome instead of downloading a browser.
    // Swap to the bundled Chromium by removing this and running
    // `npx playwright install chromium`.
    channel: "chrome",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  // Serve a production build on PORT for the run. reuseExistingServer lets a
  // dev already running on that port be reused locally.
  webServer: {
    command: `npm run build && npm run preview -- --port ${PORT}`,
    url: BASE_URL,
    timeout: 120_000,
    reuseExistingServer: !process.env.CI,
  },
});
