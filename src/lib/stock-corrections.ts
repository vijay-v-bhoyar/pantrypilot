import { randomUUID } from "node:crypto";
import { ensure } from "./errors";
import { digest } from "./planner";
import { eligibleLot, freeLot } from "./inventory";
import type { Actor, StockCorrection, StockMovement, Workspace } from "./types";

type Input = Pick<StockCorrection, "kind" | "sourceId" | "quantity" | "reason" | "evidence"> & {
  movements: { lotId: string; quantity: number }[];
};

function sourceFor(w: Workspace, actor: Actor, kind: Input["kind"], id: string) {
  const source = kind === "distribution"
    ? w.distributions.find(d => d.id === id && d.organizationId === actor.organizationId)
    : w.orders.find(o => o.id === id && o.organizationId === actor.organizationId && o.status === "received");
  ensure(source, "NOT_FOUND", "Completed source record not found in this nonprofit.", 404);
  const movements = "kitId" in source ? source.movements : source.receipt?.movements;
  ensure(movements?.length && (!("kitId" in source) || source.components?.length),
    "PROVENANCE", "This legacy record has no lot provenance. Keep it unresolved for manual review.", 409);
  ensure(w.organizations.some(o => o.id === actor.organizationId && o.sites.some(s => s.id === source.siteId)),
    "SITE", "Source site is no longer available.", 409);
  return { source, movements };
}

function snapshot(w: Workspace, actor: Actor, kind: Input["kind"], id: string) {
  const { source, movements } = sourceFor(w, actor, kind, id);
  const ids = new Set(movements.map(m => m.lotId));
  return digest({
    source,
    corrections: (w.stockCorrections ?? []).filter(c => c.sourceId === id && c.kind === kind && c.status === "applied"),
    lots: w.inventory.filter(l => ids.has(l.id)),
    reservations: w.stockReservations.filter(r => ids.has(r.lotId)),
    members: w.actors.filter(a => a.organizationId === actor.organizationId),
    membershipChanges: w.audit.filter(a => a.organizationId === actor.organizationId && ["member", "revoke"].includes(a.action)),
  });
}

function intent(c: StockCorrection) {
  const { id, organizationId, siteId, kind, sourceId, originalQuantity, quantity,
    movements, reason, evidence, proposerId, createdAt, expiresAt, snapshot, basis } = c;
  return { id, organizationId, siteId, kind, sourceId, originalQuantity, quantity,
    movements, reason, evidence, proposerId, createdAt, expiresAt, snapshot, basis };
}

function validate(w: Workspace, actor: Actor, d: Input): StockMovement[] {
  const { source, movements: original } = sourceFor(w, actor, d.kind, d.sourceId);
  ensure(new Set(d.movements.map(m => m.lotId)).size === d.movements.length,
    "CORRECTION", "Choose each source lot only once.", 422);
  const previous = (w.stockCorrections ?? []).filter(c => c.kind === d.kind && c.sourceId === d.sourceId && c.status === "applied");
  const movements = d.movements.map(m => {
    const base = original.find(b => b.lotId === m.lotId);
    const lot = w.inventory.find(l => l.id === m.lotId && l.organizationId === actor.organizationId && l.siteId === source.siteId);
    ensure(base && lot && lot.sku === base.sku, "PROVENANCE", "Choose a lot recorded on the original source.", 409);
    if ("kitId" in source && m.quantity < 0) {
      const component = source.components?.find(c => c.sku === lot.sku);
      ensure(component?.attributes && eligibleLot(lot, actor.organizationId, source.siteId, lot.sku,
        undefined, component.attributes), "STOCK", "Additional distribution requires verified product attributes on the exact source lot.", 409);
    }
    ensure(m.quantity !== 0 && Number.isSafeInteger(m.quantity), "CORRECTION", "Lot changes must be nonzero whole units.", 422);
    const effective = base.quantity + previous.reduce((s, c) => s + (c.movements.find(x => x.lotId === m.lotId)?.quantity ?? 0), 0) + m.quantity;
    ensure(d.kind === "distribution" ? effective <= 0 : effective >= 0,
      "CORRECTION", "Compensation exceeds the recorded source movement.", 409);
    ensure(lot.quantity + m.quantity >= 0 && lot.quantity + m.quantity <= 100000 &&
      (m.quantity > 0 || freeLot(w, lot) >= -m.quantity),
      "STOCK", "Compensation would consume unavailable or reserved stock.", 409);
    ensure((d.kind === "receipt" && m.quantity < 0) || !lot.expiresAt || lot.expiresAt >= new Date().toISOString().slice(0, 10),
      "STOCK", "Do not restore expired stock. Keep this discrepancy for manual review.", 409);
    return { ...m, sku: base.sku };
  });
  if ("kitId" in source) {
    const effectiveCount = previous.at(-1)?.quantity ?? source.quantity;
    ensure(d.quantity !== effectiveCount, "CORRECTION", "The effective kit count must change.", 422);
    for (const component of source.components!) {
      ensure(movements.filter(m => m.sku === component.sku).reduce((s, m) => s + m.quantity, 0) ===
        (effectiveCount - d.quantity) * component.quantity,
        "CORRECTION", "Exact lot changes must match the corrected kit count for every component.", 422);
    }
    ensure(movements.every(m => source.components!.some(c => c.sku === m.sku)), "CORRECTION", "Unknown kit component.", 422);
  } else {
    const effectiveUnits = original.reduce((s, m) => s + m.quantity, 0) +
      previous.reduce((s, c) => s + c.movements.reduce((n, m) => n + m.quantity, 0), 0);
    ensure(d.quantity === effectiveUnits + movements.reduce((s, m) => s + m.quantity, 0),
      "CORRECTION", "Corrected receipt units must match the exact lot changes.", 422);
  }
  return movements;
}

