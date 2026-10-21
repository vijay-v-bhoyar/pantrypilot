import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { execute, view } from "@/lib/commands";
import { seedWorkspace } from "@/lib/seed";
import { effectiveDistribution } from "@/lib/correction-totals";
import { archiveEligible } from "@/lib/retention";
import type { Approval, Distribution, Order, Proposal, PurchaseRequest, StockCorrection, Workspace } from "@/lib/types";

let w: Workspace;
const command = <T>(name: string, data: unknown, actor = "coordinator-a", key = randomUUID()) => execute(w, actor, name, data, key) as T;
beforeEach(() => {
  for (const [name, value] of Object.entries({ APP_ENV: "local", VERCEL: "", STORAGE_MODE: "local", PAYMENTS_MODE: "simulation", FINANCIAL_ACTIONS_ENABLED: "true", PROVIDER_ACTIONS_ENABLED: "false", AI_MODE: "manual" })) vi.stubEnv(name, value);
  w = seedWorkspace();
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });
function distribution() {
  return command<Distribution>("distribute", { siteId: "hope-main", kitId: "kit-hope", quantity: 5 });
}
function proposal(d = distribution(), quantity = 3) {
  return command<StockCorrection>("correctionPropose", { kind: "distribution", sourceId: d.id, quantity,
    movements: d.movements!.map(m => ({ lotId: m.lotId, quantity: -m.quantity / d.quantity * (d.quantity - quantity) })),
    reason: "Clerical count error", evidence: "Synthetic recount sheet PP-001; no physical handout" });
}
function approve(c: StockCorrection, actor = "owner-a", key = randomUUID()) {
  return command<StockCorrection>("correctionApprove", { id: c.id, digest: c.digest }, actor, key);
}
function received() {
  const r = command<PurchaseRequest>("request", { siteId: "hope-main", kitId: "kit-hope", fundId: "hope-kits", target: 50, budget: 60000, deadline: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10), notes: "" });
  const p = command<Proposal>("propose", { id: r.id });
  const a = command<Approval>("approve", { id: p.id }, "finance-a");
  const orders = command<Order[]>("checkout", { id: a.id }, "finance-a");
  const o = orders.find(o => o.supplierId === "harvest")!;
  command("capture", { id: o.id }, "finance-a");
  command("fulfill", { id: o.id, status: "fulfilled" }, "supplier-a");
  command("receive", { id: o.id });
  return o;
}
function receiptProposal(o = received(), delta = -2) {
  const m = o.receipt!.movements[0];
  return command<StockCorrection>("correctionPropose", { kind: "receipt", sourceId: o.id,
    quantity: o.receipt!.movements.reduce((s, m) => s + m.quantity, 0) + delta,
    movements: [{ lotId: m.lotId, quantity: delta }], reason: "Shipment count transcription", evidence: "Synthetic count PP-002" });
}

