import type { StockLot, Workspace } from "./types";
export function freeLot(
  w: Pick<Workspace, "stockReservations">,
  lot: StockLot,
) {
  return Math.max(
    0,
    lot.quantity -
      (w.stockReservations || [])
        .filter((r) => r.lotId === lot.id && !r.released)
        .reduce((s, r) => s + r.quantity, 0),
  );
}
export function usableUnits(
  w: Pick<Workspace, "inventory" | "stockReservations">,
  organizationId: string,
  siteId: string,
  sku: string,
  today = new Date().toISOString().slice(0, 10),
) {
  return w.inventory
    .filter(
      (l) =>
        l.organizationId === organizationId &&
        l.siteId === siteId &&
        l.sku === sku &&
        (!l.expiresAt || l.expiresAt >= today),
    )
    .reduce((s, l) => s + freeLot(w, l), 0);
}
