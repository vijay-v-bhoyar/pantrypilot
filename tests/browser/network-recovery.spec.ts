import { expect, test, type Page } from "@playwright/test";
import type { AppView } from "@/lib/types";

const origin = process.env.PANTRYPILOT_TEST_ORIGIN || "http://127.0.0.1:3100";
const guidance = "We could not confirm whether this action completed. Use Refresh workspace and check the existing record before trying again.";
async function view(page: Page): Promise<AppView> {
  const response = await page.request.get("/api/workspace");
  expect(response.status()).toBe(200);
  return response.json();
}
async function donor(page: Page) {
  const started = await page.request.post("/api/demo", {
    headers: { Origin: origin, "x-forwarded-for": `network-recovery-${crypto.randomUUID()}` }, data: {},
  });
  expect(started.status()).toBe(200);
  await page.goto("/workspace");
  await page.getByRole("combobox", { name: "Demo role" }).selectOption("donor");
  await expect(page.getByRole("heading", { name: "My giving", exact: true })).toBeVisible();
}

test("pre-send network failure preserves gift input and explains safe recovery", async ({ page }) => {
  await donor(page);
  const amount = page.getByRole("spinbutton", { name: "Gift amount (USD)" });
  await amount.fill("37.42");
  await page.route("**/api/command", route => route.abort("failed"));
  await page.getByRole("button", { name: "Continue to simulated approval", exact: true }).click();
  const alert = page.locator("main").getByRole("alert");
  await expect(alert).toBeVisible();
  await expect(amount).toHaveValue("37.42");
  expect((await view(page)).donations).toEqual([]);
  await expect(page.getByRole("link", { name: "Acknowledgment", exact: true })).toHaveCount(0);
  await expect(alert).toContainText(guidance);
  await page.unroute("**/api/command");
  // This fixture aborted before transmission: inspect state, then try once.
  await page.getByRole("button", { name: "Refresh workspace" }).click();
  expect((await view(page)).donations).toEqual([]);
  await expect(amount).toHaveValue("37.42");
  await page.getByRole("button", { name: "Continue to simulated approval", exact: true }).click();
  await expect(page.getByRole("button", { name: "Simulate payer approval" })).toBeVisible();
  const after = await view(page);
  expect(after.donations).toHaveLength(1);
  expect(after.donations[0]).toMatchObject({ amount: 3742, status: "awaiting_payer" });
});

test("lost capture response explains readback and cannot double-post confirmed giving", async ({ page }) => {
  await donor(page);
  await page.getByRole("spinbutton", { name: "Gift amount (USD)" }).fill("21.37");
  await page.getByRole("button", { name: "Continue to simulated approval", exact: true }).click();
  await expect(page.getByRole("button", { name: "Simulate payer approval" })).toBeVisible();
  const pending = await view(page);
  expect(pending.donations).toHaveLength(1);
  const id = pending.donations[0].id;
  let operation: { command: string; data: { id: string }; key: string } | undefined;
  await page.route("**/api/command", async route => {
    operation = route.request().postDataJSON();
    const committed = await route.fetch();
    expect(committed.status()).toBe(200);
    // The server commits; only its response to the UI is deliberately lost.
    await route.abort("failed");
  });
  await page.getByRole("button", { name: "Simulate payer approval" }).click();
  const alert = page.locator("main").getByRole("alert");
  await expect(alert).toBeVisible();
  const readback = await view(page);
  expect(readback.donations).toHaveLength(1);
  expect(readback.donations[0]).toMatchObject({ id, amount: 2137, status: "confirmed" });
  await expect(alert).toContainText(guidance);
  await page.unroute("**/api/command");
  // Follow the displayed advice; never blindly repeat the payer action.
  await page.getByRole("button", { name: "Refresh workspace" }).click();
  await expect(page.getByRole("link", { name: "Acknowledgment", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Simulate payer approval" })).toHaveCount(0);
  expect((await view(page)).donations[0].id).toBe(id);
  expect(operation).toMatchObject({ command: "capture", data: { id } });
  const replay = await page.request.post("/api/command", { headers: { Origin: origin }, data: operation });
  expect(replay.status()).toBe(200);
  const duplicate = await page.request.post("/api/command", {
    headers: { Origin: origin }, data: { ...operation!, key: crypto.randomUUID() },
  });
  expect(duplicate.status()).toBe(422);
  expect((await duplicate.json()).error.code).toBe("STATE");
  await page.getByRole("combobox", { name: "Demo role" }).selectOption("owner-a");
  await expect(page.getByRole("heading", { name: "Good to see you, Morgan.", exact: true })).toBeVisible();
  const final = await view(page);
  const gift = final.donations.find(d => d.id === id)!;
  expect(final.ledger.filter(e => e.kind === "donation" && e.subjectId === id)).toHaveLength(1);
  expect(final.available["hope-kits"]).toBe(60000 + gift.net!);
});
