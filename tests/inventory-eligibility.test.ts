import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { seedWorkspace } from "@/lib/seed";
import { execute, view } from "@/lib/commands";
import { kitReadiness, plan } from "@/lib/planner";
import { dashboardEvidence } from "@/lib/dashboard-evidence";
import { previewInventoryCsv } from "@/lib/csv";
import type { Approval, Distribution, Order, Proposal, PurchaseRequest, StockLot, Workspace } from "@/lib/types";

let w: Workspace;
const command = <T>(name: string, data: unknown, actor = "owner-a") =>
  execute(w, actor, name, data, randomUUID()) as T;
function request(target = 20) {
  return command<PurchaseRequest>("request", { siteId: "hope-main", kitId: "kit-hope", fundId: "hope-kits",
    target, budget: 60000, deadline: "2026-11-10", notes: "" });
}
function lot(attributes?: string[], expiresAt = "2027-12-31") {
  return { id: randomUUID(), organizationId: "hope", siteId: "hope-main", sku: "rice", name: "Recorded rice",
    quantity: 10, expiresAt, version: 1, ...(attributes === undefined ? {} : { attributes }) } as StockLot;
}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-04T23:58:00Z"));
  for (const [key, value] of Object.entries({ APP_ENV: "local", STORAGE_MODE: "local", PAYMENTS_MODE: "simulation",
    AI_MODE: "manual", PROVIDER_ACTIONS_ENABLED: "false", FINANCIAL_ACTIONS_ENABLED: "true" })) vi.stubEnv(key, value);
  w = seedWorkspace(); w.inventory = [];
  w.kits[0].components = [{ sku: "rice", name: "Rice", quantity: 1, attributes: ["shelf-stable"] }];
  w.catalog = [{ ...w.catalog[0], packSize: 1, availablePacks: 100, price: 100 }]; w.suppliers[0].shipping = 0;
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

it.each([{ attributes: undefined }, { attributes: [] }, { attributes: ["household"] }])("does not count unknown or mismatched stock attributes $attributes", ({ attributes }) => {
  w.inventory = [lot(attributes)];
  expect(kitReadiness(w, "hope", "hope-main", "kit-hope")).toBe(0);
  expect(dashboardEvidence(view(w, "owner-a")).readyKits).toBe(0);
  const proposal = plan(w, request(10));
  expect(proposal.shortages).toEqual([]);
  expect(proposal.lines.reduce((s, line) => s + line.units, 0)).toBe(10);
  const before = structuredClone(w);
  expect(() => command("distribute", { siteId: "hope-main", kitId: "kit-hope", quantity: 1 })).toThrow("Not enough complete kits");
  expect(w).toEqual(before);
});

it("does not infer suitability when neither lots nor offers supply required attributes", () => {
  w.inventory = [lot()]; w.catalog[0].attributes = [];
  expect(plan(w, request(10)).shortages.length).toBeGreaterThan(0);
});

it("consumes only eligible lots and leaves same-SKU unknown lots intact", () => {
  const unknown = lot(undefined, "2026-11-05"), wrong = lot(["household"]), verified = lot(["shelf-stable"]);
  w.inventory = [unknown, wrong, verified];
  expect(kitReadiness(w, "hope", "hope-main", "kit-hope")).toBe(10);
  const distribution = command<Distribution>("distribute", { siteId: "hope-main", kitId: "kit-hope", quantity: 3 });
  expect(distribution.movements).toEqual([{ lotId: verified.id, sku: "rice", quantity: -3 }]);
  expect(unknown.quantity).toBe(10); expect(wrong.quantity).toBe(10); expect(verified.quantity).toBe(7);
});

it("reserves only eligible lots while purchasing the remaining requirement", () => {
  const unknown = lot(), verified = lot(["shelf-stable"]); w.inventory = [unknown, verified];
  const p = command<Proposal>("propose", { id: request().id });
  const a = command<Approval>("approve", { id: p.id }); command("checkout", { id: a.id });
  expect(w.stockReservations.map(r => [r.lotId, r.quantity])).toEqual([[verified.id, 10]]);
  expect(unknown.quantity).toBe(10);
});

it.each(["approve", "checkout"])("rejects expired stock at %s without consuming approval or changing state", phase => {
  w.inventory = [lot(["shelf-stable"], "2026-11-04")];
  const r = request(), p = command<Proposal>("propose", { id: r.id });
  expect(p.lines.reduce((s, line) => s + line.units, 0)).toBe(10);
  const a = phase === "checkout" ? command<Approval>("approve", { id: p.id }) : undefined;
  vi.setSystemTime(new Date("2026-11-05T00:01:00Z"));
  if (a) expect(Date.parse(a.expiresAt)).toBeGreaterThan(Date.now());
  const before = structuredClone(w);
  expect(() => command(phase, { id: a?.id ?? p.id })).toThrow(expect.objectContaining({ code: "STALE" }));
  expect(w).toEqual(before);
  const fresh = command<Proposal>("propose", { id: r.id });
  expect(fresh.lines.reduce((s, line) => s + line.units, 0)).toBe(20);
  const freshApproval = command<Approval>("approve", { id: fresh.id });
  expect(command<Order[]>("checkout", { id: freshApproval.id })[0].lines[0].units).toBe(20);
});

