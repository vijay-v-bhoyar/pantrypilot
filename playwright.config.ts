import { defineConfig, devices } from "@playwright/test";
const origin = process.env.PANTRYPILOT_TEST_ORIGIN || "http://127.0.0.1:3100";
const target = new URL(origin);
if (target.protocol !== "http:" || target.hostname !== "127.0.0.1" || !target.port || target.pathname !== "/" || target.search || target.hash || target.username || target.password) {
  throw new Error("Browser tests require an explicit loopback HTTP origin.");
}
// Explicit milestone exclusions: native Studio UI is retained for a later rights-cleared build.
// These original assertions remain unchanged in journey.spec.ts and are NOT_RUN, never PASS here.
const deferredNativeStudio = [
  "custom AG Studio widgets, saved layout and grid render without errors",
  "native Studio analyst reports real provider denial and rejects unsupported questions",
  "native Studio harness applies and saves a validated view using a transport fixture",
  "native Studio cancellation aborts a pending request and preserves the selected view",
  "native Studio hides unrecognized upstream diagnostics and preserves records"
];
const escapeTitle = (title: string) => title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export default defineConfig({
  grepInvert: new RegExp(`(?:${deferredNativeStudio.map(escapeTitle).join("|")})$`),
  testDir: "./tests/browser",
  fullyParallel: false,
  workers: 1,
  timeout: 60000,
  expect: { timeout: 15000 },
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: origin,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npm run start -- --port ${target.port}`,
    url: `${origin}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 60000,
  },
});
