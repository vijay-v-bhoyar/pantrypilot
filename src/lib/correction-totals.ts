import type { Distribution, StockCorrection } from "./types";

// Shared by server and UI. Pending/rejected proposals never change totals.
export function effectiveDistribution(
  source: Distribution,
  corrections: StockCorrection[] = [],
) {
  return corrections.filter(c => c.kind === "distribution" &&
    c.sourceId === source.id && c.organizationId === source.organizationId &&
    c.status === "applied").at(-1)?.quantity ?? source.quantity;
}