export function proposeCorrection(w: Workspace, actor: Actor, d: Input): StockCorrection {
  ensure(actor.role === "coordinator", "FORBIDDEN", "A coordinator must propose a stock correction.", 403);
  ensure(!(w.stockCorrections ?? []).some(c => c.organizationId === actor.organizationId && c.kind === d.kind && c.sourceId === d.sourceId && c.status === "proposed"),
    "CORRECTION_PENDING", "Review or reject the existing proposal before starting another.", 409);
  const movements = validate(w, actor, d);
  const { source, movements: original } = sourceFor(w, actor, d.kind, d.sourceId);
  const now = new Date().toISOString();
  const c: StockCorrection = {
    ...d, movements, id: randomUUID(), organizationId: actor.organizationId, siteId: source.siteId,
    originalQuantity: "kitId" in source ? source.quantity : original.reduce((s, m) => s + m.quantity, 0),
    proposerId: actor.id, createdAt: now, expiresAt: new Date(Date.now() + 15 * 60000).toISOString(),
    snapshot: snapshot(w, actor, d.kind, d.sourceId), digest: "", status: "proposed",
    basis: {
      sourceDigest: digest(source),
      lots: w.inventory.filter(l => original.some(m => m.lotId === l.id)).map(l => ({
        lotId: l.id, sku: l.sku, siteId: l.siteId, quantity: l.quantity, version: l.version,
        reserved: w.stockReservations.filter(r => r.lotId === l.id && !r.released).reduce((s, r) => s + r.quantity, 0),
        expiresAt: l.expiresAt,
      })),
    },
  };
  c.digest = digest(intent(c));
  (w.stockCorrections ??= []).push(c);
  return c;
}

export function approveCorrection(w: Workspace, actor: Actor, id: string, expected: string) {
  ensure(actor.role === "owner", "FORBIDDEN", "Only an organization owner can approve a stock correction.", 403);
  const c = w.stockCorrections?.find(c => c.id === id && c.organizationId === actor.organizationId);
  ensure(c, "NOT_FOUND", "Correction not found in this nonprofit.", 404);
  ensure(c.status === "proposed", "STATE", "This correction has already been reviewed.", 409);
  ensure(c.basis?.lots.length && c.basis.sourceDigest, "PROVENANCE", "Review evidence is unavailable. Reject this proposal and recount.", 409);
  ensure(c.proposerId !== actor.id, "SELF_APPROVAL", "A different owner must review the coordinator's proposal.", 403);
  ensure(w.actors.some(a => a.id === c.proposerId && a.organizationId === actor.organizationId && a.role === "coordinator"),
    "MEMBERSHIP", "The proposing coordinator's authority has changed.", 409);
  ensure(c.digest === expected && c.digest === digest(intent(c)), "STALE", "The exact correction has changed. Review a new proposal.", 409);
  ensure(Date.parse(c.expiresAt) > Date.now() && c.snapshot === snapshot(w, actor, c.kind, c.sourceId),
    "STALE", "Stock, source, membership or approval time changed. Reject this proposal and recount before proposing again.", 409);
  // All checks finish before the first mutation. The workspace lease commits
  // movements, correction, audit and idempotency together, or commits none.
  validate(w, actor, c);
  for (const m of c.movements) {
    const lot = w.inventory.find(l => l.id === m.lotId)!;
    lot.quantity += m.quantity;
    lot.version++;
  }
  c.status = "applied";
  c.approverId = actor.id;
  c.appliedAt = new Date().toISOString();
  return c;
}
