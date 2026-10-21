import { test, expect, type Page } from "@playwright/test";
async function safeProfile(page: Page) {
  const r = await page.request.get("/api/health"); expect(r.status()).toBe(200);
  expect(await r.json()).toMatchObject({ app: "PantryPilot", storage: "local", payments: "simulation", ai: "manual", providerActions: false });
}
test("missing-code callback gives a keyboard-operable home return without access", async ({ page }) => {
  await safeProfile(page); const response = await page.goto("/api/auth/callback"); expect(response?.status()).toBe(401);
  await expect(page.getByRole("heading", { name: "Sign-in needs another try", exact: true })).toBeVisible();
  expect((await page.request.get("/api/workspace")).status()).toBe(401);
  const link = page.getByRole("link", { name: "Return to PantryPilot", exact: true }); await link.focus(); await page.keyboard.press("Enter");
  await expect(page.locator(".landing-hero")).toBeVisible(); expect(await page.context().cookies()).toEqual([]);
});
test("unavailable local login offers a mobile home return and creates no session", async ({ page }) => {
  await safeProfile(page); await page.setViewportSize({ width: 390, height: 844 });
  const response = await page.goto("/api/auth/login"); expect(response?.status()).toBe(503);
  await expect(page.getByRole("heading", { name: "Google sign-in is unavailable", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Try Google sign-in again", exact: true })).toHaveCount(0);
  await page.getByRole("link", { name: "Return to PantryPilot", exact: true }).click();
  await expect(page.locator(".landing-hero")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect((await page.request.get("/api/workspace")).status()).toBe(401);
});