it.each([3, 7, 0])("corrects effective distribution to %s exactly once while retaining original source and money", quantity => {
  const d = distribution(), original = structuredClone(d), originalAudit = structuredClone(w.audit), money = structuredClone(w.ledger);
  const before = structuredClone(w.inventory), c = proposal(d, quantity);
  expect(c.basis?.sourceDigest).toHaveLength(64);
  for (const lot of c.basis!.lots) expect(lot.version).toBe(before.find(l => l.id === lot.lotId)!.version);
  expect(w.inventory).toEqual(before); expect(effectiveDistribution(d, w.stockCorrections)).toBe(5);
  const key = randomUUID(); approve(c, "owner-a", key); approve(c, "owner-a", key);
  expect(d).toEqual(original); expect(w.ledger).toEqual(money);
  expect(w.audit.slice(0, originalAudit.length)).toEqual(originalAudit);
  expect(effectiveDistribution(d, w.stockCorrections)).toBe(quantity);
  for (const m of c.movements) expect(w.inventory.find(l => l.id === m.lotId)!.quantity).toBe(before.find(l => l.id === m.lotId)!.quantity + m.quantity);
  expect(w.audit.filter(a => a.action === "correctionApprove")).toHaveLength(1);
  expect(() => approve(c)).toThrow("already been reviewed");
});
it("binds exact multi-lot provenance and permits a later independently recounted correction", () => {
  const first = w.inventory.find(l => l.sku === "rice" && l.siteId === "hope-main")!;
  const second = { ...first, id: randomUUID(), quantity: first.quantity - 4, expiresAt: "2028-12-31" };
  first.quantity = 4; first.expiresAt = "2027-12-31"; w.inventory.push(second);
  const d = distribution(); expect(d.movements!.filter(m => m.sku === "rice")).toHaveLength(2);
  const other = d.movements!.filter(m => m.sku !== "rice").map(m => ({ lotId: m.lotId, quantity: -m.quantity / 5 * 2 }));
  const c = command<StockCorrection>("correctionPropose", { kind: "distribution", sourceId: d.id, quantity: 3,
    movements: [{ lotId: first.id, quantity: 4 }, ...other], reason: "Recount", evidence: "Synthetic explicit lot mapping" });
  approve(c); expect(effectiveDistribution(d, w.stockCorrections)).toBe(3);
  const next = command<StockCorrection>("correctionPropose", { kind: "distribution", sourceId: d.id, quantity: 4,
    movements: [{ lotId: first.id, quantity: -2 }, ...other.map(m => ({ lotId: m.lotId, quantity: -m.quantity / 2 }))], reason: "Second physical recount", evidence: "Synthetic independent recount" });
  approve(next); expect(effectiveDistribution(d, w.stockCorrections)).toBe(4); expect(d.quantity).toBe(5);
});
it.each(["finance-a", "owner-a", "donor", "supplier-a"])("denies proposal by %s", actor => {
  const c = proposal(); command("correctionReject", { id: c.id }, "owner-a");
  const before = structuredClone(w);
  const { kind, sourceId, quantity, reason, evidence } = c;
  expect(() => command("correctionPropose", { kind, sourceId, quantity, reason, evidence,
    movements: c.movements.map(({ lotId, quantity }) => ({ lotId, quantity })) }, actor)).toThrow("role"); expect(w).toEqual(before);
});
it.each(["finance-a", "coordinator-a", "donor", "supplier-a", "owner-b"])("denies approval by %s without mutation", actor => {
  const c = proposal(), before = structuredClone(w);
  expect(() => approve(c, actor)).toThrow(); expect(w).toEqual(before);
});
it("rejects self approval after a coordinator becomes owner", () => {
  const c = proposal(); w.actors.find(a => a.id === c.proposerId)!.role = "owner";
  expect(() => approve(c, c.proposerId)).toThrow("different owner");
});
it.each(["quantity", "lot-version", "lot-site", "reservation", "source", "proposer-revoked", "owner-demoted", "expired", "intent"])("invalidates review after %s changes", change => {
  const c = proposal();
  const lot = w.inventory.find(l => l.id === c.movements[0].lotId)!;
  if (change === "quantity") lot.quantity++;
  if (change === "lot-version") lot.version++;
  if (change === "lot-site") lot.siteId = "hope-east";
  if (change === "reservation") w.stockReservations.push({ id: "reservation", organizationId: "hope", proposalId: "pending", lotId: lot.id, quantity: 1, released: false });
  if (change === "source") w.distributions[0].quantity++;
  if (change === "proposer-revoked") w.actors = w.actors.filter(a => a.id !== c.proposerId);
  if (change === "owner-demoted") w.actors.find(a => a.id === "owner-a")!.role = "finance";
  if (change === "expired") { vi.useFakeTimers(); vi.setSystemTime(Date.parse(c.expiresAt)); }
  if (change === "intent") c.quantity = 2;
  const before = structuredClone(w); expect(() => approve(c)).toThrow(); expect(w).toEqual(before);
});
it("requires the reviewed digest and actor/body-bound replay", () => {
  const c = proposal(), key = randomUUID();
  expect(() => command("correctionApprove", { id: c.id, digest: "0".repeat(64) }, "owner-a")).toThrow("exact correction");
  approve(c, "owner-a", key);
  expect(() => command("correctionApprove", { id: c.id, digest: "1".repeat(64) }, "owner-a", key)).toThrow("already used");
  w.actors.push({ id: "other-owner", name: "Second owner", role: "owner", organizationId: "hope" });
  expect(() => approve(c, "other-owner", key)).toThrow("already used");
  w.actors.find(a => a.id === "owner-a")!.role = "finance";
  expect(() => approve(c, "owner-a", key)).toThrow("role");
});
it("rejects a pending plan before recounting; rejection changes neither stock nor totals", () => {
  const d = distribution(), c = proposal(d), before = structuredClone(w.inventory);
  expect(() => proposal(d)).toThrow("existing proposal");
  command("correctionReject", { id: c.id });
  expect(w.inventory).toEqual(before); expect(effectiveDistribution(d, w.stockCorrections)).toBe(5);
  expect(() => approve(c)).toThrow("already been reviewed");
  expect(proposal(d).status).toBe("proposed");
});
it.each([-2, 3])("corrects receipt units by %s without changing order/payment/receipt provenance", delta => {
  const o = received(), original = structuredClone(o), money = structuredClone(w.ledger), c = receiptProposal(o, delta);
  approve(c); expect(o).toEqual(original); expect(w.ledger).toEqual(money);
  expect(w.inventory.find(l => l.id === c.movements[0].lotId)!.quantity).toBe(original.receipt!.movements[0].quantity + delta);
  expect(() => command("receive", { id: o.id })).toThrow("fulfilled");
});
it.each(["consumed", "reserved", "expired", "foreign-lot", "negative-source"])("refuses unsafe receipt compensation: %s", condition => {
  const o = received(), lot = w.inventory.find(l => l.id === o.receipt!.movements[0].lotId)!;
  if (condition === "consumed") lot.quantity = 0;
  if (condition === "reserved") w.stockReservations.push({ id: "r", organizationId: "hope", proposalId: "p", lotId: lot.id, quantity: lot.quantity, released: false });
  if (condition === "expired") lot.expiresAt = "2000-01-01";
  if (condition === "foreign-lot") lot.organizationId = "river";
  const before = structuredClone(w);
  expect(() => receiptProposal(o, condition === "expired" ? 1 : condition === "negative-source" ? -100000 : -2)).toThrow(); expect(w).toEqual(before);
});
it.each(["distribution", "receipt"] as const)("keeps legacy %s provenance unresolved", kind => {
  const source = kind === "distribution" ? distribution() : received();
  if ("kitId" in source) delete source.movements; else delete source.receipt;
  expect(() => command("correctionPropose", { kind, sourceId: source.id, quantity: 0,
    movements: [{ lotId: w.inventory[0].id, quantity: 1 }], reason: "Legacy", evidence: "Unknown source lots" })).toThrow("legacy record");
});
it("omits incidents/provenance from other organizations, donors and suppliers, and retains pending corrections", () => {
  const c = proposal();
  for (const actor of ["owner-b", "donor", "supplier-a"]) expect(view(w, actor).stockCorrections).toEqual([]);
  expect(view(w, "finance-a").stockCorrections?.[0].id).toBe(c.id);
  w.updatedAt = new Date(Date.now() - 8 * 86400000).toISOString(); expect(archiveEligible(w)).toBe(false);
});
it.each(["wrong-source", "duplicate-lot", "missing-component", "over-restore", "fractional", "missing-evidence"])("rejects invalid correction input: %s", condition => {
  const d = distribution();
  const input = { kind: "distribution", sourceId: d.id, quantity: 3, reason: "Recount", evidence: "Synthetic evidence",
    movements: d.movements!.map(m => ({ lotId: m.lotId, quantity: -m.quantity / 5 * 2 })) };
  if (condition === "wrong-source") input.sourceId = "another-record";
  if (condition === "duplicate-lot") input.movements.push(input.movements[0]);
  if (condition === "missing-component") input.movements.pop();
  if (condition === "over-restore") input.movements[0].quantity = 1000;
  if (condition === "fractional") input.movements[0].quantity = 0.5;
  if (condition === "missing-evidence") input.evidence = "";
  const before = structuredClone(w); expect(() => command("correctionPropose", input)).toThrow(); expect(w).toEqual(before);
});
it("does not let another coordinator reject a colleague's proposal", () => {
  const c = proposal(); w.actors.push({ id: "another-coordinator", name: "Second coordinator", role: "coordinator", organizationId: "hope" });
  expect(() => command("correctionReject", { id: c.id }, "another-coordinator")).toThrow("proposing coordinator");
});
