import { z } from "zod";
import type { AppView } from "./types";
import { focusSchema, type Focus } from "./dashboard";
import { usableUnits } from "./inventory";
import { effectiveDistribution } from "./correction-totals";
import { usd } from "./money";

const count = z.number().int().nonnegative().safe();
export const dashboardEvidenceSchema = z.object({
  availableCents: z.number().int().safe(),
  reservedCents: count,
  pendingRecoveryCents: count,
  pendingRecoveryCases: count,
  readyKits: count,
  receivedShipments: count,
  recordedKits: count,
  unreceivedOrders: count,
}).strict();
export type DashboardEvidence = z.infer<typeof dashboardEvidenceSchema>;
export const analystResponseSchema = z.object({
  focus: focusSchema,
  // Optional for older focus-only server responses. Current server always supplies it.
  evidence: dashboardEvidenceSchema.optional(),
}).strict();

// Input must be the existing actor-scoped AppView, never an unfiltered workspace.
// Only numeric aggregates leave this projection: no IDs, notes or donor/catalog text.
export function dashboardEvidence(w: AppView): DashboardEvidence {
  const site = w.organizations[0]?.sites[0];
  const kit = w.kits[0];
  const pending = w.recoveries.filter(r =>
    ["opened", "refund_requested", "refund_pending"].includes(r.status));
  return dashboardEvidenceSchema.parse({
    availableCents: Object.values(w.available).reduce((s, n) => s + n, 0),
    reservedCents: Object.values(w.reserved).reduce((s, n) => s + n, 0),
    pendingRecoveryCents: pending.reduce((s, r) => s + r.amount, 0),
    pendingRecoveryCases: pending.length,
    readyKits: site && kit?.components.length ? Math.min(...kit.components.map(c =>
      Math.floor(usableUnits(w, w.actor.organizationId, site.id, c.sku) / c.quantity))) : 0,
    receivedShipments: w.orders.filter(o => o.status === "received").length,
    recordedKits: w.distributions.reduce((s, d) => s + effectiveDistribution(d, w.stockCorrections), 0),
    unreceivedOrders: w.orders.filter(o => !["received", "cancelled"].includes(o.status)).length,
  });
}

export function recommendedFocus(e: DashboardEvidence): Focus {
  if (e.availableCents < 0) return "funds";
  if (e.pendingRecoveryCases) return "recovery";
  if (e.unreceivedOrders) return "evidence";
  return "readiness";
}

// Facts and next steps are rendered deterministically, never model-authored metrics.
export function evidenceBrief(focus: Focus, e: DashboardEvidence) {
  switch (focus) {
    case "funds": return {
      summary: `${usd(e.availableCents)} available; ${usd(e.reservedCents)} reserved. Pending recovery is excluded from available funds.`,
      nextStep: "Review the permitted fund and obtain a fresh exact-basket approval before purchasing.",
    };
    case "recovery": return {
      summary: `${e.pendingRecoveryCases} unconfirmed recovery cases total ${usd(e.pendingRecoveryCents)}. These refunds are not available to spend.`,
      nextStep: "Open Recovery to inspect merchant confirmation. Requesting a refund does not confirm receipt of money.",
    };
    case "readiness": return {
      summary: `${e.readyKits} complete kits are usable at the primary site; ${e.unreceivedOrders} orders have not been received or cancelled.`,
      nextStep: "Review the site's recipe and stock. Paid or fulfilled orders are not usable inventory until pantry receipt.",
    };
    case "evidence": return {
      summary: `${e.recordedKits} recorded kit distributions; ${e.receivedShipments} received shipments; ${e.readyKits} complete kits currently on hand.`,
      nextStep: "Inspect receipt and distribution records. Synthetic records do not establish physical delivery or community impact.",
    };
  }
}
