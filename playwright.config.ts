import { defineConfig, devices } from "@playwright/test";
const origin = process.env.PANTRYPILOT_TEST_ORIGIN || "http://127.0.0.1:3100";
const target = new URL(origin);
if (target.protocol !== "http:" || target.hostname !== "127.0.0.1" || !target.port || target.pathname !== "/" || target.search || target.hash || target.username || target.password) {
  throw new Error("Browser tests require an explicit loopback HTTP origin.");
}
export default defineConfig({
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
