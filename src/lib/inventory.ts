import type { StockLot, Workspace } from "./types";
export function eligibleLot(
  lot: StockLot, organizationId: string, siteId: string, sku: string,
  today = new Date().toISOString().slice(0, 10), requiredAttributes: readonly string[] = [],
) {
  return lot.organizationId === organizationId && lot.siteId === siteId && lot.sku === sku &&
    (!lot.expiresAt || lot.expiresAt >= today) &&
    requiredAttributes.every(attribute => lot.attributes?.includes(attribute) === true);
}
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
  requiredAttributes: readonly string[] = [],
) {
  return w.inventory
    .filter(
      (l) => eligibleLot(l, organizationId, siteId, sku, today, requiredAttributes),
    )
    .reduce((s, l) => s + freeLot(w, l), 0);
}
