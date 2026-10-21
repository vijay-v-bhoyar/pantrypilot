import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { seedWorkspace } from "@/lib/seed";
import { execute, post, view } from "@/lib/commands";
import { balances, cents } from "@/lib/money";
import { kitReadiness, plan } from "@/lib/planner";
import { previewInventoryCsv } from "@/lib/csv";
import { configuration } from "@/lib/config";
import { dashboardState, studioStateSchema } from "@/lib/dashboard";
import type {
  Approval,
  Donation,
  Order,
  Proposal,
  PurchaseRequest,
  Recovery,
  Subscription,
  Workspace,
} from "@/lib/types";
let w: Workspace;
const command = <T>(
  name: string,
  data: unknown,
  actor = "owner-a",
  key = randomUUID(),
) => execute(w, actor, name, data, key) as T;
function request(overrides: Partial<PurchaseRequest> = {}) {
  return command<PurchaseRequest>("request", {
    siteId: "hope-main",
    kitId: "kit-hope",
    fundId: "hope-kits",
    target: 50,
    budget: 60000,
    deadline: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10),
    notes: "",
    ...overrides,
  });
}
function purchase() {
  const r = request();
  const p = command<Proposal>("propose", { id: r.id });
  const a = command<Approval>("approve", { id: p.id });
  return { r, p, a, orders: command<Order[]>("checkout", { id: a.id }) };
}
beforeEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.stubEnv("PAYMENTS_MODE", "simulation");
  vi.stubEnv("APP_ENV", "local");
  vi.stubEnv("STORAGE_MODE", "local");
  vi.stubEnv("FINANCIAL_ACTIONS_ENABLED", "true");
  w = seedWorkspace(randomUUID());
});
describe("authority and isolation", () => {
  it("registers suppliers with unique server profiles and scoped invitations", () => {
    const s = command<{ id: string; merchantProfile: string }>("supplier", {
      name: "Third supplier",
      shipping: 100,
    });
    expect(s.merchantProfile).toBe(`sup-${s.id}`);
    command("invite", { role: "supplier", supplierId: s.id });
    expect(w.invitations.at(-1)?.supplierId).toBe(s.id);
    expect(() =>
      command("invite", { role: "supplier", supplierId: s.id }, "owner-b"),
    ).toThrow("approved supplier");
    expect(() => command("invite", { role: "supplier" })).toThrow(
      "approved supplier",
    );
    expect(() =>
      command("supplier", { name: "Forbidden", shipping: 0 }, "coordinator-a"),
    ).toThrow("role");
  });
  it("allows only supplier representatives to add merchant offers", () => {
    const offer = {
      sku: "lentils",
      name: "Lentils",
      unit: "bags",
      packSize: 10,
      price: 1200,
      availablePacks: 8,
      deliveryDays: 2,
      attributes: ["shelf-stable"],
    };
    expect(() => command("catalogCreate", offer)).toThrow("role");
    command("catalogCreate", offer, "supplier-a");
    expect(w.catalog.at(-1)?.supplierId).toBe("harvest");
    expect(w.catalog.at(-1)?.provenance).toBe("merchant");
    expect(() => command("catalogCreate", offer, "supplier-a")).toThrow(
      "existing offer",
    );
    command("revoke", { id: "supplier-a" });
    expect(() =>
      command("catalogCreate", { ...offer, sku: "other" }, "supplier-a"),
    ).toThrow("membership");
  });
  it("invalidates approval after the approving member is revoked", () => {
    const r = request();
    const p = command<Proposal>("propose", { id: r.id });
    const a = command<Approval>("approve", { id: p.id }, "finance-a");
    command("revoke", { id: "finance-a" });
    expect(() => command("checkout", { id: a.id })).toThrow("membership");
    expect(w.orders).toEqual([]);
  });
  it("refunds the full cancelled order including shipping, and waits for other receipts before replacement", () => {
    const { orders } = purchase();
    for (const o of orders) command("capture", { id: o.id });
    const o = orders.find((o) => o.supplierId === "harvest")!;
    const before = balances(w, "hope-kits").posted;
    const r = command<Recovery>(
      "cancelOrder",
      { id: o.id, reason: "All supplies unavailable" },
      "supplier-a",
    );
    expect(r.amount).toBe(o.total);
    expect(o.lines.every((l) => l.units === 0)).toBe(true);
    command("requestRefund", { id: r.id });
    command("confirmRefund", { id: r.id }, "supplier-a");
    expect(balances(w, "hope-kits").posted).toBe(before + o.total);
    expect(() => command("replacement", { id: r.id })).toThrow(
      "remaining shipment",
    );
    const other = orders.find((order) => order.id !== o.id)!;
    command("fulfill", { id: other.id, status: "fulfilled" }, "supplier-b");
    command("receive", { id: other.id });
    expect(
      command<Proposal>("replacement", { id: r.id }).lines.every(
        (l) => l.supplierId === "supply",
      ),
    ).toBe(true);
  });
  it("denies a coordinator approving money", () => {
    const p = plan(w, request());
    w.proposals.push(p);
    expect(() => command("approve", { id: p.id }, "coordinator-a")).toThrow(
      "role",
    );
  });
  it("denies another nonprofit reading or modifying a request", () => {
    const r = request();
    expect(() => command("propose", { id: r.id }, "owner-b")).toThrow(
      "not found",
    );
    expect(view(w, "owner-b").requests).toEqual([]);
  });
  it("denies another supplier modifying the merchant catalogue", () =>
    expect(() =>
      command(
        "catalog",
        { id: "harvest-rice", price: 1, availablePacks: 1, deliveryDays: 1 },
        "supplier-b",
      ),
    ).toThrow("another supplier"));
  it("denies browser-injected actor fields", () =>
    expect(() =>
      command("request", { ...request(), actorId: "finance-a" }),
    ).toThrow());
  it("excludes staff identities, ledger and other donors from donor views", () => {
    w.actors.push({
      id: "donor-2",
      name: "Private name",
      role: "donor",
      organizationId: "hope",
    });
    command(
      "donation",
      { campaignId: "campaign-hope", amount: 2500 },
      "donor-2",
    );
    const v = view(w, "donor");
    expect(v.donations).toEqual([]);
    expect(v.ledger).toEqual([]);
    expect(v.audit).toEqual([]);
    expect(v.actors.map((a) => a.id)).toEqual(["donor"]);
    expect(JSON.stringify(v)).not.toContain("Private name");
  });
  it("denies a supplier issuing another merchant refund", () => {
    const { orders } = purchase();
    const o = orders.find((o) => o.supplierId === "harvest")!;
    command("capture", { id: o.id });
    const r = command<Recovery>(
      "partialCancel",
      {
        id: o.id,
        catalogId: o.lines[0].catalogId,
        packs: 1,
        reason: "shortage",
      },
      "supplier-a",
    );
    command("requestRefund", { id: r.id });
    expect(() => command("confirmRefund", { id: r.id }, "supplier-b")).toThrow(
      "another supplier",
    );
  });
  it("revocation removes access to the next command", () => {
    command("revoke", { id: "coordinator-a" });
    expect(() => view(w, "coordinator-a")).toThrow("membership");
  });
  it("protects the last owner and self-assignment", () =>
    expect(() => command("member", { id: "owner-a", role: "finance" })).toThrow(
      "yourself",
    ));
  it("creates expiring hashed invitations without exposing hashes to views", () => {
    const i = command<{ token: string }>("invite", { role: "finance" });
    expect(i.token.length).toBe(48);
    expect(w.invitations[0].tokenHash).not.toBe(i.token);
    expect(JSON.stringify(w)).not.toContain(i.token);
    expect(JSON.stringify(view(w, "owner-a").invitations)).not.toContain(
      "tokenHash",
    );
  });
  it("does not expose another tenant through supplier views", () => {
    const v = view(w, "supplier-a");
    expect(v.organizations.map((o) => o.id)).toEqual(["hope"]);
    expect(v.inventory).toEqual([]);
    expect(v.proposals).toEqual([]);
  });
});
describe("planning and approvals", () => {
  it("includes rounded packs and shipping per supplier", () => {
    const p = plan(w, request());
    // Split packs avoid overbuying rice and beans; shipping is still paid once.
    expect(p.total).toBe(34810);
    expect(p.shipping).toBe(2000);
    expect(p.lines.filter((l) => l.sku === "rice").reduce((n, l) => n + l.units, 0)).toBe(70);
    expect(p.shortages).toEqual([]);
  });
  it("marks an impossible budget without weakening constraints", () => {
    const p = plan(w, request({ budget: 100 }));
    expect(p.shortages.join(" ")).toContain("above");
    w.proposals.push(p);
    expect(() => command("approve", { id: p.id })).toThrow("shortages");
  });
  it("does not use expired stock", () => {
    w.inventory.forEach((l) => (l.expiresAt = "2000-01-01"));
    expect(kitReadiness(w, "hope", "hope-main", "kit-hope")).toBe(0);
    expect(plan(w, request()).total).toBeGreaterThan(35200);
  });
  it("does not infer missing product attributes", () => {
    w.catalog.forEach((c) => (c.attributes = []));
    expect(plan(w, request()).shortages).toHaveLength(4);
  });
  it("rejects unknown model-selected catalog IDs", () =>
    expect(plan(w, request(), ["invented"]).shortages).toHaveLength(4));
  it("makes insufficient catalogue stock explicit", () => {
    w.catalog.forEach((c) => (c.availablePacks = 0));
    expect(plan(w, request()).shortages).toHaveLength(4);
  });
  it("enforces delivery constraints", () => {
    w.catalog.forEach((c) => (c.deliveryDays = 100));
    expect(plan(w, request()).shortages).toHaveLength(4);
  });
  it("invalidates approval after catalog price changes", () => {
    const r = request();
    const p = command<Proposal>("propose", { id: r.id });
    const a = command<Approval>("approve", { id: p.id });
    command(
      "catalog",
      { id: "harvest-rice", price: 1900, availablePacks: 25, deliveryDays: 2 },
      "supplier-a",
    );
    expect(() => command("checkout", { id: a.id })).toThrow("changed");
    expect(balances(w, "hope-kits").reserved).toBe(0);
  });
  it("invalidates approval after stock changes", () => {
    const r = request();
    const p = command<Proposal>("propose", { id: r.id });
    const a = command<Approval>("approve", { id: p.id });
    command("adjust", {
      id: w.inventory[0].id,
      quantity: 2,
      reason: "count correction",
    });
    expect(() => command("checkout", { id: a.id })).toThrow("changed");
  });
  it("expires approval in fifteen minutes", () => {
    const { a } = purchase();
    a.consumed = false;
    a.expiresAt = new Date(Date.now() - 1).toISOString();
    expect(() => command("checkout", { id: a.id })).toThrow("expired");
  });
  it("rejects restricted cross-purpose funds", () => {
    const k = command<{ id: string }>("kit", {
      name: "Other kit",
      components: [
        {
          sku: "rice",
          name: "Rice",
          quantity: 1,
          attributes: ["shelf-stable"],
        },
      ],
    });
    expect(() => request({ kitId: k.id })).toThrow("purpose");
  });
  it("consumes approvals once", () => {
    const { a } = purchase();
    expect(() => command("checkout", { id: a.id })).toThrow("used");
  });
});
describe("money lifecycle", () => {
  it("uses only safe integer cents", () => {
    for (const n of [0, -1, 1.2, Infinity, 10000001])
      expect(() => cents(n)).toThrow();
    expect(cents(25)).toBe(25);
  });
  it("reserves exact funds before capture", () => {
    const { p } = purchase();
    expect(balances(w, "hope-kits")).toEqual({
      posted: 60000,
      reserved: p.total,
      available: 60000 - p.total,
    });
  });
  it("keeps uncertain capture funds reserved", () => {
    const { orders, p } = purchase();
    orders.forEach((o) => (o.status = "uncertain"));
    expect(balances(w, "hope-kits").reserved).toBe(p.total);
  });
  it("moves reservation to spending once confirmed", () => {
    const { orders, p } = purchase();
    orders.forEach((o) => command("capture", { id: o.id }));
    expect(balances(w, "hope-kits")).toEqual({
      posted: 60000 - p.total,
      reserved: 0,
      available: 60000 - p.total,
    });
  });
  it("does not make pending gifts spendable", () => {
    command("donation", { campaignId: "campaign-hope", amount: 2500 }, "donor");
    expect(balances(w, "hope-kits").posted).toBe(60000);
  });
  it("posts confirmed giving exactly once for a replayed operation", () => {
    const d = command<Donation>(
      "donation",
      { campaignId: "campaign-hope", amount: 2500 },
      "donor",
    );
    const key = randomUUID();
    command("capture", { id: d.id }, "donor", key);
    command("capture", { id: d.id }, "donor", key);
    expect(balances(w, "hope-kits").posted).toBe(62500);
    expect(w.ledger.filter((l) => l.subjectId === d.id)).toHaveLength(1);
  });
  it("rejects reused idempotency keys across payloads or actors", () => {
    const key = randomUUID();
    command(
      "donation",
      { campaignId: "campaign-hope", amount: 2500 },
      "donor",
      key,
    );
    expect(() =>
      command(
        "donation",
        { campaignId: "campaign-hope", amount: 3000 },
        "donor",
        key,
      ),
    ).toThrow("another request");
    expect(() =>
      command(
        "campaignStatus",
        { id: "campaign-hope", status: "closed" },
        "owner-a",
        key,
      ),
    ).toThrow("another request");
  });
  it("rejects spending above available funds at checkout", () => {
    const r = request();
    const p = command<Proposal>("propose", { id: r.id });
    const a = command<Approval>("approve", { id: p.id });
    post(w, {
      organizationId: "hope",
      fundId: "hope-kits",
      amount: -50000,
      kind: "spend",
      subjectId: "other-order",
      source: "test confirmed",
      evidence: "simulation",
    });
    expect(() => command("checkout", { id: a.id })).toThrow("reserved");
  });
  it("records deficits instead of clamping the ledger to zero", () => {
    post(w, {
      organizationId: "hope",
      fundId: "hope-kits",
      amount: -70000,
      kind: "reversal",
      subjectId: "reversed-receipt",
      source: "test",
      evidence: "simulation",
    });
    expect(balances(w, "hope-kits").available).toBe(-10000);
  });
  it("cancels an unapproved local payment and restores offer reservation", () => {
    const { orders } = purchase();
    const o = orders[0];
    const c = w.catalog.find((c) => c.id === o.lines[0].catalogId)!;
    const before = c.availablePacks;
    command("cancelPayment", { id: o.id });
    expect(c.availablePacks).toBe(before + o.lines[0].packs);
    expect(o.status).toBe("cancelled");
  });
  it("requires a donor to manage their own subscription", () => {
    const s = command<Subscription>(
      "subscription",
      { campaignId: "campaign-hope", amount: 2500 },
      "donor",
    );
    expect(() =>
      command("cancelSubscription", { id: s.id }, "owner-a"),
    ).toThrow("Only the donor");
  });
  it("distinguishes subscription activation from actual billing", () => {
    const s = command<Subscription>(
      "subscription",
      { campaignId: "campaign-hope", amount: 2500 },
      "donor",
    );
    command("activateSubscription", { id: s.id }, "donor");
    expect(balances(w, "hope-kits").posted).toBe(60000);
    command("billSubscription", { id: s.id, eventId: "cycle-one" });
    command("billSubscription", { id: s.id, eventId: "cycle-one" });
    expect(balances(w, "hope-kits").posted).toBe(62500);
    command("cancelSubscription", { id: s.id }, "donor");
    expect(() =>
      command("billSubscription", { id: s.id, eventId: "cycle-two" }),
    ).toThrow("not active");
  });
  it("reserves donation refunds and posts only after confirmation", () => {
    const d = command<Donation>(
      "donation",
      { campaignId: "campaign-hope", amount: 2500 },
      "donor",
    );
    command("capture", { id: d.id }, "donor");
    command("donationRefund", { id: d.id });
    expect(balances(w, "hope-kits")).toEqual({
      posted: 62500,
      reserved: 2500,
      available: 60000,
    });
    command("confirmDonationRefund", { id: d.id });
    expect(balances(w, "hope-kits").available).toBe(60000);
  });
  it("pauses all new financial mutations", () => {
    command("stop", { enabled: false });
    expect(() =>
      command(
        "donation",
        { campaignId: "campaign-hope", amount: 100 },
        "donor",
      ),
    ).toThrow("paused");
    command("stop", { enabled: true });
    expect(() =>
      command(
        "donation",
        { campaignId: "campaign-hope", amount: 100 },
        "donor",
      ),
    ).not.toThrow();
  });
  it("never uses simulation to confirm a sandbox payment", () => {
    const d = command<Donation>(
      "donation",
      { campaignId: "campaign-hope", amount: 2500 },
      "donor",
    );
    vi.stubEnv("PAYMENTS_MODE", "sandbox");
    expect(() => command("capture", { id: d.id }, "donor")).toThrow(
      "Simulation cannot",
    );
  });
});
describe("inventory and recovery", () => {
  it("reserves existing stock until the complete approved purchase is received", () => {
    const { orders } = purchase();
    expect(kitReadiness(w, "hope", "hope-main", "kit-hope")).toBe(0);
    expect(() =>
      command("distribute", {
        siteId: "hope-main",
        kitId: "kit-hope",
        quantity: 1,
      }),
    ).toThrow("Not enough");
    expect(() =>
      command("adjust", {
        id: w.inventory[0].id,
        quantity: 0,
        reason: "shrink",
      }),
    ).toThrow("reserved");
    expect(() =>
      command("transfer", {
        id: w.inventory[0].id,
        siteId: "hope-east",
        quantity: 1,
      }),
    ).toThrow();
    for (const o of orders) {
      command("capture", { id: o.id });
      command(
        "fulfill",
        { id: o.id, status: "fulfilled" },
        o.supplierId === "harvest" ? "supplier-a" : "supplier-b",
      );
      command("receive", { id: o.id });
    }
    expect(
      kitReadiness(w, "hope", "hope-main", "kit-hope"),
    ).toBeGreaterThanOrEqual(50);
    expect(w.stockReservations.every((r) => r.released)).toBe(true);
  });
  it("consumes stock for actual distribution and prevents overspend", () => {
    command("distribute", {
      siteId: "hope-main",
      kitId: "kit-hope",
      quantity: 10,
    });
    expect(kitReadiness(w, "hope", "hope-main", "kit-hope")).toBe(0);
    expect(w.distributions[0].quantity).toBe(10);
    expect(() =>
      command("distribute", {
        siteId: "hope-main",
        kitId: "kit-hope",
        quantity: 1,
      }),
    ).toThrow("Not enough");
  });
  it("transfers a lot without inventing stock", () => {
    const l = w.inventory[0];
    const total = w.inventory.reduce((s, l) => s + l.quantity, 0);
    command("transfer", { id: l.id, siteId: "hope-east", quantity: 5 });
    expect(w.inventory.reduce((s, l) => s + l.quantity, 0)).toBe(total);
  });
  it("requires supplier fulfillment before receipt and receives once", () => {
    const { orders } = purchase();
    const o = orders[0];
    command("capture", { id: o.id });
    expect(() => command("receive", { id: o.id })).toThrow("fulfilled");
    command(
      "fulfill",
      { id: o.id, status: "fulfilled" },
      o.supplierId === "harvest" ? "supplier-a" : "supplier-b",
    );
    command("receive", { id: o.id });
    expect(() => command("receive", { id: o.id })).toThrow("fulfilled");
  });
  it("completes partial cancellation, merchant refund, receive, replacement, distribution", () => {
    const { orders, p: originalProposal } = purchase();
    const originalLines = structuredClone(originalProposal.lines);
    for (const o of orders) command("capture", { id: o.id });
    const o = orders.find((o) => o.supplierId === "harvest")!;
    const r = command<Recovery>(
      "partialCancel",
      {
        id: o.id,
        catalogId: o.lines.find((l) => l.sku === "rice")!.catalogId,
        packs: 2,
        reason: "stock shortage",
      },
      "supplier-a",
    );
    const before = balances(w, "hope-kits").available;
    expect(originalProposal.lines).toEqual(originalLines);
    command("requestRefund", { id: r.id });
    expect(balances(w, "hope-kits").available).toBe(before);
    expect(() => command("replacement", { id: r.id })).toThrow(
      "confirmed refund",
    );
    command("confirmRefund", { id: r.id }, "supplier-a");
    expect(balances(w, "hope-kits").available).toBe(before + 3600);
    for (const order of orders) {
      command(
        "fulfill",
        { id: order.id, status: "fulfilled" },
        order.supplierId === "harvest" ? "supplier-a" : "supplier-b",
      );
      command("receive", { id: order.id });
    }
    const p = command<Proposal>("replacement", { id: r.id });
    expect(
      w.requests.find((request) => request.id === p.requestId)
        ?.replacesRequestId,
    ).toBe(originalProposal.requestId);
    expect(
      w.requests
        .filter((request) => !request.replacesRequestId)
        .reduce((sum, request) => sum + request.target, 0),
    ).toBe(50);
    expect(p.lines.map((l) => l.sku)).toEqual(["rice"]);
    expect(p.shortages).toEqual([]);
    const a = command<Approval>("approve", { id: p.id });
    for (const order of command<Order[]>("checkout", { id: a.id })) {
      command("capture", { id: order.id });
      command(
        "fulfill",
        { id: order.id, status: "fulfilled" },
        order.supplierId === "harvest" ? "supplier-a" : "supplier-b",
      );
      command("receive", { id: order.id });
    }
    command("distribute", {
      siteId: "hope-main",
      kitId: "kit-hope",
      quantity: 50,
    });
    expect(w.distributions.at(-1)?.quantity).toBe(50);
    expect(r.status).toBe("resolved");
  });
  it("does not credit a failed merchant refund", () => {
    const { orders } = purchase();
    const o = orders[0];
    command("capture", { id: o.id });
    const actor = o.supplierId === "harvest" ? "supplier-a" : "supplier-b";
    const r = command<Recovery>(
      "partialCancel",
      {
        id: o.id,
        catalogId: o.lines[0].catalogId,
        packs: 1,
        reason: "stock shortage",
      },
      actor,
    );
    command("requestRefund", { id: r.id });
    const before = balances(w, "hope-kits").available;
    command("failRefund", { id: r.id }, actor);
    expect(balances(w, "hope-kits").available).toBe(before);
    expect(r.status).toBe("refund_failed");
  });
  it("previews quoted CSV and rejects unsafe or malformed imports", () => {
    expect(
      previewInventoryCsv(
        'sku,name,quantity,expiresAt\nrice,"Rice, whole grain",12,2027-12-31',
      )[0].name,
    ).toBe("Rice, whole grain");
    for (const csv of [
      "bad,header\na,b",
      "sku,name,quantity,expiresAt\nrice,=IMPORTXML(),12,",
      "sku,name,quantity,expiresAt\nrice,Rice,-1,",
    ])
      expect(() => previewInventoryCsv(csv)).toThrow();
  });
  it("imports validated lots atomically", () => {
    const before = w.inventory.length;
    expect(() =>
      command("import", {
        siteId: "hope-main",
        rows: [
          { sku: "rice", name: "Rice", quantity: 10 },
          { sku: "beans", name: "Beans", quantity: -1 },
        ],
      }),
    ).toThrow();
    expect(w.inventory.length).toBe(before);
    command("import", {
      siteId: "hope-main",
      rows: [{ sku: "rice", name: "Rice", quantity: 10 }],
    });
    expect(w.inventory.length).toBe(before + 1);
  });
  it("validates dashboard layouts and rejects arbitrary widget content", () => {
    const state = dashboardState("recovery");
    expect(studioStateSchema.parse(state)).toEqual(state);
    state.pages[0].widgets["widget-0"].type = "html";
    expect(() => studioStateSchema.parse(state)).toThrow();
  });
  it("fails closed for hosted local storage and live PayPal", () => {
    vi.stubEnv("APP_ENV", "hosted");
    expect(() => configuration()).toThrow("Supabase");
    vi.stubEnv("APP_ENV", "local");
    vi.stubEnv("PAYMENTS_MODE", "live");
    expect(() => configuration()).toThrow("Live money");
  });
});
describe("30 deterministic planner scenarios", () => {
  for (let i = 1; i <= 30; i++)
    it(`scenario ${i}: count, stock, budget and source validity`, () => {
      const target = i * 3;
      const impossible = i % 5 === 0;
      const r = request({ target, budget: impossible ? 1 : 60000 });
      if (i % 3 === 0) w.inventory[0].quantity = i;
      const p = plan(w, r);
      expect(p.total).toBe(
        p.lines.reduce((s, l) => s + l.cost, 0) + p.shipping,
      );
      expect(p.source).toBe("deterministic");
      expect(
        p.lines.every((l) =>
          w.catalog.some(
            (c) => c.id === l.catalogId && c.version === l.version,
          ),
        ),
      ).toBe(true);
      if (impossible && p.total > 0)
        expect(p.shortages.join(" ")).toContain("above");
      if (!p.shortages.length)
        for (const component of w.kits[0].components) {
          const stocked = w.inventory
            .filter((l) => l.siteId === r.siteId && l.sku === component.sku)
            .reduce((s, l) => s + l.quantity, 0);
          const units = p.lines
            .filter((l) => l.sku === component.sku)
            .reduce((s, l) => s + l.units, 0);
          expect(stocked + units).toBeGreaterThanOrEqual(
            target * component.quantity,
          );
        }
    });
});
