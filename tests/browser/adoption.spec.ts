import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import type { AppView } from "@/lib/types";
const origin = process.env.PANTRYPILOT_TEST_ORIGIN || "http://127.0.0.1:3100";
async function start(page: Page) {
  const response = await page.request.post("/api/demo", {
    headers: { Origin: origin, "x-forwarded-for": `adoption-${crypto.randomUUID()}` }, data: {},
  });
  expect(response.status()).toBe(200);
  await page.goto("/workspace");
  await expect(page.getByRole("heading", { name: "Good to see you, Morgan." })).toBeVisible();
}
test("each app role can open its workflow guide and reach a permitted next task", async ({ page }) => {
  await start(page);
  for (const [actor, role, action, heading] of [
    ["owner-a", "owner", "Set up your pantry", "Organization"],
    ["finance-a", "finance", "Review a purchase basket", "Purchasing"],
    ["coordinator-a", "coordinator", "Review stock and kits", "Inventory & kits"],
    ["supplier-a", "supplier", "Review your offers", "Supplier portal"],
    ["donor", "donor", "Choose a campaign", "Campaigns"],
  ]) {
    if (actor !== "owner-a") await page.getByRole("combobox", { name: "Demo role" }).selectOption(actor);
    const guide = page.locator("details.workflow-guide");
    const summary = guide.locator("summary");
    await expect(summary).toHaveText(`Your ${role} workflow`);
    await expect(guide.getByRole("button", { name: action, exact: true })).not.toBeVisible();
    await summary.focus(); await page.keyboard.press("Enter");
    await expect(guide.getByRole("button", { name: action, exact: true })).toBeVisible();
    await expect(guide).toContainText("No real money moves in this simulation.");
    if (role === "coordinator") {
      await expect(guide).toContainText("Finance approves the exact basket");
      await expect(guide.getByRole("button", { name: "Set up your pantry" })).toHaveCount(0);
    }
    if (role === "donor") await expect(guide).toContainText("Cancelling monthly support stops future billing");
    await guide.getByRole("button", { name: action, exact: true }).click();
    await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
  }
  await page.setViewportSize({ width: 390, height: 844 });
  const violations = (await new AxeBuilder({ page }).analyze()).violations.filter(v => ["serious", "critical"].includes(v.impact || ""));
  expect(violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "output/adoption-guide-mobile.png", fullPage: true });
});

test("donor can distinguish a failed or pending refund without a repeat-money action", async ({ page }) => {
  await start(page);
  await page.getByRole("combobox", { name: "Demo role" }).selectOption("donor");
  await page.getByRole("button", { name: "Continue to simulated approval" }).click();
  await page.getByRole("button", { name: "Simulate payer approval" }).click();
  await expect(page.getByRole("link", { name: "Acknowledgment" })).toBeVisible();
  let fixture: "failed" | "pending" = "failed";
  // Explicit rendered-state fixture: server ledger remains the original simulation.
  // This does not prove real PayPal refund failure or mutate financial records.
  await page.route("**/api/workspace", async route => {
    const response = await route.fetch(); const view: AppView = await response.json();
    for (const d of view.donations) { d.status = "refund_pending"; d.refundStatus = fixture; }
    await route.fulfill({ response, json: view });
  });
  await page.reload();
  await expect(page.getByText("Refund needs review", { exact: true })).toBeVisible();
  await expect(page.getByText(/provider reported a failed refund/)).toBeVisible();
  await expect(page.getByText(/Do not make another gift to retry this refund/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Simulate payer approval" })).toHaveCount(0);
  fixture = "pending"; await page.getByRole("button", { name: "Refresh workspace" }).click();
  await expect(page.getByText("Refund pending", { exact: true })).toBeVisible();
  await expect(page.getByText("Refund needs review", { exact: true })).toHaveCount(0);
  await expect(page.getByText(/not yet confirmed as refunded/)).toBeVisible();
  await page.screenshot({ path: "output/adoption-refund-pending.png", fullPage: true });
});

// Independent workflow acceptance matrix, not imported from the implementation.
for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
  test(`all 21 role-guide actions navigate correctly at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport); const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await start(page);
    const roles: [string, string, [string, string][]][] = [
      ["owner-a", "owner", [
        ["Set up your pantry", "Organization"], ["Publish a clear campaign", "Campaigns"],
        ["Coordinate a purchase", "Purchasing"], ["Review the activity trail", "Activity"],
      ]],
      ["finance-a", "finance", [
        ["Inspect funds and commitments", "Good to see you, Jordan."], ["Review a purchase basket", "Purchasing"],
        ["Resolve uncertain payments", "Purchasing"], ["Review recovery and replacement", "Recovery"],
        ["Inspect the recorded outcome", "Activity"],
      ]],
      ["coordinator-a", "coordinator", [
        ["Review stock and kits", "Inventory & kits"], ["Prepare a purchase request", "Purchasing"],
        ["Receive delivered supplies", "Purchasing"], ["Record kit distributions", "Inventory & kits"],
        ["Recover a short delivery", "Recovery"],
      ]],
      ["supplier-a", "supplier", [
        ["Review your offers", "Supplier portal"], ["Fulfill your orders", "Supplier portal"],
        ["Handle a cancellation or refund", "Supplier portal"],
      ]],
      ["donor", "donor", [
        ["Choose a campaign", "Campaigns"], ["Review and approve your gift", "My giving"],
        ["Inspect your gift history", "My giving"], ["Manage monthly support", "My giving"],
      ]],
    ];
    let actions = 0;
    for (const [actor, role, steps] of roles) {
      if (actor !== "owner-a") await page.getByRole("combobox", { name: "Demo role" }).selectOption(actor);
      const guide = page.locator("details.workflow-guide");
      await expect(guide.locator("summary")).toHaveText(`Your ${role} workflow`);
      await expect(guide).not.toHaveAttribute("open", "");
      await guide.locator("summary").focus(); await page.keyboard.press("Enter");
      await expect(guide.getByRole("button")).toHaveCount(steps.length);
      for (const [action, heading] of steps) {
        const button = guide.getByRole("button", { name: action, exact: true });
        await expect(button).toBeEnabled(); await button.click();
        await expect(page.locator("main .page-heading h1")).toHaveText(heading);
        await expect(guide.getByRole("button", { name: action, exact: true })).toBeVisible(); actions++;
      }
      if (["supplier", "donor", "coordinator"].includes(role))
        await expect(guide.getByRole("button", { name: "Set up your pantry", exact: true })).toHaveCount(0);
    }
    expect(actions).toBe(21); expect(errors).toEqual([]);
    await page.screenshot({ path: `output/webhook-workflows-2026-10-14/guide-${viewport.width}.png`, fullPage: true });
  });
}
