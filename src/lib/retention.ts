import type { Workspace } from "./types";
export function archiveEligible(w: Workspace, now = Date.now()) {
  return (
    w.demo &&
    Number.isFinite(Date.parse(w.updatedAt)) &&
    Date.parse(w.updatedAt) < now - 7 * 86400000 &&
    w.paymentOperations.length === 0 &&
    w.providerEvents.length === 0 &&
    w.orders.every((o) => o.status === "received" || o.status === "cancelled") &&
    w.donations.every((d) => ["confirmed", "cancelled", "refunded"].includes(d.status)) &&
    w.subscriptions.every((s) => s.status === "cancelled") &&
    w.recoveries.every((r) => r.status === "resolved") &&
    Array.isArray(w.stockReservations) &&
    w.stockReservations.every((r) => r.released) &&
    (w.stockCorrections ?? []).every((c) => c.status !== "proposed") &&
    w.ledger.every((l) => l.evidence === "simulation") &&
    w.orders.every((o) => o.evidence === "simulation" && !o.providerId) &&
    w.donations.every((d) => d.evidence === "simulation" && !d.providerId) &&
    w.subscriptions.every((s) => !s.providerId)
  );
}