it("allows a still-feasible approval across midnight", () => {
  w.inventory = [lot(["shelf-stable"])];
  const p = command<Proposal>("propose", { id: request().id });
  const a = command<Approval>("approve", { id: p.id });
  vi.setSystemTime(new Date("2026-11-05T00:01:00Z"));
  expect(command<Order[]>("checkout", { id: a.id })[0].lines[0].units).toBe(10);
});

it("keeps explicit attributes through manual entry, import and transfer without inferring legacy values", () => {
  const entered = command<StockLot>("inventory", { siteId: "hope-main", sku: "rice", name: "Rice", quantity: 4, attributes: ["shelf-stable"] });
  const moved = command<StockLot>("transfer", { id: entered.id, siteId: "hope-east", quantity: 2 });
  expect(moved.attributes).toEqual(["shelf-stable"]);
  const rows = previewInventoryCsv("sku,name,quantity,expiresAt,attributes\nrice,Rice,3,2027-12-31,shelf-stable");
  command("import", { siteId: "hope-main", rows });
  expect(w.inventory.at(-1)?.attributes).toEqual(["shelf-stable"]);
  command("import", { siteId: "hope-main", rows: previewInventoryCsv("sku,name,quantity,expiresAt\nrice,Unknown rice,7,") });
  expect(w.inventory.at(-1)?.attributes ?? []).toEqual([]);
  expect(kitReadiness(w, "hope", "hope-main", "kit-hope")).toBe(5);
});

it("receives approved attribute and expiry snapshots rather than a subsequently edited catalog", () => {
  w.catalog[0].expiresAt = "2027-12-31";
  const p = command<Proposal>("propose", { id: request(10).id });
  const a = command<Approval>("approve", { id: p.id }); const [o] = command<Order[]>("checkout", { id: a.id });
  command("capture", { id: o.id }); command("fulfill", { id: o.id, status: "fulfilled" }, "supplier-a");
  w.catalog[0].attributes = ["household"]; w.catalog[0].expiresAt = "2026-11-03";
  command("receive", { id: o.id });
  expect(w.inventory[0].attributes).toEqual(["shelf-stable"]);
  expect(w.inventory[0].expiresAt).toBe("2027-12-31");
  expect(kitReadiness(w, "hope", "hope-main", "kit-hope")).toBe(10);
});

it("requires the current lot version and staff authority for explicit attribute verification", () => {
  const unknown = lot(); w.inventory = [unknown]; const before = structuredClone(w);
  for (const version of [undefined, 0, 99]) {
    expect(() => command("adjust", { id: unknown.id, quantity: 10, reason: "Reviewed lot records", attributes: ["shelf-stable"], version })).toThrow();
    expect(w).toEqual(before);
  }
  expect(() => command("adjust", { id: unknown.id, quantity: 10, reason: "Reviewed lot records", attributes: ["shelf-stable"], version: 1 }, "donor")).toThrow();
  expect(w).toEqual(before);
  command("adjust", { id: unknown.id, quantity: 10, reason: "Reviewed lot records", attributes: ["shelf-stable"], version: 1 });
  expect(kitReadiness(w, "hope", "hope-main", "kit-hope")).toBe(10);
  expect(w.audit.at(-1)?.action).toBe("adjust");
});

it.each(["allergen-free", "shelf-stable|invented"])("rejects unsupported imported attributes %s", attributes => {
  expect(() => previewInventoryCsv(`sku,name,quantity,expiresAt,attributes\nrice,Rice,10,,${attributes}`)).toThrow("attributes");
});

it("allows unrestricted recipes to use a legacy lot without silently adding attributes", () => {
  w.inventory = [lot()]; w.kits[0].components[0].attributes = [];
  expect(kitReadiness(w, "hope", "hope-main", "kit-hope")).toBe(10);
  command("distribute", { siteId: "hope-main", kitId: "kit-hope", quantity: 1 });
  expect(w.inventory[0].attributes).toBeUndefined();
});

it("does not invent metadata while receiving a legacy order", () => {
  const p = command<Proposal>("propose", { id: request(10).id });
  const a = command<Approval>("approve", { id: p.id }); const [o] = command<Order[]>("checkout", { id: a.id });
  for (const line of o.lines) { delete line.attributes; delete line.expiresAt; }
  command("capture", { id: o.id }); command("fulfill", { id: o.id, status: "fulfilled" }, "supplier-a");
  command("receive", { id: o.id });
  expect(w.inventory[0].attributes).toEqual([]); expect(w.inventory[0].expiresAt).toBeUndefined();
  expect(kitReadiness(w, "hope", "hope-main", "kit-hope")).toBe(0);
});

it("rejects additional distribution through correction when source-lot attributes become unverified", () => {
  const verified = lot(["shelf-stable"]); w.inventory = [verified];
  const d = command<Distribution>("distribute", { siteId: "hope-main", kitId: "kit-hope", quantity: 1 });
  command("adjust", { id: verified.id, quantity: 9, attributes: [], version: verified.version, reason: "Suitability evidence withdrawn" });
  const before = structuredClone(w);
  expect(() => command("correctionPropose", { kind: "distribution", sourceId: d.id, quantity: 2,
    movements: [{ lotId: verified.id, quantity: -1 }], reason: "Recount", evidence: "Synthetic exact-lot recount" }, "coordinator-a")).toThrow("attributes");
  expect(w).toEqual(before);
});
