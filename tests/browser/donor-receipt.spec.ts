import { expect, test, type Page } from "@playwright/test";
import type { AppView } from "@/lib/types";

const origin = process.env.PANTRYPILOT_TEST_ORIGIN || "http://127.0.0.1:3100";
async function view(page: Page): Promise<AppView> {
  const response = await page.request.get(`${origin}/api/workspace`);
  expect(response.status()).toBe(200);
  return response.json();
}
async function role(page: Page, id: string, name: string) {
  await page.getByRole("combobox", { name: "Demo role", exact: true }).selectOption(id);
  await expect(page.locator(".profile strong")).toContainText(name);
}
async function freshDonor(page: Page) {
  const response = await page.request.post(`${origin}/api/demo`, {
    headers: { Origin: origin, "x-forwarded-for": `receipt-${crypto.randomUUID()}` }, data: {},
  });
  expect(response.status()).toBe(200);
  await page.goto(`${origin}/workspace`);
  await role(page, "donor", "Alex");
  await expect(page.getByRole("heading", { name: "My giving", exact: true })).toBeVisible();
  await page.getByRole("spinbutton", { name: "Gift amount (USD)", exact: true }).fill("25");
  await page.getByRole("button", { name: "Continue to simulated approval", exact: true }).click();
  await expect(page.getByRole("button", { name: "Simulate payer approval", exact: true })).toBeVisible();
}
async function capture(page: Page) {
  await page.getByRole("button", { name: "Simulate payer approval", exact: true }).click();
  await expect(page.getByRole("link", { name: "Acknowledgment", exact: true })).toBeVisible();
}
async function requestRefund(page: Page) {
  await role(page, "finance-a", "Jordan");
  await page.locator(".sidebar").getByRole("button", { name: "Organization", exact: true }).click();
  await page.getByRole("button", { name: "Approve donation refund", exact: true }).click();
  await expect(page.getByRole("button", { name: "Simulate confirmed refund", exact: true })).toBeVisible();
}

test("refunded gift retains its donor acknowledgment without staff or anonymous access", async ({ page, browser }) => {
  await freshDonor(page);
  await capture(page);
  const before = (await view(page)).donations[0];
  await requestRefund(page);
  await page.getByRole("button", { name: "Simulate confirmed refund", exact: true }).click();
  await expect(page.getByRole("button", { name: "Simulate confirmed refund", exact: true })).toHaveCount(0);
  await role(page, "donor", "Alex");
  const gift = (await view(page)).donations[0];
  expect(gift).toMatchObject({ id: before.id, status: "refunded", amount: 2500, captureId: before.captureId });
  const link = page.getByRole("link", { name: "Acknowledgment", exact: true });
  await expect(link).toBeVisible();
  const target = new URL((await link.getAttribute("href"))!, origin);
  expect(target.origin).toBe(origin);
  expect(target.pathname).toBe("/api/receipt");
  expect(target.searchParams.get("id")).toBe(before.id);
  const receipt = await page.request.get(target.href);
  expect(receipt.status()).toBe(200);
  expect(receipt.headers()["cache-control"]).toBe("no-store");
  const html = await receipt.text();
  expect(html).toContain("refunded");
  expect(html).toContain(before.captureId!);
  expect(html).toContain("not a tax receipt");
  await page.reload();
  await expect(page.getByRole("link", { name: "Acknowledgment", exact: true })).toBeVisible();
  await role(page, "finance-a", "Jordan");
  expect((await page.request.get(target.href)).status()).toBe(403);
  const anonymous = await browser.newContext();
  try { expect((await anonymous.request.get(target.href)).status()).toBe(403); }
  finally { await anonymous.close(); }
});

test("unconfirmed gifts and pending refunds expose no completed acknowledgment", async ({ page }) => {
  await freshDonor(page);
  const pending = (await view(page)).donations[0];
  expect(pending.status).toBe("awaiting_payer");
  await expect(page.getByRole("link", { name: "Acknowledgment", exact: true })).toHaveCount(0);
  expect((await page.request.get(`${origin}/api/receipt?id=${pending.id}`)).status()).toBe(403);
  await capture(page);
  await requestRefund(page);
  await role(page, "donor", "Alex");
  expect((await view(page)).donations[0].status).toBe("refund_pending");
  await expect(page.getByText("Refund pending", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Acknowledgment", exact: true })).toHaveCount(0);
  expect((await page.request.get(`${origin}/api/receipt?id=${pending.id}`)).status()).toBe(403);
});
