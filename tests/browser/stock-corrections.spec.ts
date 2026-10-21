import { test, expect, type Page } from "@playwright/test";
import type { AppView } from "@/lib/types";
const origin = process.env.PANTRYPILOT_TEST_ORIGIN || "http://127.0.0.1:3100";
async function view(page: Page): Promise<AppView> {
  const r = await page.request.get("/api/workspace"); expect(r.status()).toBe(200); return r.json();
}
async function role(page: Page, id: string) {
  await page.getByRole("combobox", { name: "Demo role", exact: true }).selectOption(id);
  await expect.poll(async () => (await view(page)).actor.id).toBe(id);
  await expect(page.getByRole("combobox", { name: "Demo role", exact: true })).toHaveValue(id);
}
async function nav(page: Page, name: string) {
  // A reload resolves before the client workspace has rendered. Wait for its
  // ready surface before deciding whether the mobile drawer must be opened.
  await expect(page.getByRole("combobox", { name: "Demo role", exact: true })).toBeVisible();
  if (await page.getByRole("button", { name: "Open navigation", exact: true }).isVisible()) await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  await page.locator(".sidebar").getByRole("button", { name, exact: true }).click();
  if (name === "Overview") await expect(page.locator(".page-heading h1")).toContainText("Good to see you,");
  else await expect(page.locator(".page-heading h1")).toHaveText(name);
}
async function fresh(page: Page) {
  expect(await (await page.request.get("/api/health")).json()).toMatchObject({ app: "PantryPilot", storage: "local", payments: "simulation", ai: "manual", providerActions: false });
  const r = await page.request.post("/api/demo", { headers: { Origin: origin, "x-forwarded-for": `correction-${crypto.randomUUID()}` }, data: {} });
  expect(r.status()).toBe(200); await page.goto("/workspace");
  await expect(page.getByRole("combobox", { name: "Demo role", exact: true })).toBeVisible();
}
async function command(page: Page, command: string, data: unknown) {
  const r = await page.request.post("/api/command", { headers: { Origin: origin }, data: { command, data, key: crypto.randomUUID() } });
  expect(r.status()).toBe(200); return r.json();
}
async function distribute(page: Page) {
  await role(page, "coordinator-a"); await nav(page, "Inventory & kits");
  await page.getByRole("button", { name: "Distribute", exact: true }).click();
  await page.getByRole("spinbutton", { name: "Kits handed out", exact: true }).fill("5");
  await page.getByRole("button", { name: "Record distribution", exact: true }).click();
  await expect(page.getByText("5 kits distributed", { exact: true })).toBeVisible();
}
async function propose(page: Page, sourceId: string, kind: "distribution" | "receipt") {
  await nav(page, "Inventory & kits"); await page.getByRole("button", { name: "Corrections", exact: true }).click();
  await page.getByRole("combobox", { name: "Original record", exact: true }).selectOption(sourceId);
  const w = await view(page);
  const movements = kind === "distribution" ? w.distributions.find(d => d.id === sourceId)!.movements! : w.orders.find(o => o.id === sourceId)!.receipt!.movements;
  const quantity = kind === "distribution" ? 3 : movements.reduce((s, m) => s + m.quantity, 0) - 2;
  await page.getByRole("spinbutton", { name: kind === "distribution" ? "Corrected kits handed out" : "Corrected receipt units", exact: true }).fill(String(quantity));
  for (const [index, m] of movements.entries()) {
    await page.getByRole("spinbutton", { name: `${m.sku} change · lot ${m.lotId}`, exact: true }).fill(String(kind === "distribution" ? -m.quantity / 5 * 2 : index === 0 ? -2 : 0));
  }
  await page.getByRole("textbox", { name: "Correction reason", exact: true }).fill("Synthetic count transcription error");
  await page.getByRole("textbox", { name: "Physical count evidence reference", exact: true }).fill("Synthetic recount PP-BROWSER. No actual physical stock.");
  await page.getByRole("checkbox", { name: "I checked the physical stock and exact source lots.", exact: true }).check();
  await page.getByRole("button", { name: "Propose correction for owner review", exact: true }).click();
  await expect(page.getByRole("heading", { name: `${kind} correction · proposed`, exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve and apply exact correction", exact: true })).toHaveCount(0);
}
for (const width of [1280, 390]) {
  test(`coordinator to owner correction preserves history and effective totals at ${width}px`, async ({ page }) => {
    const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
    await page.setViewportSize({ width, height: 844 }); await fresh(page); await distribute(page);
    const before = await view(page), source = before.distributions[0];
    await propose(page, source.id, "distribution");
    await role(page, "finance-a"); await nav(page, "Inventory & kits"); await page.getByRole("button", { name: "Corrections", exact: true }).click();
    await expect(page.getByRole("button", { name: "Approve and apply exact correction", exact: true })).toHaveCount(0);
    await role(page, "owner-a"); await nav(page, "Inventory & kits"); await page.getByRole("button", { name: "Corrections", exact: true }).click();
    await page.getByRole("checkbox", { name: "I reviewed the recount evidence and every exact lot change above.", exact: true }).check();
    // Use keyboard activation for the final explicit approval.
    await page.getByRole("button", { name: "Approve and apply exact correction", exact: true }).focus(); await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: "distribution correction · applied", exact: true })).toBeVisible();
    const after = await view(page); expect(after.distributions).toEqual(before.distributions); expect(after.ledger).toEqual(before.ledger);
    expect(after.stockCorrections).toHaveLength(1); expect(after.stockCorrections![0].approverId).toBe("owner-a");
    await page.getByRole("button", { name: "Distribute", exact: true }).click();
    await expect(page.getByText("3 kits distributed", { exact: true })).toBeVisible();
    await expect(page.getByText("Original recorded count: 5. Corrections retain the original history.", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await nav(page, "Overview"); await expect(page.locator(".stats-grid")).toContainText("3");
    await nav(page, "Analytics studio"); await page.getByRole("button", { name: "Open AG Studio canvas", exact: true }).click(); await expect(page.locator(".studio-widget").filter({ hasText: "Recorded kit distributions" })).toContainText("3");
    await page.reload(); await nav(page, "Inventory & kits"); await page.getByRole("button", { name: "Corrections", exact: true }).click();
    await expect(page.getByRole("heading", { name: "distribution correction · applied", exact: true })).toBeVisible();
    await page.screenshot({ path: `output/approved-repairs-2026-10-15/distribution-correction-${width}.png`, fullPage: true });
    await role(page, "donor"); expect((await view(page)).stockCorrections).toEqual([]);
    expect(errors).toEqual([]);
  });
}
test("received shipment correction keeps original receipt and money intact", async ({ page }) => {
  await fresh(page); await role(page, "coordinator-a");
  const r = await command(page, "request", { siteId: "hope-main", kitId: "kit-hope", fundId: "hope-kits", target: 50, budget: 60000, deadline: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10), notes: "Synthetic receipt correction fixture" });
  const p = await command(page, "propose", { id: r.id }); await role(page, "finance-a");
  const a = await command(page, "approve", { id: p.id }); const orders = await command(page, "checkout", { id: a.id });
  const o = orders.find((o: { supplierId: string }) => o.supplierId === "harvest");
  await command(page, "capture", { id: o.id }); await role(page, "supplier-a"); await command(page, "fulfill", { id: o.id, status: "fulfilled" });
  await role(page, "coordinator-a"); await nav(page, "Purchasing");
  await page.getByRole("button", { name: "Confirm pantry receipt", exact: true }).click();
  await expect(page.getByText(/Original receipt: .* units. Effective receipt:/)).toBeVisible();
  const before = await view(page); await propose(page, o.id, "receipt");
  await role(page, "owner-a"); await nav(page, "Inventory & kits"); await page.getByRole("button", { name: "Corrections", exact: true }).click();
  await page.getByRole("checkbox", { name: "I reviewed the recount evidence and every exact lot change above.", exact: true }).check();
  await page.getByRole("button", { name: "Approve and apply exact correction", exact: true }).click();
  await expect(page.getByRole("heading", { name: "receipt correction · applied", exact: true })).toBeVisible();
  const after = await view(page); expect(after.orders).toEqual(before.orders); expect(after.ledger).toEqual(before.ledger);
  await nav(page, "Purchasing"); await expect(page.getByText(/Original receipt: .* units. Effective receipt:/)).toContainText(`Effective receipt: ${after.stockCorrections![0].quantity} units.`);
});
test("stale owner review is rejected and a coordinator can retain then replace the proposal", async ({ page }) => {
  await fresh(page); await distribute(page); const d = (await view(page)).distributions[0]; await propose(page, d.id, "distribution");
  const w = await view(page), lot = w.inventory.find(l => l.id === d.movements![0].lotId)!;
  await command(page, "adjust", { id: lot.id, quantity: lot.quantity + 1, reason: "Synthetic intervening recount" });
  await role(page, "owner-a"); await nav(page, "Inventory & kits"); await page.getByRole("button", { name: "Corrections", exact: true }).click();
  await page.getByRole("checkbox", { name: "I reviewed the recount evidence and every exact lot change above.", exact: true }).check();
  await page.getByRole("button", { name: "Approve and apply exact correction", exact: true }).click();
  await expect(page.locator("main").getByRole("alert")).toContainText("Reject this proposal and recount");
  expect((await view(page)).stockCorrections![0].status).toBe("proposed");
  await page.getByRole("button", { name: "Reject proposal and recount", exact: true }).click();
  await expect(page.getByRole("heading", { name: "distribution correction · rejected", exact: true })).toBeVisible();
  await role(page, "coordinator-a"); await propose(page, d.id, "distribution");
  expect((await view(page)).stockCorrections).toHaveLength(2);
});
