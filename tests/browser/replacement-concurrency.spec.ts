import { expect, test, type APIResponse, type Page } from "@playwright/test";
import type { AppView, Approval, Donation, Order, Proposal, PurchaseRequest, Recovery } from "@/lib/types";

const origin = process.env.PANTRYPILOT_TEST_ORIGIN || "http://127.0.0.1:3100";

async function fixture(page: Page) {
  const headers = { Origin: origin, "x-forwarded-for": `replacement-${crypto.randomUUID()}` };
  async function success<T>(response: APIResponse): Promise<T> {
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  }
  const as = async (actorId: string) => success(await page.request.post("/api/demo", { headers, data: { actorId } }));
  const send = (command: string, data: unknown) => page.request.post("/api/command", {
    headers, data: { command, data, key: crypto.randomUUID() },
  });
  const command = async <T>(name: string, data: unknown) => success<T>(await send(name, data));
  const workspace = async () => success<AppView>(await page.request.get("/api/workspace"));

  await success(await page.request.post("/api/demo", { headers, data: {} }));
  await as("donor");
  const gift = await command<Donation>("donation", { campaignId: "campaign-hope", amount: 60000 });
  await command("capture", { id: gift.id });
  await as("coordinator-a");
  const deadline = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  const requestData = {
    siteId: "hope-main", kitId: "kit-hope", fundId: "hope-kits",
    target: 50, budget: 60000, deadline, notes: "Synthetic replacement concurrency test",
  };
  const original = await command<PurchaseRequest>("request", requestData);
  const basket = await command<Proposal>("propose", { id: original.id });
  await as("finance-a");
  const approval = await command<Approval>("approve", { id: basket.id });
  const orders = await command<Order[]>("checkout", { id: approval.id });
  expect(orders).toHaveLength(2);
  for (const order of orders) await command("capture", { id: order.id });

  const harvest = orders.find(order => order.supplierId === "harvest")!;
  const rice = harvest.lines.find(line => line.sku === "rice")!;
  expect(rice.packs).toBeGreaterThanOrEqual(2);
  const refunds: Recovery[] = [];
  for (const reason of ["First unavailable pack", "Second unavailable pack"]) {
    await as("supplier-a");
    const refund = await command<Recovery>("partialCancel", { id: harvest.id, catalogId: rice.catalogId, packs: 1, reason });
    expect(refund.amount).toBe(1800);
    await as("finance-a");
    await command("requestRefund", { id: refund.id });
    await as("supplier-b");
    const denied = await send("confirmRefund", { id: refund.id });
    expect(denied.status()).toBe(403);
    expect(await denied.json()).toMatchObject({ error: { code: "MERCHANT" } });
    await as("supplier-a");
    await command("confirmRefund", { id: refund.id });
    refunds.push(refund);
  }
  for (const order of orders) {
    await as(order.supplierId === "harvest" ? "supplier-a" : "supplier-b");
    await command("fulfill", { id: order.id, status: "fulfilled" });
    await as("coordinator-a");
    await command("receive", { id: order.id });
  }
  const draft = (refund: Recovery) => command<Proposal>("replacement", { id: refund.id });
  return { as, command, send, workspace, draft, refunds, requestData };
}

function expectNoFinancialChange(before: AppView, after: AppView) {
  for (const key of ["ledger", "catalog", "orders", "stockReservations", "available", "reserved", "recoveries"] as const) {
    expect(after[key], key).toEqual(before[key]);
  }
}

test("Recovery refuses a competing replacement until the first is cancelled", async ({ page }) => {
  const { as, command, workspace, draft, refunds, requestData } = await fixture(page);
  const first = await draft(refunds[0]);
  expect(first.total).toBe(6150);
  await as("finance-a");
  const approval = await command<Approval>("approve", { id: first.id });
  const [firstOrder] = await command<Order[]>("checkout", { id: approval.id });
  const before = await workspace();
  expect(before.reserved["hope-kits"]).toBe(6150);

  await as("coordinator-a");
  await page.goto("/workspace");
  await page.locator(".sidebar").getByRole("button", { name: "Recovery", exact: true }).click();
  const reply = page.waitForResponse(response => response.url() === `${origin}/api/command` &&
    response.request().method() === "POST" && response.request().postDataJSON().command === "replacement");
  await page.getByRole("button", { name: "Draft replacement basket", exact: true }).click();
  const denied = await reply;
  expect(denied.status()).toBe(409);
  expect(await denied.json()).toMatchObject({ error: { code: "REPLACEMENT_IN_FLIGHT" } });
  await expect(page.getByText("A replacement for this request is already in Purchasing", { exact: false })).toBeVisible();
  await as("finance-a");
  expectNoFinancialChange(before, await workspace());

  await as("coordinator-a");
  const independent = await command<PurchaseRequest>("request", { ...requestData, target: 1 });
  const independentProposal = await command<Proposal>("propose", { id: independent.id });
  await as("finance-a");
  const independentApproval = await command<Approval>("approve", { id: independentProposal.id });
  const independentOrders = await command<Order[]>("checkout", { id: independentApproval.id });
  expect(independentOrders.length).toBeGreaterThan(0);
  for (const order of independentOrders) await command("cancelPayment", { id: order.id });
  await command("cancelPayment", { id: firstOrder.id });
  await as("coordinator-a");
  const retry = await draft(refunds[1]);
  expect(retry.total).toBe(6150);
  await as("finance-a");
  const retryApproval = await command<Approval>("approve", { id: retry.id });
  const retryOrders = await command<Order[]>("checkout", { id: retryApproval.id });
  expect(retryOrders).toHaveLength(1);
  expect((await workspace()).reserved["hope-kits"]).toBe(6150);
});

test("competing checkouts reserve once and an older draft cannot bypass the in-flight guard", async ({ page }) => {
  const { as, command, send, workspace, draft, refunds } = await fixture(page);
  const proposals = [await draft(refunds[0]), await draft(refunds[1])];
  await as("finance-a");
  const approvals = [];
  for (const proposal of proposals) approvals.push(await command<Approval>("approve", { id: proposal.id }));
  const before = await workspace();
  const replies = await Promise.all(approvals.map(approval => send("checkout", { id: approval.id })));
  expect(replies.map(response => response.status()).sort()).toEqual([200, 409]);
  const losingIndex = replies.findIndex(response => response.status() === 409);
  expect(await replies[losingIndex].json()).toMatchObject({ error: { code: "STALE" } });
  const after = await workspace();
  expect(after.orders).toHaveLength(before.orders.length + 1);
  expect(after.reserved["hope-kits"]).toBe(6150);
  expect(after.ledger).toEqual(before.ledger);

  // An existing competing request can be replanned against current stock. It still cannot reserve.
  await as("coordinator-a");
  const replanned = await command<Proposal>("propose", { id: proposals[losingIndex].requestId });
  await as("finance-a");
  const refreshed = await command<Approval>("approve", { id: replanned.id });
  const beforeDenial = await workspace();
  const denied = await send("checkout", { id: refreshed.id });
  expect(denied.status()).toBe(409);
  expect(await denied.json()).toMatchObject({ error: { code: "REPLACEMENT_IN_FLIGHT" } });
  expectNoFinancialChange(beforeDenial, await workspace());
});
