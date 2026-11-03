import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { ownedWorkspace } from "../../src/lib/owner-workspace";
import { withWorkspace, loadWorkspace } from "../../src/lib/storage";
import type { AppView } from "../../src/lib/types";
const origin = process.env.PANTRYPILOT_TEST_ORIGIN || "http://127.0.0.1:3100";
async function view(page: Page): Promise<AppView> {
  const r = await page.request.get("/api/workspace"); expect(r.status()).toBe(200); return r.json();
}
async function freshBlank(page: Page) {
  expect(await (await page.request.get("/api/health")).json()).toMatchObject({ app: "PantryPilot", storage: "local", payments: "simulation", ai: "manual", providerActions: false });
  const created = await page.request.post("/api/demo", { headers: { Origin: origin, "x-forwarded-for": `blank-owner-${crypto.randomUUID()}` }, data: {} });
  expect(created.status()).toBe(200); const { workspaceId } = await created.json();
  // Use the real constructor and server/API against a new isolated local file.
  // A synthetic app session replaces Google bootstrap; no identity proof claimed.
  await withWorkspace(workspaceId, w => {
    const blank = ownedWorkspace("synthetic-local-owner"); blank.id = workspaceId; blank.actors[0].id = "owner-a";
    Object.assign(w, blank);
  });
  await page.goto("/workspace"); await expect(page.getByRole("heading", { name: "Set up your pantry", exact: true })).toBeVisible();
  return workspaceId;
}
async function nav(page: Page, name: string) {
  if (await page.getByRole("button", { name: "Open navigation", exact: true }).isVisible()) await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  await page.locator(".sidebar").getByRole("button", { name, exact: true }).click();
  if (name === "Overview") await expect(page.locator(".page-heading h1")).toContainText("Good to see you,");
  else await expect(page.locator(".page-heading h1")).toHaveText(name);
}
for (const width of [1280, 390]) {
  test(`every fully blank owner surface remains usable and honest at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 }); const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
    const id = await freshBlank(page), before = await loadWorkspace(id);
    expect((await view(page)).organizations[0].sites).toEqual([]);
    await expect(page.getByRole("combobox", { name: "Demo role", exact: true })).toHaveCount(0);
    for (const name of ["Overview", "Campaigns", "Inventory & kits", "Purchasing", "Recovery", "Analytics studio", "Activity", "Organization"]) {
      await nav(page, name);
      if (name === "Campaigns") await expect(page.getByRole("button", { name: "New campaign", exact: true })).toBeDisabled();
      if (name === "Purchasing") await expect(page.getByRole("button", { name: "Save purchasing request", exact: true })).toBeDisabled();
      if (name === "Inventory & kits") {
        await expect(page.getByRole("button", { name: "Record distribution", exact: true })).toHaveCount(0);
        for (const tab of ["Import stock", "Kit templates", "Distribute", "Corrections"]) {
          await page.getByRole("button", { name: tab, exact: true }).click();
          if (tab === "Kit templates") await expect(page.getByRole("textbox", { name: "Components", exact: true })).toHaveValue("");
          if (tab === "Corrections") await expect(page.getByRole("heading", { name: "No completed stock records", exact: true })).toBeVisible();
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        }
      }
      if (name === "Analytics studio") {
        // Community cards are rendered directly; no native canvas is opened.
        await expect(page.locator(".studio-widget").filter({ hasText: "Complete kits on hand" })).toContainText("0");
        await expect(page.locator(".studio-widget").filter({ hasText: "Available purpose-aware funds" })).toContainText("$0.00");
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    expect(await loadWorkspace(id)).toEqual(before); expect(errors).toEqual([]);
    await page.screenshot({ path: `output/approved-repairs-2026-10-15/blank-owner-${width}.png`, fullPage: true });
    const scan = await new AxeBuilder({ page }).analyze(); expect(scan.violations).toEqual([]);
  });
}
test("new owner completes first site, blank kit recipe, campaign and fund setup using actual local routes", async ({ page }) => {
  await freshBlank(page);
  await page.getByRole("button", { name: "Add your first site", exact: true }).focus(); await page.keyboard.press("Enter");
  await expect(page.locator(".page-heading h1")).toHaveText("Organization");
  await page.getByRole("textbox", { name: "New site name", exact: true }).fill("Our community pantry");
  await page.getByRole("button", { name: "Add site", exact: true }).click();
  await expect(page.getByRole("button", { name: "Define your first kit", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Define your first kit", exact: true }).click();
  await page.getByRole("button", { name: "Kit templates", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Components", exact: true })).toHaveValue("");
  await page.getByRole("textbox", { name: "Kit name", exact: true }).fill("Our food kit");
  await page.getByRole("textbox", { name: "Components", exact: true }).fill("rice,Rice,2,shelf-stable");
  await page.getByRole("button", { name: "Save kit", exact: true }).click();
  await expect(page.getByRole("button", { name: "Create your first campaign", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Create your first campaign", exact: true }).click();
  await page.getByRole("button", { name: "New campaign", exact: true }).click();
  await page.getByRole("textbox", { name: "Campaign title", exact: true }).fill("Our first food campaign");
  await page.getByRole("spinbutton", { name: "Goal (USD)", exact: true }).fill("100");
  await page.getByRole("spinbutton", { name: "Kit target", exact: true }).fill("10");
  await page.getByRole("textbox", { name: "Campaign story", exact: true }).fill("Synthetic local onboarding workflow");
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Our first food campaign", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Publish campaign", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Set up your pantry", exact: true })).toHaveCount(0);
  const w = await view(page); expect(w.organizations[0].sites).toHaveLength(1); expect(w.kits).toHaveLength(1); expect(w.funds).toHaveLength(1);
  expect(w.ledger).toEqual([]); expect(w.orders).toEqual([]); expect(w.donations).toEqual([]); expect(w.campaignReceived[w.campaigns[0].id]).toBe(0);
  expect(Object.values(w.available)).toEqual([0]);
  await nav(page, "Purchasing"); await expect(page.getByRole("button", { name: "Save purchasing request", exact: true })).toBeEnabled();
  await page.reload(); await expect(page.getByRole("heading", { name: "Set up your pantry", exact: true })).toHaveCount(0);
  const forbidden = await page.request.post("/api/demo", { headers: { Origin: origin }, data: { actorId: "donor" } }); expect(forbidden.status()).toBe(403);
});
