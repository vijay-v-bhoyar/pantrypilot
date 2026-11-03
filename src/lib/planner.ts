import { createHash, randomUUID } from "node:crypto";
import { ensure } from "./errors";
import { balances } from "./money";
import { usableUnits } from "./inventory";
import type { Proposal, PurchaseRequest, Workspace } from "./types";
export const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function stockDigest(w: Workspace, request: PurchaseRequest) {
  return digest({
    stock: w.inventory.filter(
      (l) =>
        l.organizationId === request.organizationId &&
        l.siteId === request.siteId,
    ),
    catalog: w.catalog,
    suppliers: w.suppliers,
    kit: w.kits.find((k) => k.id === request.kitId),
    reservations: w.stockReservations,
  });
}
export function kitReadiness(
  w: Workspace,
  organizationId: string,
  siteId: string,
  kitId: string,
) {
  const kit = w.kits.find(
    (k) => k.id === kitId && k.organizationId === organizationId,
  );
  ensure(kit && kit.components.length, "KIT", "Kit not found.");
  return Math.min(
    ...kit.components.map((c) =>
      Math.floor(usableUnits(w, organizationId, siteId, c.sku) / c.quantity),
    ),
  );
}
// Exhaustively search bounded integer-pack allocations, including split suppliers.
// A search limit is an explicit error, never a claim that a basket is infeasible.
export function plan(
  w: Workspace,
  request: PurchaseRequest,
  preferredIds?: string[],
  evaluationTime?: number,
): Proposal {
  const kit = w.kits.find(
    (k) =>
      k.id === request.kitId && k.organizationId === request.organizationId,
  );
  const fund = w.funds.find(
    (f) =>
      f.id === request.fundId && f.organizationId === request.organizationId,
  );
  ensure(
    kit && fund,
    "SCOPE",
    "Kit and fund must belong to the requesting nonprofit.",
  );
  ensure(
    !fund.restricted || fund.purpose === kit.id,
    "RESTRICTION",
    "This restricted fund cannot purchase another kit.",
  );
  ensure(
    kit.components.length <= 8,
    "LIMIT",
    "At most eight component types per kit.",
  );
  ensure(evaluationTime === undefined || Number.isFinite(evaluationTime), "EVAL_CONFIG", "Invalid planning timestamp.");
  const planningTime = evaluationTime ?? Date.now();
  const today = new Date(planningTime).toISOString().slice(0, 10);
  const days = Math.floor(
    (Date.parse(request.deadline + "T23:59:59Z") - planningTime) / 86400000,
  );
  const shortages: string[] = [];
  const explanations: string[] = [];
  let examined = 0;
  const examine = () => ensure(
    ++examined <= 60000,
    "PLANNER_LIMIT",
    "The complete supplier search exceeds this planner's limit. Narrow the approved offers or request; no infeasibility decision was made.",
  );
  const groups = kit.components
    .map((c) => {
      const stocked = usableUnits(
        w,
        request.organizationId,
        request.siteId,
        c.sku,
        today,
      );
      const required = Math.max(0, request.target * c.quantity - stocked);
      explanations.push(
        `${c.name}: ${stocked} usable units in stock, ${required} additional units required.`,
      );
      if (!required) return [];
      const offers = w.catalog
        .filter(
          (i) =>
            i.sku === c.sku &&
            w.suppliers.some(
              (s) =>
                s.id === i.supplierId &&
                s.organizationIds.includes(request.organizationId),
            ) &&
            i.deliveryDays <= days &&
            (!i.expiresAt || i.expiresAt >= request.deadline) &&
            c.attributes.every((a) => i.attributes.includes(a)) &&
            i.availablePacks > 0 &&
            (!preferredIds || preferredIds.includes(i.id)),
        )
        .sort((a, b) => a.price * b.packSize - b.price * a.packSize || a.id.localeCompare(b.id));
      ensure(offers.length <= 64, "PLANNER_LIMIT",
        "More than 64 approved offers match one component. Narrow the offers; none were silently discarded.");
      const capacity = new Array<number>(offers.length + 1).fill(0);
      for (let i = offers.length - 1; i >= 0; i--) {
        capacity[i] = capacity[i + 1] + offers[i].availablePacks * offers[i].packSize;
      }
      if (capacity[0] < required) {
        shortages.push(
          `${c.name}: approved offers together cannot satisfy quantity, delivery and product attributes.`,
        );
        return [];
      }
      // For a fixed supplier set, only its cheapest complete allocation can
      // improve the basket: shipping is shared across all component types.
      const allocations = new Map<string, { lines: Proposal["lines"]; cost: number }>();
      const allocate = (index: number, remaining: number, lines: Proposal["lines"], cost: number) => {
        examine();
        if (remaining <= 0) {
          const suppliers = JSON.stringify([...new Set(lines.map(l => l.supplierId))].sort());
          const previous = allocations.get(suppliers);
          if (!previous || cost < previous.cost) allocations.set(suppliers, { lines, cost });
          return;
        }
        if (index === offers.length || capacity[index] < remaining) return;
        const item = offers[index];
        const maximum = Math.min(item.availablePacks, Math.ceil(remaining / item.packSize));
        const minimum = Math.max(0, Math.ceil((remaining - capacity[index + 1]) / item.packSize));
        for (let packs = maximum; packs >= minimum; packs--) {
          const line = {
            catalogId: item.id, supplierId: item.supplierId, sku: item.sku, name: item.name,
            packs, units: packs * item.packSize, unitPrice: item.price, cost: packs * item.price,
            version: item.version,
          };
          allocate(index + 1, remaining - line.units, packs ? [...lines, line] : lines, cost + line.cost);
        }
      };
      allocate(0, required, [], 0);
      return [...allocations.values()].map(a => a.lines);
    })
    .filter((g) => g.length);
  let best: Proposal["lines"] = [];
  let bestTotal = Infinity;
  let bestShipping = 0;
  const visit = (index: number, lines: Proposal["lines"]) => {
    examine();
    if (index < groups.length) {
      for (const allocation of groups[index]) visit(index + 1, [...lines, ...allocation]);
      return;
    }
    const shipping = [...new Set(lines.map((l) => l.supplierId))].reduce(
      (s, id) => s + w.suppliers.find((x) => x.id === id)!.shipping,
      0,
    );
    const total = lines.reduce((s, l) => s + l.cost, 0) + shipping;
    if (total < bestTotal) {
      best = lines;
      bestTotal = total;
      bestShipping = shipping;
    }
  };
  visit(0, []);
  const ceiling = Math.min(request.budget, balances(w, fund.id).available);
  if (bestTotal > ceiling)
    shortages.push(
      `The complete basket costs ${(bestTotal / 100).toFixed(2)} USD, above the available budget of ${(ceiling / 100).toFixed(2)} USD.`,
    );
  explanations.push(
    `Compared ${examined} bounded allocation/search states across all matching offers; shipping is charged once per supplier. Unknown product suitability is never inferred.`,
  );
  const result = {
    id: randomUUID(),
    organizationId: request.organizationId,
    requestId: request.id,
    fundId: fund.id,
    lines: best,
    shipping: bestShipping,
    total: bestTotal,
    shortages,
    explanations,
    source: "deterministic" as const,
    stockDigest: stockDigest(w, request),
    digest: "",
    createdAt: new Date(planningTime).toISOString(),
  };
  result.digest = digest({
    request,
    lines: best,
    shipping: bestShipping,
    total: bestTotal,
    stock: result.stockDigest,
    source: result.source,
  });
  return result;
}
