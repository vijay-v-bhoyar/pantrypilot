import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/webhooks/paypal/route";
import { seedWorkspace } from "@/lib/seed";
import type { Donation, Workspace } from "@/lib/types";

// Real handler, signature-verification adapter, settlement and ledger. Only
// HTTP transport and transactional persistence are fixtures; no network/keys.
const mocks = vi.hoisted(() => ({
  mutate: vi.fn(), fetch: vi.fn(), state: null as Workspace | null,
  read: {} as Record<string, unknown>, verification: "SUCCESS", saveFails: false,
}));
vi.mock("@/lib/storage", () => ({ withWorkspace: mocks.mutate }));
const workspaceId = "12345678-1234-4234-8234-123456789abc";
const signature = {
  "paypal-auth-algo": "SHA256withRSA", "paypal-cert-url": "https://api.sandbox.paypal.com/cert/fixture",
  "paypal-transmission-id": "transmission", "paypal-transmission-sig": "fixture-signature",
  "paypal-transmission-time": "2026-10-14T12:00:00Z",
};
function request(type: string, resource: Record<string, unknown>, id = "EVENT-1", profile = "hope", headers = signature) {
  return new Request(`http://127.0.0.1:3101/api/webhooks/paypal?workspace=${workspaceId}&profile=${profile}`, {
    method: "POST", headers, body: JSON.stringify({ id, event_type: type, resource }),
  });
}
function w() { return mocks.state!; }
function gift(): Donation {
  const d: Donation = { id: "gift", organizationId: "hope", donorId: "donor",
    campaignId: "campaign-hope", fundId: "hope-kits", amount: 2500,
    status: "awaiting_payer", providerId: "ORDER-1", evidence: "paypal_sandbox", createdAt: w().createdAt };
  w().donations.push(d); return d;
}
function subscription() {
  const s = { id: "subscription", organizationId: "hope", donorId: "donor",
    campaignId: "campaign-hope", amount: 2500, status: "awaiting_payer" as const,
    providerId: "SUB-1", evidence: "paypal_sandbox" as const, createdAt: w().createdAt };
  w().subscriptions.push(s); return s;
}
function sale(id = "SALE-1") {
  return { id, state: "completed", billing_agreement_id: "SUB-1",
    amount: { currency: "USD", total: "25.00" }, transaction_fee: { currency: "USD", value: "1.19" } };
}
function capture() {
  return { id: "ORDER-1", status: "COMPLETED", purchase_units: [{
    custom_id: `${workspaceId}:gift`, payee: { merchant_id: "merchant-hope" },
    amount: { currency_code: "USD", value: "25.00" }, payments: { captures: [{
      id: "CAPTURE-1", status: "COMPLETED", amount: { currency_code: "USD", value: "25.00" },
      seller_receivable_breakdown: { net_amount: { currency_code: "USD", value: "23.81" } },
    }] },
  }] };
}
const captureResource = { id: "CAPTURE-1", supplementary_data: { related_ids: { order_id: "ORDER-1" } } };
const reads = () => mocks.fetch.mock.calls.filter(([url]) => !String(url).endsWith("/token") && !String(url).endsWith("verify-webhook-signature"));
async function rejected(req: Request, code?: string) {
  const before = structuredClone(w()); const response = await POST(req);
  expect(response.status).toBeGreaterThanOrEqual(400);
  if (code) expect((await response.json()).error.code).toBe(code);
  expect(w()).toEqual(before); // no ledger, journal, receipt or status commit
}
beforeEach(() => {
  vi.stubEnv("APP_ENV", "local"); vi.stubEnv("VERCEL", "");
  vi.stubEnv("STORAGE_MODE", "local"); vi.stubEnv("PAYMENTS_MODE", "sandbox");
  vi.stubEnv("PROVIDER_ACTIONS_ENABLED", "true");
  vi.stubEnv("PAYPAL_MERCHANTS_JSON", JSON.stringify(Object.fromEntries(["hope", "harvest"].map(profile => [profile,
    { clientId: "fixture", secret: "fixture", merchantId: `merchant-${profile}`, webhookId: `WEBHOOK-${profile}` }]))));
  mocks.state = seedWorkspace(workspaceId); mocks.read = {}; mocks.verification = "SUCCESS"; mocks.saveFails = false;
  mocks.mutate.mockReset(); mocks.fetch.mockReset(); vi.stubGlobal("fetch", mocks.fetch);
  let queue = Promise.resolve();
  mocks.mutate.mockImplementation((id: string, callback: (state: Workspace) => unknown) => {
    const operation = queue.catch(() => undefined).then(async () => {
      if (id !== workspaceId) throw new Error("fixture unknown workspace");
      const draft = structuredClone(w()); const result = await callback(draft);
      if (mocks.saveFails) throw new Error("fixture save failure private details");
      mocks.state = draft; return result;
    });
    queue = operation.then(() => undefined, () => undefined); return operation;
  });
  mocks.fetch.mockImplementation(async (url: string) => {
    if (url.endsWith("/v1/oauth2/token")) return Response.json({ access_token: "fixture-token" });
    if (url.endsWith("verify-webhook-signature")) return Response.json({ verification_status: mocks.verification });
    return Response.json(mocks.read);
  });
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("full PayPal webhook route with fake transports", () => {
  it.each(Object.keys(signature))("rejects missing signature field %s before workspace access", async key => {
    const headers = { ...signature }; delete headers[key as keyof typeof signature];
    await rejected(request("PAYMENT.SALE.COMPLETED", {}, "EVENT-1", "hope", headers), "WEBHOOK_SIGNATURE");
    expect(mocks.mutate).not.toHaveBeenCalled(); expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it.each(["https://evil.example/cert", "http://api.sandbox.paypal.com/cert"])("rejects certificate origin %s", async cert => {
    await rejected(request("PAYMENT.SALE.COMPLETED", {}, "EVENT-1", "hope", { ...signature, "paypal-cert-url": cert }), "WEBHOOK_CERT");
    expect(mocks.mutate).not.toHaveBeenCalled(); expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it("requires successful verification before reads or persistence", async () => {
    mocks.verification = "FAILURE";
    await rejected(request("PAYMENT.SALE.COMPLETED", {}), "WEBHOOK_SIGNATURE");
    expect(mocks.mutate).not.toHaveBeenCalled(); expect(reads()).toHaveLength(0);
  });
  it("passes the exact event and selected webhook ID to verification", async () => {
    const response = await POST(request("UNSUPPORTED.EVENT", { id: "RESOURCE" }));
    expect(await response.json()).toEqual({ ignored: true, eventType: "UNSUPPORTED.EVENT" });
    const call = mocks.fetch.mock.calls.find(([url]) => String(url).endsWith("verify-webhook-signature"))!;
    expect(JSON.parse(call[1].body)).toMatchObject({ webhook_id: "WEBHOOK-hope",
      webhook_event: { id: "EVENT-1", event_type: "UNSUPPORTED.EVENT", resource: { id: "RESOURCE" } } });
    expect(w().providerEvents).toHaveLength(0); expect(reads()).toHaveLength(0);
  });
  it.each(["", "bad/profile"])("rejects invalid profile %s before HTTP", async profile => {
    await rejected(request("PAYMENT.SALE.COMPLETED", {}, "EVENT-1", profile), "INPUT");
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it.each(["", "SALE-X"])("rejects unassociated billing resource %s", async agreement => {
    subscription(); await rejected(request("PAYMENT.SALE.COMPLETED", { id: "SALE-1", billing_agreement_id: agreement }), "EVENT_OWNER");
    expect(reads()).toHaveLength(0);
  });
  it("rejects the wrong billing merchant before resource reads", async () => {
    subscription(); await rejected(request("PAYMENT.SALE.COMPLETED", { id: "SALE-1", billing_agreement_id: "SUB-1" }, "EVENT-1", "harvest"), "MERCHANT");
    expect(reads()).toHaveLength(0);
  });
  it.each(["ACTIVE", "CANCELLED", "SUSPENDED", "APPROVAL_PENDING"])("reads subscription %s without inventing a receipt", async status => {
    subscription(); const ledger = structuredClone(w().ledger);
    mocks.read = { id: "SUB-1", custom_id: `${workspaceId}:subscription`, status };
    expect((await POST(request("BILLING.SUBSCRIPTION.ACTIVATED", { id: "SUB-1" }))).status).toBe(200);
    expect(w().subscriptions[0].status).toBe(status === "APPROVAL_PENDING" ? "awaiting_payer" : status.toLowerCase());
    expect(w().donations).toHaveLength(0); expect(w().ledger).toEqual(ledger);
  });
  it.each(["id", "custom_id"])("rejects subscription readback %s mismatch", async field => {
    subscription(); mocks.read = { id: "SUB-1", custom_id: `${workspaceId}:subscription`, status: "ACTIVE", [field]: "OTHER" };
    await rejected(request("BILLING.SUBSCRIPTION.ACTIVATED", { id: "SUB-1" }));
  });
  it.each(["ACTIVE", "SUSPENDED"])("failed-billing event follows current readback %s, without credit", async status => {
    subscription(); const ledger = structuredClone(w().ledger);
    mocks.read = { id: "SUB-1", custom_id: `${workspaceId}:subscription`, status };
    expect((await POST(request("BILLING.SUBSCRIPTION.PAYMENT.FAILED", { id: "SUB-1" }))).status).toBe(200);
    expect(w().subscriptions[0].status).toBe(status.toLowerCase()); expect(w().ledger).toEqual(ledger);
  });
  it.each(["id", "billing_agreement_id", "state"])("rejects completed sale readback %s mismatch", async field => {
    subscription(); mocks.read = { ...sale(), [field]: "OTHER" };
    await rejected(request("PAYMENT.SALE.COMPLETED", { id: "SALE-1", billing_agreement_id: "SUB-1" }));
  });
  it.each(["25.001", "2.5e1", " 25.00", "", "NaN", "-25.00", "26.00"])("rejects billing total %s without committing funds", async total => {
    subscription(); mocks.read = { ...sale(), amount: { currency: "USD", total } };
    await rejected(request("PAYMENT.SALE.COMPLETED", { id: "SALE-1", billing_agreement_id: "SUB-1" }), "AMOUNT");
  });
  it.each(["-1.00", "1.001", "26.00", "NaN", "", "1e0"])("rejects invalid fee %s without committing funds", async value => {
    subscription(); mocks.read = { ...sale(), transaction_fee: { currency: "USD", value } };
    await rejected(request("PAYMENT.SALE.COMPLETED", { id: "SALE-1", billing_agreement_id: "SUB-1" }));
  });
  it.each(["amount", "transaction_fee"])("rejects non-USD %s", async field => {
    subscription(); const read = sale(); mocks.read = { ...read, [field]: { ...read[field as keyof typeof read] as object, currency: "EUR" } };
    await rejected(request("PAYMENT.SALE.COMPLETED", { id: "SALE-1", billing_agreement_id: "SUB-1" }));
  });
  it.each(["0.00", "25.00"])("accepts boundary fee %s and posts exact cents", async value => {
    subscription(); mocks.read = { ...sale(), transaction_fee: { currency: "USD", value } };
    expect((await POST(request("PAYMENT.SALE.COMPLETED", { id: "SALE-1", billing_agreement_id: "SUB-1" }))).status).toBe(200);
    expect(w().donations[0].net).toBe(value === "0.00" ? 2500 : 0);
  });
  it("credits cycles separately and deduplicates same/different event replay of a sale", async () => {
    subscription(); mocks.read = sale(); const resource = { id: "SALE-1", billing_agreement_id: "SUB-1" };
    expect((await POST(request("PAYMENT.SALE.COMPLETED", resource))).status).toBe(200);
    expect(await (await POST(request("PAYMENT.SALE.COMPLETED", resource))).json()).toEqual({ duplicate: true });
    expect(reads()).toHaveLength(1);
    expect((await POST(request("PAYMENT.SALE.COMPLETED", resource, "EVENT-2"))).status).toBe(200);
    mocks.read = sale("SALE-2");
    expect((await POST(request("PAYMENT.SALE.COMPLETED", { ...resource, id: "SALE-2" }, "EVENT-3"))).status).toBe(200);
    expect(w().donations).toHaveLength(2);
    const entries = w().ledger.filter(e => e.kind === "donation");
    expect(entries).toHaveLength(2); expect(entries.map(e => e.amount)).toEqual([2381, 2381]);
  });
  it("retains cancellation while accepting a delayed already-confirmed sale", async () => {
    subscription(); w().subscriptions[0].status = "cancelled"; mocks.read = sale();
    expect((await POST(request("PAYMENT.SALE.COMPLETED", { id: "SALE-1", billing_agreement_id: "SUB-1" }))).status).toBe(200);
    expect(w().subscriptions[0].status).toBe("cancelled"); expect(w().donations).toHaveLength(1);
    expect(reads()[0][1].method).toBe("GET"); // no restart/new billing action
  });
  it.each(["PENDING", "FAILED", "COMPLETED"])("handles donation refund %s truthfully", async status => {
    const d = gift(); d.status = "refund_pending"; d.refundId = "REFUND-1";
    mocks.read = { id: "REFUND-1", status, amount: { currency_code: "USD", value: "25.00" } };
    expect((await POST(request("PAYMENT.REFUND.COMPLETED", { id: "REFUND-1" }))).status).toBe(200);
    expect(w().donations[0].refundStatus).toBe(status.toLowerCase());
    expect(w().donations[0].status).toBe(status === "COMPLETED" ? "refunded" : "refund_pending");
    expect(w().ledger.filter(e => e.kind === "donation_refund")).toHaveLength(status === "COMPLETED" ? 1 : 0);
  });
  it("rejects refund readback ID mismatch, preserving original resource", async () => {
    const d = gift(); d.status = "refund_pending"; d.refundId = "REFUND-1";
    mocks.read = { id: "OTHER", status: "COMPLETED", amount: { currency_code: "USD", value: "25.00" } };
    await rejected(request("PAYMENT.REFUND.COMPLETED", { id: "REFUND-1" }));
  });
  it("refunds a monthly receipt only against its original sale", async () => {
    const d = gift(); d.status = "refund_pending"; d.refundId = "REFUND-1"; d.subscriptionId = "subscription"; d.captureId = "SALE-1";
    mocks.read = { id: "REFUND-1", state: "completed", sale_id: "OTHER", amount: { currency: "USD", total: "25.00" } };
    await rejected(request("PAYMENT.SALE.REFUNDED", { id: "REFUND-1" }), "MERCHANT");
    mocks.read.sale_id = "SALE-1";
    expect((await POST(request("PAYMENT.SALE.REFUNDED", { id: "REFUND-1" }))).status).toBe(200);
    expect(w().ledger.filter(e => e.kind === "donation_refund")).toHaveLength(1);
    expect(reads().at(-1)![0]).toContain("/v1/payments/refund/REFUND-1");
  });
  it("does not infer an externally initiated refund owner", async () => {
    await rejected(request("PAYMENT.REFUND.COMPLETED", { id: "UNKNOWN" }), "EVENT_OWNER"); expect(reads()).toHaveLength(0);
  });
  it.each(["PENDING", "FAILED"])("does not regress a confirmed refund on older %s readback", async status => {
    const d = gift(); d.status = "refund_pending"; d.refundId = "REFUND-1";
    mocks.read = { id: "REFUND-1", status: "COMPLETED", amount: { currency_code: "USD", value: "25.00" } };
    expect((await POST(request("PAYMENT.REFUND.COMPLETED", { id: "REFUND-1" }))).status).toBe(200);
    const ledger = structuredClone(w().ledger); mocks.read.status = status;
    expect((await POST(request("PAYMENT.REFUND.PENDING", { id: "REFUND-1" }, "EVENT-2"))).status).toBe(200);
    expect(w().donations[0]).toMatchObject({ status: "refunded", refundStatus: "completed", refundId: "REFUND-1" });
    expect(w().ledger).toEqual(ledger);
  });
  it.each(["PENDING", "FAILED", "COMPLETED"])("handles original supplier recovery %s with merchant isolation", async status => {
    w().orders.push({ id: "original-order", organizationId: "hope", proposalId: "p", approvalId: "a",
      fundId: "hope-kits", supplierId: "harvest", siteId: "hope-main", lines: [], total: 2500,
      cancelledAmount: 2500, status: "cancelled", evidence: "paypal_sandbox", captureId: "original-capture", createdAt: w().createdAt });
    w().recoveries.push({ id: "recovery", organizationId: "hope", orderId: "original-order", amount: 2500,
      reason: "short delivery", status: "refund_pending", refundId: "REFUND-1", createdAt: w().createdAt });
    mocks.read = { id: "REFUND-1", status, amount: { currency_code: "USD", value: "25.00" } };
    await rejected(request("PAYMENT.REFUND.COMPLETED", { id: "REFUND-1" }), "MERCHANT");
    expect((await POST(request("PAYMENT.REFUND.COMPLETED", { id: "REFUND-1" }, "EVENT-1", "harvest"))).status).toBe(200);
    expect(w().recoveries[0].status).toBe(status === "COMPLETED" ? "refund_confirmed" : status === "FAILED" ? "refund_failed" : "refund_pending");
    expect(w().ledger.filter(e => e.kind === "purchase_refund")).toHaveLength(status === "COMPLETED" ? 1 : 0);
  });
  it("settles capture once under concurrent duplicate callbacks", async () => {
    gift(); mocks.read = capture();
    const results = await Promise.all([POST(request("PAYMENT.CAPTURE.COMPLETED", captureResource)), POST(request("PAYMENT.CAPTURE.COMPLETED", captureResource))]);
    expect(results.map(r => r.status)).toEqual([200, 200]);
    expect(w().donations[0]).toMatchObject({ status: "confirmed", net: 2381 });
    expect(w().ledger.filter(e => e.subjectId === "gift")).toHaveLength(1); expect(reads()).toHaveLength(1);
  });
  it.each(["id", "payee", "amount", "custom_id"])("rejects capture %s mismatch", async field => {
    gift(); const read = capture();
    if (field === "id") read.id = "OTHER";
    if (field === "payee") read.purchase_units[0].payee.merchant_id = "OTHER";
    if (field === "amount") read.purchase_units[0].amount.value = "26.00";
    if (field === "custom_id") read.purchase_units[0].custom_id = "OTHER";
    mocks.read = read; await rejected(request("PAYMENT.CAPTURE.COMPLETED", captureResource));
  });
  it("rejects event capture ID mismatching the order readback", async () => {
    gift(); mocks.read = capture(); await rejected(request("PAYMENT.CAPTURE.COMPLETED", { ...captureResource, id: "OTHER" }));
  });
  it("rejects fractional-cent capture net rather than rounding", async () => {
    gift(); const read = capture(); read.purchase_units[0].payments.captures[0].seller_receivable_breakdown.net_amount.value = "23.811";
    mocks.read = read; await rejected(request("PAYMENT.CAPTURE.COMPLETED", captureResource));
  });
  it.each(["id", "amount", "status"])("rejects reversal readback %s mismatch", async field => {
    const d = gift(); d.status = "confirmed"; d.captureId = "CAPTURE-1"; d.net = 2381;
    mocks.read = { id: "CAPTURE-1", status: "REVERSED", amount: { currency_code: "USD", value: "25.00" },
      [field]: field === "amount" ? { currency_code: "EUR", value: "25.00" } : "OTHER" };
    await rejected(request("PAYMENT.CAPTURE.REVERSED", captureResource));
  });
  it("posts a confirmed reversal once across different event IDs", async () => {
    const d = gift(); d.status = "confirmed"; d.captureId = "CAPTURE-1"; d.net = 2381;
    mocks.read = { id: "CAPTURE-1", status: "REVERSED", amount: { currency_code: "USD", value: "25.00" } };
    for (const id of ["EVENT-1", "EVENT-2"]) expect((await POST(request("PAYMENT.CAPTURE.REVERSED", captureResource, id))).status).toBe(200);
    expect(w().ledger.filter(e => e.kind === "reversal").map(e => e.amount)).toEqual([-2381]);
  });
  it.each(["provider", "persistence"])("rolls back %s failure and safely accepts a later retry", async failure => {
    subscription(); mocks.read = sale(); mocks.saveFails = failure === "persistence";
    if (failure === "provider") mocks.fetch.mockImplementationOnce(async () => { throw new Error("fixture timeout private details"); });
    const req = () => request("PAYMENT.SALE.COMPLETED", { id: "SALE-1", billing_agreement_id: "SUB-1" });
    await rejected(req(), "UNAVAILABLE"); mocks.saveFails = false;
    expect((await POST(req())).status).toBe(200); expect(w().donations).toHaveLength(1);
  });
  it("rolls back a resource GET timeout after successful signature verification", async () => {
    subscription(); const req = () => request("PAYMENT.SALE.COMPLETED", { id: "SALE-1", billing_agreement_id: "SUB-1" });
    mocks.fetch.mockImplementation(async (url: string) => {
      if (url.endsWith("/token")) return Response.json({ access_token: "fixture-token" });
      if (url.endsWith("verify-webhook-signature")) return Response.json({ verification_status: "SUCCESS" });
      throw new Error("fixture GET timeout private details");
    });
    await rejected(req(), "UNAVAILABLE"); expect(mocks.mutate).toHaveBeenCalledTimes(1);
    mocks.fetch.mockImplementation(async (url: string) => Response.json(url.endsWith("/token")
      ? { access_token: "fixture-token" } : url.endsWith("verify-webhook-signature")
        ? { verification_status: "SUCCESS" } : sale()));
    expect((await POST(req())).status).toBe(200); expect(w().donations).toHaveLength(1);
    expect(w().providerEvents).toHaveLength(1);
  });
  it.each(["id", "event_type"])("rejects empty event %s before signature verification", async field => {
    const req = request("UNSUPPORTED.EVENT", {});
    const data = JSON.parse(await req.text()); data[field] = "";
    await rejected(new Request(req.url, { method: "POST", headers: signature, body: JSON.stringify(data) }), "INPUT");
    expect(mocks.fetch).not.toHaveBeenCalled(); expect(mocks.mutate).not.toHaveBeenCalled();
  });
  it.each(["not-json", "x".repeat(65537)])("rejects malformed or oversized body before HTTP", async value => {
    const req = request("UNSUPPORTED.EVENT", {});
    await rejected(new Request(req.url, { method: "POST", headers: signature, body: value }));
    expect(mocks.fetch).not.toHaveBeenCalled(); expect(mocks.mutate).not.toHaveBeenCalled();
  });
  it("rejects invalid workspace UUID before HTTP", async () => {
    const req = request("UNSUPPORTED.EVENT", {});
    await rejected(new Request(req.url.replace(workspaceId, "invalid"), { method: "POST", headers: signature, body: await req.text() }), "INPUT");
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it("keeps a pending capture out of confirmed funds and the event journal", async () => {
    gift(); const read = capture(); read.purchase_units[0].payments.captures[0].status = "PENDING";
    mocks.read = read; await rejected(request("PAYMENT.CAPTURE.COMPLETED", captureResource), "PAYMENT_PENDING");
  });
  it.each(["currency", "amount"])("rejects refund %s mismatch", async field => {
    const d = gift(); d.status = "refund_pending"; d.refundId = "REFUND-1";
    mocks.read = { id: "REFUND-1", status: "COMPLETED", amount: {
      currency_code: field === "currency" ? "EUR" : "USD", value: field === "amount" ? "24.00" : "25.00" } };
    await rejected(request("PAYMENT.REFUND.COMPLETED", { id: "REFUND-1" }), "PROVIDER_AMOUNT");
  });
});
