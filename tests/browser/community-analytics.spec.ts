import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { withWorkspace } from "../../src/lib/storage";
import { execute } from "../../src/lib/commands";
import { dashboardState } from "../../src/lib/dashboard";
import type { AppView } from "../../src/lib/types";
const origin = process.env.PANTRYPILOT_TEST_ORIGIN || "http://127.0.0.1:3100";
const protectedFields = ["ledger", "orders", "donations", "recoveries", "inventory", "distributions", "approvals"] as const;
async function state(page: Page): Promise<AppView> {
  const response = await page.request.get("/api/workspace"); expect(response.ok()).toBe(true); return response.json();
}
async function start(page: Page, analystFixture = false) {
  if (analystFixture) {
    // Expose the client form only; real server/provider configuration remains manual/disabled.
    await page.route("**/api/workspace", async (route) => {
      const response = await route.fetch(); const value = await response.json();
      await route.fulfill({ response, json: { ...value, modes: { ...value.modes, ai: "gemini" } } });
    });
  }
  const response = await page.request.post("/api/demo", { headers: { Origin: origin,
    "x-forwarded-for": `community-${crypto.randomUUID()}` }, data: {} });
  expect(response.ok()).toBe(true);
  await page.goto("/workspace");
  if (await page.getByRole("button", { name: "Open navigation", exact: true }).isVisible())
    await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  await page.getByRole("button", { name: "Analytics studio", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Operational ledger explorer", exact: true })).toBeVisible();
}
async function unchanged(page: Page, before: AppView) {
  const after = await state(page); for (const field of protectedFields) expect(after[field]).toEqual(before[field]);
}
test("Community evidence, saved focus, ledger filtering and currency work without a native canvas", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
  await start(page); const before = await state(page);
  await expect(page.getByRole("button", { name: "Open AG Studio canvas", exact: true })).toHaveCount(0);
  await expect(page.locator("[studio-id]")).toHaveCount(0);
  const evidence = page.getByRole("region", { name: "Operational evidence and next step" });
  await expect(evidence).toContainText("10 complete kits are usable");
  await page.getByLabel("Dashboard focus").selectOption("funds");
  await expect(evidence).toContainText("$600.00 available; $0.00 reserved");
  await expect(evidence).toContainText("Pending recovery is excluded from available funds");
  await page.getByRole("button", { name: "Save current view", exact: true }).click();
  await expect(page.getByRole("button", { name: "Load view", exact: true })).toHaveCount(1);
  await page.getByLabel("Dashboard focus").selectOption("recovery");
  await page.getByRole("button", { name: "Load view", exact: true }).click();
  await expect(page.getByLabel("Dashboard focus")).toHaveValue("funds");
  const rows = page.getByRole("grid").getByRole("row").filter({ has: page.getByRole("gridcell").filter({ hasText: /^\$/ }) });
  await expect(rows.first()).toBeVisible(); const initialRows = await rows.count();
  await expect(page.getByRole("columnheader", { name: /Amount \(USD\)/ })).toBeVisible();
  await expect(page.getByRole("grid").getByRole("gridcell").filter({ hasText: /^\$/ }).first()).toContainText("$");
  const filter = page.getByRole("textbox", { name: "Event Filter Input", exact: true });
  await filter.fill("no-such-confirmed-event"); await expect(rows).toHaveCount(0);
  await filter.fill(""); await expect(rows).toHaveCount(initialRows);
  await unchanged(page, before); expect(errors).toEqual([]);
});
test("Community analyst surfaces real server/provider denial without changing the view", async ({ page }) => {
  await start(page, true); const before = await state(page);
  const response = page.waitForResponse((value) => new URL(value.url()).pathname === "/api/analytics-agent");
  await page.getByRole("button", { name: "Ask analyst & apply view", exact: true }).click();
  expect((await response).ok()).toBe(false);
  await expect(page.getByRole("alert").filter({ hasText: "Configure and authorize Gemini before using the analyst." })).toBeVisible();
  await expect(page.getByLabel("Dashboard focus")).toHaveValue("readiness");
  await unchanged(page, before);
});
test("Community analyst applies validated evidence and saves focus using an explicit transport fixture", async ({ page }) => {
  await page.route("**/api/analytics-agent", (route) => route.fulfill({ json: { focus: "recovery", evidence: {
    availableCents: 60000, reservedCents: 0, pendingRecoveryCents: 0, pendingRecoveryCases: 0,
    readyKits: 10, receivedShipments: 0, recordedKits: 0, unreceivedOrders: 0,
  } } }));
  await start(page, true); const before = await state(page);
  await page.getByRole("button", { name: "Ask analyst & apply view", exact: true }).click();
  await expect(page.getByLabel("Dashboard focus")).toHaveValue("recovery");
  await expect(page.getByRole("status", { name: "Analyst response" })).toContainText("Financial and inventory records are unchanged");
  await page.getByRole("button", { name: "Save current view", exact: true }).click();
  await expect(page.getByRole("button", { name: "Load view", exact: true })).toHaveCount(1);
  await page.getByLabel("Dashboard focus").selectOption("readiness");
  await page.getByRole("button", { name: "Load view", exact: true }).click();
  await expect(page.getByLabel("Dashboard focus")).toHaveValue("recovery");
  const after = await state(page); expect(after.dashboards.at(-1)?.definition).toEqual({ focus: "recovery", period: "all" });
  await unchanged(page, before);
});
test("Community analyst cancellation aborts the pending request and rejects a late view", async ({ page }) => {
  let entered!: () => void, release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const reached = new Promise<void>((resolve) => { entered = resolve; });
  await page.route("**/api/analytics-agent", async (route) => {
    entered(); await pending;
    try { await route.fulfill({ json: { focus: "funds" } }); } catch { /* cancelled */ }
  });
  await start(page, true); const before = await state(page);
  await page.getByRole("button", { name: "Ask analyst & apply view", exact: true }).click(); await reached;
  const cancelled = page.waitForEvent("requestfailed", { predicate: (request) => new URL(request.url()).pathname === "/api/analytics-agent" });
  await page.getByRole("button", { name: "Cancel analysis", exact: true }).click(); await cancelled; release();
  await expect(page.getByRole("button", { name: "Ask analyst & apply view", exact: true })).toBeEnabled();
  await expect(page.getByLabel("Dashboard focus")).toHaveValue("readiness"); await unchanged(page, before);
});
test("Community analyst hides unknown diagnostics and refuses invalid view output", async ({ page }) => {
  const marker = "SYNTHETIC_PRIVATE_DIAGNOSTIC_MARKER";
  let malformed = false;
  await page.route("**/api/analytics-agent", (route) => route.fulfill(malformed ?
    { json: { focus: "unapproved-view", evidence: {} } } : { status: 503, json: { error: { message: marker } } }));
  await start(page, true); const before = await state(page);
  await page.getByRole("button", { name: "Ask analyst & apply view", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "The analyst is unavailable. Your dashboard is preserved." })).toContainText("The analyst is unavailable. Your dashboard is preserved.");
  await expect(page.locator("body")).not.toContainText(marker);
  await expect(page.getByRole("button", { name: "Ask analyst & apply view", exact: true })).toBeEnabled();
  malformed = true; await page.getByRole("button", { name: "Ask analyst & apply view", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "unsupported view" })).toContainText("unsupported view");
  await expect(page.getByLabel("Dashboard focus")).toHaveValue("readiness"); await unchanged(page, before);
});
test("Community mobile keyboard explanations remain usable without an analyst request", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); let requests = 0;
  page.on("request", (request) => { if (new URL(request.url()).pathname === "/api/analytics-agent") requests++; });
  await start(page); const before = await state(page);
  const focus = page.getByLabel("Dashboard focus"); await focus.focus(); await focus.press("ArrowDown"); await focus.press("Tab");
  await expect(focus).toHaveValue("funds");
  await expect(page.getByRole("region", { name: "Operational evidence and next step" })).toContainText("$600.00 available");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(requests).toBe(0); await unchanged(page, before);
  const scan = await new AxeBuilder({ page }).analyze(); expect(scan.violations).toEqual([]);
});
test("Community loads only a legacy saved focus without rewriting its native layout", async ({ page }) => {
  await start(page); const before = await state(page);
  await withWorkspace(before.id, (workspace) => execute(workspace, "owner-a", "dashboard", {
    name: "Retained legacy layout", definition: { focus: "funds", period: "all", studio: dashboardState("funds") },
  }, crypto.randomUUID()));
  const withLegacy = await state(page), original = withLegacy.dashboards.find((view) => view.name === "Retained legacy layout");
  expect(original).toBeTruthy(); await page.reload();
  if (await page.getByRole("button", { name: "Open navigation", exact: true }).isVisible())
    await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  await page.getByRole("button", { name: "Analytics studio", exact: true }).click();
  await page.getByRole("button", { name: "Load view", exact: true }).click();
  await expect(page.getByLabel("Dashboard focus")).toHaveValue("funds");
  await expect(page.getByRole("status").filter({ hasText: "original saved view is unchanged" })).toBeVisible();
  expect((await state(page)).dashboards.find((view) => view.id === original!.id)).toEqual(original);
  await unchanged(page, before);
});
