import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/reconcile/route";
import { seedWorkspace } from "@/lib/seed";
import { AppError } from "@/lib/errors";
import type { Donation, Order, Workspace } from "@/lib/types";

// Full POST -> paymentAction -> settlement/ledger; only DB transport and PayPal
// transport are fixtures. Never use real credentials or send network requests.
const mocks = vi.hoisted(() => ({
  query: vi.fn(), mutate: vi.fn(), paypal: vi.fn(),
  rows: new Map<string, Workspace>(), orders: [] as string[],
}));
vi.mock("@/lib/auth", () => ({ serviceClient: () => ({ from: mocks.query }) }));
vi.mock("@/lib/storage", () => ({ withWorkspace: mocks.mutate }));
vi.mock("@/lib/paypal", async (original) => ({
  ...(await original<typeof import("@/lib/paypal")>()), paypal: mocks.paypal,
}));
const token = "fixture-reconcile-token-32-characters-only";
const request = (authorization: string | null = `Bearer ${token}`) =>
  new Request("http://127.0.0.1:3101/api/reconcile", {
    method: "POST", headers: authorization === null ? {} : { authorization },
  });
async function run() {
  const response = await POST(request());
  expect(response.status).toBe(200);
  return response.json();
}
function workspace(id = "workspace-001") {
  const w = seedWorkspace(id);
  mocks.rows.set(id, w);
  return w;
}
function donation(w: Workspace, id = "donation-001"): Donation {
  const d: Donation = {
    id, organizationId: "hope", donorId: "donor", campaignId: "campaign-hope",
    fundId: "hope-kits", amount: 2500, status: "awaiting_payer",
    providerId: `ORDER-${id}`, evidence: "paypal_sandbox", createdAt: w.createdAt,
  };
  w.donations.push(d);
  return d;
}
function capture(w: Workspace, d: Donation) {
  return {
    id: d.providerId, status: "COMPLETED", purchase_units: [{
      custom_id: `${w.id}:${d.id}`, payee: { merchant_id: "merchant-hope" },
      amount: { currency_code: "USD", value: "25.00" },
      payments: { captures: [{ id: `CAPTURE-${d.id}`, status: "COMPLETED",
        amount: { currency_code: "USD", value: "25.00" },
        seller_receivable_breakdown: { net_amount: { currency_code: "USD", value: "23.81" } },
      }] },
    }],
  };
}
function recovery(w: Workspace) {
  const o: Order = { id: "original-order", organizationId: "hope", proposalId: "p",
    approvalId: "a", fundId: "hope-kits", supplierId: "harvest", siteId: "hope-main",
    lines: [], total: 2500, cancelledAmount: 2500, status: "cancelled",
    evidence: "paypal_sandbox", captureId: "original-capture", createdAt: w.createdAt };
  w.orders.push(o);
  const r = { id: "recovery-001", organizationId: "hope", orderId: o.id,
    amount: 2500, reason: "short delivery", status: "refund_pending" as const,
    refundId: "REFUND-001", createdAt: w.createdAt };
  w.recoveries.push(r);
  return r;
}
beforeEach(() => {
  vi.stubEnv("APP_ENV", "local"); vi.stubEnv("VERCEL", "");
  vi.stubEnv("STORAGE_MODE", "local"); vi.stubEnv("PAYMENTS_MODE", "sandbox");
  vi.stubEnv("PROVIDER_ACTIONS_ENABLED", "true");
  vi.stubEnv("RECONCILE_TOKEN", token);
  vi.stubEnv("PAYPAL_MERCHANTS_JSON", JSON.stringify({
    hope: { clientId: "fixture", secret: "fixture", merchantId: "merchant-hope" },
    harvest: { clientId: "fixture", secret: "fixture", merchantId: "merchant-harvest" },
  }));
  mocks.rows.clear(); mocks.orders.length = 0;
  mocks.query.mockReset(); mocks.mutate.mockReset(); mocks.paypal.mockReset();
  mocks.query.mockImplementation(() => {
    const ordering: string[] = [];
    let ascending = true;
    const builder = {
      select: vi.fn(() => builder),
      order: vi.fn((column: string, options?: { ascending: boolean }) => {
        ordering.push(column); mocks.orders.push(column);
        if (column !== "id") ascending = options?.ascending !== false;
        return builder;
      }),
      limit: vi.fn(async (limit: number) => {
        let rows = [...mocks.rows.values()];
        if (ordering.length) rows = rows.sort((a, b) => {
          const aTime = (a as Workspace & { reconcileScannedAt?: string }).reconcileScannedAt || "";
          const bTime = (b as Workspace & { reconcileScannedAt?: string }).reconcileScannedAt || "";
          return (ascending ? 1 : -1) * aTime.localeCompare(bTime) || a.id.localeCompare(b.id);
        });
        return { data: rows.slice(0, limit).map(w => ({ id: w.id, payload: structuredClone(w),
          reconcileScannedAt: w.reconcileScannedAt ?? null })), error: null };
      }),
    };
    return builder;
  });
  // Persist detached snapshots, like a DB lease. A thrown callback rolls back.
  let queue = Promise.resolve();
  mocks.mutate.mockImplementation((id: string, callback: (w: Workspace) => unknown) => {
    const operation = queue.catch(() => undefined).then(async () => {
      const state = structuredClone(mocks.rows.get(id)!);
      const result = await callback(state);
      mocks.rows.set(id, state);
      return result;
    });
    queue = operation.then(() => undefined, () => undefined);
    return operation;
  });
  mocks.paypal.mockRejectedValue(new Error("fixture-provider-timeout-private-detail"));
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("full reconciliation route, mocked transports only", () => {
  it.each([null, "", "Bearer wrong", token, `Basic ${token}`, `Bearer ${token}x`])(
    "rejects missing, malformed or wrong authorization (%s)", async authorization => {
      const response = await POST(request(authorization));
      expect(response.status).toBe(401);
      expect(mocks.query).not.toHaveBeenCalled();
      expect(mocks.mutate).not.toHaveBeenCalled(); expect(mocks.paypal).not.toHaveBeenCalled();
    });
  it.each(["", "short"])("fails closed for unconfigured job (%s)", async value => {
    vi.stubEnv("RECONCILE_TOKEN", value);
    expect((await POST(request())).status).toBe(503);
    expect(mocks.query).not.toHaveBeenCalled();
  });
  it("returns an empty, scoped batch without provider calls", async () => {
    const result = await run();
    expect(result).toMatchObject({ examined: 0, remaining: 0, remainingScope: "selected_workspace", results: [] });
    expect(mocks.paypal).not.toHaveBeenCalled();
  });
  it.each(["PENDING", "FAILED", "COMPLETED"])("reports supplier refund %s truthfully", async status => {
    const w = workspace(); const r = recovery(w);
    mocks.paypal.mockResolvedValue({ id: r.refundId, status, amount: { currency_code: "USD", value: "25.00" } });
    const result = await run();
    expect(result.results[0]).toMatchObject({ id: r.id, readback: "completed",
      status: status === "PENDING" ? "pending" : status === "FAILED" ? "failed" : "confirmed",
      domainStatus: status === "PENDING" ? "refund_pending" : status === "FAILED" ? "refund_failed" : "refund_confirmed" });
    expect(mocks.rows.get(w.id)!.ledger.filter(l => l.kind === "purchase_refund")).toHaveLength(status === "COMPLETED" ? 1 : 0);
    expect(mocks.paypal.mock.calls[0].slice(0, 2)).toEqual(["harvest", `/v2/payments/refunds/${r.refundId}`]);
    expect(mocks.paypal.mock.calls[0][2]).toBeUndefined(); // defaults GET, never refund POST
  });
  it.each(["PENDING", "FAILED", "COMPLETED"])("reports donation refund %s without inventing money", async status => {
    const w = workspace(); const d = donation(w); d.status = "refund_pending"; d.refundId = "REFUND-D";
    mocks.paypal.mockResolvedValue({ id: d.refundId, status, amount: { currency_code: "USD", value: "25.00" } });
    const result = await run();
    expect(result.results[0].status).toBe(status === "PENDING" ? "pending" : status === "FAILED" ? "failed" : "confirmed");
    expect(mocks.rows.get(w.id)!.ledger.filter(l => l.kind === "donation_refund")).toHaveLength(status === "COMPLETED" ? 1 : 0);
  });
  it.each(["ACTIVE", "CANCELLED", "SUSPENDED", "APPROVAL_PENDING"])("reports subscription %s separately from receipts", async status => {
    const w = workspace();
    w.subscriptions.push({ id: "subscription", organizationId: "hope", donorId: "donor", campaignId: "campaign-hope",
      amount: 2500, status: "awaiting_payer", providerId: "SUB-001", evidence: "paypal_sandbox", createdAt: w.createdAt });
    const originalLedger = structuredClone(w.ledger);
    mocks.paypal.mockResolvedValue({ id: "SUB-001", custom_id: `${w.id}:subscription`, status });
    const result = await run();
    expect(result.results[0]).toMatchObject({ readback: "completed", status: status === "APPROVAL_PENDING" ? "pending" : status.toLowerCase() });
    expect(mocks.rows.get(w.id)!.ledger).toEqual(originalLedger);
  });
  it("credits a verified capture once, excludes it on a retry, and reads only", async () => {
    const w = workspace(); const d = donation(w);
    mocks.paypal.mockResolvedValue(capture(w, d));
    expect((await run()).results[0]).toMatchObject({ status: "confirmed", domainStatus: "confirmed" });
    expect((await run()).examined).toBe(0);
    expect(mocks.rows.get(w.id)!.ledger.filter(l => l.subjectId === d.id)).toHaveLength(1);
    expect(mocks.paypal).toHaveBeenCalledTimes(1);
    expect(mocks.paypal.mock.calls[0][2]).toBeUndefined();
  });
  it("labels pending capture as pending despite a successful GET", async () => {
    const w = workspace(); const d = donation(w); const response = capture(w, d);
    response.purchase_units[0].payments.captures[0].status = "PENDING";
    mocks.paypal.mockResolvedValue(response);
    const result = await run();
    expect(result.results[0].status).toBe("pending");
    expect(mocks.rows.get(w.id)!.ledger.filter(l => l.subjectId === d.id)).toHaveLength(0);
  });
  it("rotates nine persistent failures across restarts rather than retrying the first four", async () => {
    const w = workspace(); for (let i = 0; i < 9; i++) donation(w, `donation-${i}`);
    const first = await run(); expect(first.examined).toBe(4); expect(first.remaining).toBe(5);
    // Route reload loses process state; only stored aggregate progress may survive.
    vi.resetModules(); const reloaded = (await import("@/app/api/reconcile/route")).POST;
    const second = await (await reloaded(request())).json(); const third = await run();
    const ids = [...first.results, ...second.results, ...third.results].map(r => r.id);
    expect(new Set(ids).size).toBe(9);
    expect(second.results.map((r: {id: string}) => r.id)).not.toEqual(first.results.map((r: {id: string}) => r.id));
    expect(JSON.stringify(third)).not.toContain("fixture-provider-timeout-private-detail");
  });
  it("visits 105 workspaces with empty and unresolved prefixes", async () => {
    for (let i = 0; i < 105; i++) {
      const w = workspace(`workspace-${String(i).padStart(3, "0")}`);
      if (i % 2 || i === 104) donation(w);
    }
    let result;
    for (let i = 0; i < 105; i++) { result = await run(); expect(result.examined).toBeLessThanOrEqual(4); }
    expect(result.workspaceId).toBe("workspace-104");
    expect(mocks.orders).toContain("payload->>reconcileScannedAt");
    expect(mocks.paypal).toHaveBeenCalledTimes(53);
  });
  it("does not skip undispatched candidates when the time budget expires", async () => {
    const w = workspace(); for (let i = 0; i < 6; i++) donation(w, `donation-${i}`);
    let now = 1800000000000; vi.spyOn(Date, "now").mockImplementation(() => now);
    mocks.paypal.mockImplementation(async () => { now += 26000; throw new Error("timeout"); });
    const first = await run(); expect(first.examined).toBe(1); expect(first.remaining).toBe(5);
    const second = await run(); expect(second.results[0].id).toBe("donation-1");
  });
  it("does not call a provider if saving dispatch progress fails", async () => {
    donation(workspace()); mocks.mutate.mockRejectedValueOnce(new AppError("PERSISTENCE", "save failed", 503));
    expect((await POST(request())).status).toBe(503); expect(mocks.paypal).not.toHaveBeenCalled();
  });
  it("fails closed on workspace read errors", async () => {
    mocks.query.mockImplementation(() => {
      const b = { select: () => b, order: () => b, limit: async () => ({ data: null, error: { message: "private-db-detail" } }) };
      return b;
    });
    const response = await POST(request()); expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private-db-detail"); expect(mocks.paypal).not.toHaveBeenCalled();
  });
  it("surfaces missing staff instead of silently losing the payment", async () => {
    const w = workspace(); donation(w); w.actors = w.actors.filter(a => !["owner", "finance"].includes(a.role));
    expect((await run()).results[0]).toMatchObject({ status: "needs_review", reason: "actor_unavailable" });
    expect(mocks.paypal).not.toHaveBeenCalled();
  });
  it("rejects a supplier-like actor without the supplier role", async () => {
    const w = workspace(); recovery(w); w.actors = w.actors.filter(a => a.id !== "supplier-a");
    w.actors.find(a => a.id === "coordinator-a")!.supplierId = "harvest";
    expect((await run()).results[0].status).toBe("needs_review"); expect(mocks.paypal).not.toHaveBeenCalled();
  });
  it("revoked finance access during readback cannot commit money", async () => {
    const w = workspace(); const d = donation(w);
    mocks.paypal.mockImplementation(async () => {
      mocks.rows.get(w.id)!.actors = mocks.rows.get(w.id)!.actors.filter(a => a.id !== "owner-a");
      return capture(w, d);
    });
    expect((await run()).results[0].status).toBe("needs_review");
    expect(mocks.rows.get(w.id)!.ledger.filter(l => l.subjectId === d.id)).toHaveLength(0);
  });
  it.each(["merchant", "amount", "resource"])("rejects a capture with wrong %s", async mismatch => {
    const w = workspace(); const d = donation(w); const response = capture(w, d);
    if (mismatch === "merchant") response.purchase_units[0].payee.merchant_id = "other-merchant";
    if (mismatch === "amount") response.purchase_units[0].payments.captures[0].amount.value = "24.00";
    if (mismatch === "resource") response.id = "OTHER-ORDER";
    mocks.paypal.mockResolvedValue(response);
    expect((await run()).results[0].status).toBe("needs_review");
    expect(mocks.rows.get(w.id)!.ledger.filter(l => l.subjectId === d.id)).toHaveLength(0);
  });
  it("rejects a different refund resource even with matching amount", async () => {
    const w = workspace(); recovery(w);
    mocks.paypal.mockResolvedValue({ id: "OTHER-REFUND", status: "COMPLETED", amount: { currency_code: "USD", value: "25.00" } });
    expect((await run()).results[0].status).toBe("needs_review");
    expect(mocks.rows.get(w.id)!.ledger.filter(l => l.kind === "purchase_refund")).toHaveLength(0);
  });
  it("readback continues while new financial actions are paused", async () => {
    vi.stubEnv("FINANCIAL_ACTIONS_ENABLED", "false");
    const w = workspace(); const d = donation(w); mocks.paypal.mockResolvedValue(capture(w, d));
    expect((await run()).results[0].status).toBe("confirmed");
  });
  it.each(["resource", "ownership"])("rejects subscription with wrong %s", async mismatch => {
    const w = workspace();
    w.subscriptions.push({ id: "subscription", organizationId: "hope", donorId: "donor", campaignId: "campaign-hope",
      amount: 2500, status: "awaiting_payer", providerId: "SUB-001", evidence: "paypal_sandbox", createdAt: w.createdAt });
    mocks.paypal.mockResolvedValue({ id: mismatch === "resource" ? "OTHER-SUB" : "SUB-001",
      custom_id: mismatch === "ownership" ? "other-workspace:subscription" : `${w.id}:subscription`, status: "ACTIVE" });
    expect((await run()).results[0].status).toBe("needs_review");
    expect(mocks.rows.get(w.id)!.subscriptions[0].status).toBe("awaiting_payer");
  });
  it("reconciles a monthly receipt refund through the sale API", async () => {
    const w = workspace(); const d = donation(w); d.status = "refund_pending";
    d.subscriptionId = "monthly"; d.captureId = "SALE-001"; d.refundId = "SALE-REFUND";
    mocks.paypal.mockResolvedValue({ id: d.refundId, sale_id: d.captureId,
      state: "completed", amount: { currency: "USD", total: "25.00" } });
    expect((await run()).results[0].status).toBe("confirmed");
    expect(mocks.paypal.mock.calls[0].slice(0, 2)).toEqual(["hope", "/v1/payments/refund/SALE-REFUND"]);
    expect(mocks.rows.get(w.id)!.ledger.filter(l => l.kind === "donation_refund")).toHaveLength(1);
  });
  it("two overlapping jobs cannot double-credit the same capture", async () => {
    const w = workspace(); const d = donation(w); mocks.paypal.mockResolvedValue(capture(w, d));
    const results = await Promise.all([run(), run()]);
    expect(results.flatMap(r => r.results).every(r => r.status === "confirmed")).toBe(true);
    expect(mocks.rows.get(w.id)!.ledger.filter(l => l.subjectId === d.id)).toHaveLength(1);
    expect(mocks.paypal.mock.calls.every(c => c[2] === undefined)).toBe(true);
  });
  it("scan ordering advances even with a fixed or backwards clock", async () => {
    const a = workspace("workspace-a"), b = workspace("workspace-b");
    const previous = "2030-01-01T00:00:00.000Z";
    a.reconcileScannedAt = previous; b.reconcileScannedAt = previous;
    vi.spyOn(Date, "now").mockReturnValue(1800000000000);
    expect((await run()).workspaceId).toBe(a.id);
    expect((await run()).workspaceId).toBe(b.id);
    expect(Date.parse(mocks.rows.get(a.id)!.reconcileScannedAt!)).toBeGreaterThan(Date.parse(previous));
  });
  it("mixed future and current scan times cannot starve the future workspace", async () => {
    const a = workspace("workspace-a"), b = workspace("workspace-b");
    a.reconcileScannedAt = "2026-01-01T00:00:00.000Z";
    b.reconcileScannedAt = "2030-01-01T00:00:00.000Z";
    vi.spyOn(Date, "now").mockReturnValue(1800000000000);
    expect((await run()).workspaceId).toBe(a.id);
    expect((await run()).workspaceId).toBe(b.id);
  });
  it("rejects identity corruption before dispatch and fails safely", async () => {
    const w = workspace(); donation(w);
    mocks.mutate.mockImplementation(async (_id, callback) => callback({ ...w, id: "other-workspace" }));
    expect((await POST(request())).status).toBe(503); expect(mocks.paypal).not.toHaveBeenCalled();
  });
  it("ignores request body attempts to select a tenant or financial action", async () => {
    const w = workspace(); donation(w);
    const response = await POST(new Request("http://127.0.0.1:3101/api/reconcile", { method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: "other-workspace", action: "refund", cursor: "forged" }) }));
    expect(response.status).toBe(200); expect((await response.json()).workspaceId).toBe(w.id);
    expect(mocks.paypal.mock.calls.every(c => c[2] === undefined)).toBe(true);
  });
  it("does not blind-retry financial operations after provider timeout", async () => {
    const w = workspace(); const d = donation(w);
    await run(); await run();
    expect(mocks.rows.get(w.id)!.paymentOperations.every(o => o.action === "reconcile" && o.status === "uncertain")).toBe(true);
    expect(mocks.paypal.mock.calls.every(c => c[1] === `/v2/checkout/orders/${d.providerId}` && c[2] === undefined)).toBe(true);
    expect(mocks.rows.get(w.id)!.ledger.filter(l => l.subjectId === d.id)).toHaveLength(0);
  });
});

it("settles completed capture after failed retirement instead of repeating uncaptured validation",async()=>{
  const w=workspace(),d=donation(w);w.paymentOperations.push({id:"cancel-fixture",subjectId:d.id,action:"cancel",profile:"hope",requestId:"cancel-request",status:"uncertain",createdAt:w.createdAt});
  mocks.paypal.mockResolvedValue(capture(w,d));const result=await run();expect(result.results[0]).toMatchObject({status:"confirmed",domainStatus:"confirmed"});expect(mocks.rows.get(w.id)!.paymentOperations.find(o=>o.id==="cancel-fixture")?.status).toBe("failed");expect(mocks.rows.get(w.id)!.ledger.filter(l=>l.subjectId===d.id)).toHaveLength(1);expect((await run()).examined).toBe(0);expect(mocks.paypal.mock.calls.every(c=>c[2]===undefined)).toBe(true);
});
