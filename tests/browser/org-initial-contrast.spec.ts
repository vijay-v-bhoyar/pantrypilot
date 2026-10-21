import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { writeFile } from "node:fs/promises";
const origin = process.env.PANTRYPILOT_TEST_ORIGIN || "http://127.0.0.1:3100";
async function start(page: Page) {
  const health = await (await page.request.get("/api/health")).json();
  expect(health).toMatchObject({ app: "PantryPilot", storage: "local", payments: "simulation", providerActions: false });
  const r = await page.request.post("/api/demo", { headers: { Origin: origin, "x-forwarded-for": "org-contrast-" + crypto.randomUUID() }, data: {} });
  expect(r.status()).toBe(200);
  await page.goto("/workspace");
  await expect(page.getByRole("heading", { name: "Good to see you, Morgan.", exact: true })).toBeVisible();
}
async function ratio(page: Page) {
  return page.locator(".org-initial").evaluate((element) => {
    const style = getComputedStyle(element);
    const luminance = (color: string) => {
      const rgb = color.match(/[\d.]+/g)!.slice(0, 3).map(Number).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
      return .2126 * rgb[0] + .7152 * rgb[1] + .0722 * rgb[2];
    };
    const values = [luminance(style.color), luminance(style.backgroundColor)].sort((a, b) => a - b);
    return (values[1] + .05) / (values[0] + .05);
  });
}
test("organization initial has readable rendered contrast for every demo permission role", async ({ page }) => {
  await start(page);
  for (const [id, name] of [["owner-a", "Morgan"], ["finance-a", "Jordan"], ["coordinator-a", "Sam"], ["supplier-a", "Avery"], ["donor", "Alex"]]) {
    await page.getByRole("combobox", { name: "Demo role" }).selectOption(id);
    await expect(page.locator(".profile strong")).toContainText(name);
    await expect(page.locator(".org-initial")).toBeVisible();
    expect(await ratio(page)).toBeGreaterThanOrEqual(4.5);
  }
});
test("organization initial remains readable in the opened mobile navigation drawer", async ({ page }) => {
  await start(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".sidebar")).toBeHidden();
  await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  await expect(page.locator(".org-initial")).toBeVisible();
  expect(await ratio(page)).toBeGreaterThanOrEqual(4.5);
  await expect(page.locator(".org-card strong")).toContainText("Hope Community Pantry");
});

test("twelve rendered role/view color scans retain automatic and incomplete findings", async ({ page }) => {
  await start(page);
  const results = [];
  for (const width of [1280, 390]) {
    for (const [actor, name] of [["owner-a", "Morgan"], ["finance-a", "Jordan"], ["coordinator-a", "Sam"], ["supplier-a", "Avery"], ["donor", "Alex"]]) {
      await page.setViewportSize({ width: 1280, height: 844 });
      await page.getByRole("combobox", { name: "Demo role", exact: true }).selectOption(actor);
      await expect(page.locator(".profile strong")).toContainText(name);
      await page.setViewportSize({ width, height: 844 });
      if (width === 390) await page.getByRole("button", { name: "Open navigation", exact: true }).click();
      const scan = await new AxeBuilder({ page }).withRules(["color-contrast"]).analyze();
      results.push({ actor, width, view: "role-home", ratio: await ratio(page), violations: scan.violations, incomplete: scan.incomplete });
      if (width === 390) await page.getByRole("button", { name: "Close navigation", exact: true }).click();
    }
    await page.setViewportSize({ width: 1280, height: 844 });
    await page.getByRole("combobox", { name: "Demo role", exact: true }).selectOption("owner-a");
    await expect(page.locator(".profile strong")).toContainText("Morgan");
    await page.locator(".sidebar").getByRole("button", { name: "Organization", exact: true }).click();
    await page.setViewportSize({ width, height: 844 });
    if (width === 390) await page.getByRole("button", { name: "Open navigation", exact: true }).click();
    const scan = await new AxeBuilder({ page }).withRules(["color-contrast"]).analyze();
    results.push({ actor: "owner-a", width, view: "organization", ratio: await ratio(page), violations: scan.violations, incomplete: scan.incomplete });
    if (width === 390) await page.getByRole("button", { name: "Close navigation", exact: true }).click();
  }
  await writeFile("output/approved-repairs-2026-10-15/contrast-scans.json", JSON.stringify(results, null, 2));
  expect(results).toHaveLength(12);
  for (const r of results) { expect(r.violations).toEqual([]); expect(r.ratio).toBeGreaterThanOrEqual(4.5); }
});

