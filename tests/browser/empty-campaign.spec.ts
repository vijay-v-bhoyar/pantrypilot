// Proposed tests/browser/empty-campaign.spec.ts after human approval.
import { expect, test } from "@playwright/test";
for (const frequency of ["One-time gift", "Monthly support"] as const) {
  test(`empty campaigns explain the owner handoff and disable ${frequency}`, async ({ page }) => {
    const origin = process.env.PANTRYPILOT_TEST_ORIGIN || "http://127.0.0.1:3100";
    const created = await page.request.post("/api/demo", { headers: { Origin: origin, "x-forwarded-for": `empty-campaign-${crypto.randomUUID()}` }, data: {} });
    expect(created.status()).toBe(200);
    await page.goto("/workspace");
    await expect(page.getByRole("heading", { name: "Good to see you, Morgan.", exact: true })).toBeVisible();
    await page.locator(".sidebar").getByRole("button", { name: "Campaigns", exact: true }).click();
    await page.getByRole("button", { name: "Close campaign", exact: true }).click();
    await page.getByRole("combobox", { name: "Demo role", exact: true }).selectOption("donor");
    await expect(page.getByRole("heading", { name: "My giving", exact: true })).toBeVisible();
    await page.getByRole("button", { name: frequency, exact: true }).click();
    await expect(page.getByRole("combobox", { name: "Campaign", exact: true }).locator("option")).toHaveCount(0);
    await expect(page.getByText("There are no open campaigns available. Contact your pantry owner before giving.", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue to simulated approval", exact: true })).toBeDisabled();
    const view = await (await page.request.get("/api/workspace")).json();
    expect(view.donations).toHaveLength(0); expect(view.subscriptions).toHaveLength(0); expect(view.paymentOperations).toHaveLength(0);
    await page.locator(".sidebar").getByRole("button", { name: "Campaigns", exact: true }).click();
    await expect(page.getByRole("heading", { name: "No published campaigns", exact: true })).toBeVisible();
    await expect(page.getByText("Your pantry owner needs to publish a campaign before you can give.", { exact: true })).toBeVisible();
  });
}
