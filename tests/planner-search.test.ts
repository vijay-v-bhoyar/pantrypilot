import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { execute } from "@/lib/commands";
import { plan } from "@/lib/planner";
import { seedWorkspace } from "@/lib/seed";
import type { CatalogItem, Order, Proposal, PurchaseRequest, Supplier, Workspace } from "@/lib/types";

beforeEach(() => {
  vi.stubEnv("APP_ENV", "local");
  vi.stubEnv("STORAGE_MODE", "local");
  vi.stubEnv("PAYMENTS_MODE", "simulation");
  vi.stubEnv("FINANCIAL_ACTIONS_ENABLED", "true");
  vi.stubEnv("PROVIDER_ACTIONS_ENABLED", "false");
});
afterEach(() => vi.unstubAllEnvs());

function workspace() {
  const w = seedWorkspace();
  w.inventory = [];
  w.catalog = [];
  w.kits[0].components = [{ sku: "rice", name: "Rice", quantity: 1, attributes: ["shelf-stable"] }];
  return w;
}
function supplier(w: Workspace, shipping = 0) {
  const s = execute(w, "owner-a", "supplier", { name: "Review supplier", shipping }, randomUUID()) as Supplier;
  const actorId = randomUUID();
  w.actors.push({ id: actorId, name: "Review supplier", role: "supplier", organizationId: "hope", supplierId: s.id });
  return actorId;
}
function offer(w: Workspace, actor: string, price: number, availablePacks = 10, packSize = 1, sku = "rice") {
  return execute(w, actor, "catalogCreate", {
    sku, name: sku, unit: "unit", packSize, price, availablePacks, deliveryDays: 1, attributes: ["shelf-stable"],
  }, randomUUID()) as CatalogItem;
}
function request(w: Workspace, target = 10, budget = 2000) {
  return execute(w, "coordinator-a", "request", {
    siteId: "hope-main", kitId: "kit-hope", fundId: "hope-kits", target, budget,
    deadline: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10), notes: "",
  }, randomUUID()) as PurchaseRequest;
}

it("finds an affordable seventh supplier independent of catalog insertion order", () => {
  const w = workspace();
  for (let i = 0; i < 7; i++) offer(w, supplier(w), i === 6 ? 100 : 1000);
  const r = request(w);
  for (let i = 0; i < w.catalog.length; i++) {
    const p = plan(w, r);
    expect(p.shortages).toEqual([]);
    expect(p.total).toBe(1000);
    w.catalog.push(w.catalog.shift()!);
  }
});

it("splits a shortage across suppliers and preserves exact approval, shipping and checkout stock", () => {
  const w = workspace();
  const a = offer(w, supplier(w, 100), 150, 3, 2);
  const b = offer(w, supplier(w, 200), 160, 3, 2);
  const r = request(w, 10, 1100);
  const p = execute(w, "coordinator-a", "propose", { id: r.id }, randomUUID()) as Proposal;
  expect(p.shortages).toEqual([]);
  expect(p.total).toBe(1070);
  expect(p.shipping).toBe(300);
  expect(p.lines.map(l => [l.catalogId, l.packs])).toEqual([[a.id, 3], [b.id, 2]]);
  expect(() => execute(w, "coordinator-a", "approve", { id: p.id }, randomUUID())).toThrow();
  const approval = execute(w, "finance-a", "approve", { id: p.id }, randomUUID()) as { id: string };
  const orders = execute(w, "finance-a", "checkout", { id: approval.id }, randomUUID()) as Order[];
  expect(orders).toHaveLength(2);
  expect(orders.reduce((sum, order) => sum + order.total, 0)).toBe(1070);
  expect([a.availablePacks, b.availablePacks]).toEqual([0, 1]);
});

it("optimizes shipping across component types rather than choosing each cheapest unit price", () => {
  const w = workspace();
  w.kits[0].components.push({ sku: "beans", name: "Beans", quantity: 1, attributes: ["shelf-stable"] });
  const common = supplier(w, 80);
  offer(w, common, 100); offer(w, common, 100, 10, 1, "beans");
  offer(w, supplier(w, 90), 60); offer(w, supplier(w, 90), 60, 10, 1, "beans");
  const p = plan(w, request(w, 1));
  expect(p.shortages).toEqual([]);
  expect(p.total).toBe(280);
  expect(p.shipping).toBe(80);
  expect(new Set(p.lines.map(l => l.supplierId)).size).toBe(1);
});

it("reports genuine aggregate shortages and keeps selected-offer, attributes and delivery restrictions", () => {
  const w = workspace();
  const a = offer(w, supplier(w), 100, 4);
  const b = offer(w, supplier(w), 100, 5);
  const r = request(w);
  expect(plan(w, r).shortages).not.toEqual([]);
  b.availablePacks = 6;
  expect(plan(w, r).shortages).toEqual([]);
  expect(plan(w, r, [a.id]).shortages).not.toEqual([]);
  b.attributes = [];
  expect(plan(w, r).shortages).not.toEqual([]);
  b.attributes = ["shelf-stable"]; b.deliveryDays = 90;
  expect(plan(w, r).shortages).not.toEqual([]);
});

it("matches an exhaustive integer-pack oracle for small multi-supplier baskets", () => {
  for (let scenario = 0; scenario < 12; scenario++) {
    const w = workspace();
    w.kits[0].components.push({ sku: "beans", name: "Beans", quantity: 1, attributes: ["shelf-stable"] });
    for (let s = 0; s < 3; s++) {
      const actor = supplier(w, (scenario * 7 + s * 23) % 90);
      for (const [i, sku] of ["rice", "beans"].entries()) {
        offer(w, actor, 30 + (scenario * 13 + s * 31 + i * 17) % 100, 2, 1 + (s + i + scenario) % 2, sku);
      }
    }
    let optimum = Infinity;
    for (let code = 0; code < 3 ** w.catalog.length; code++) {
      let digits = code, cost = 0;
      const units: Record<string, number> = { rice: 0, beans: 0 }, used = new Set<string>();
      for (const item of w.catalog) {
        const packs = digits % 3; digits = Math.floor(digits / 3);
        units[item.sku] += packs * item.packSize; cost += packs * item.price;
        if (packs) used.add(item.supplierId);
      }
      if (units.rice < 3 || units.beans < 3) continue;
      for (const id of used) cost += w.suppliers.find(s => s.id === id)!.shipping;
      optimum = Math.min(optimum, cost);
    }
    const p = plan(w, request(w, 3));
    expect(p.shortages).toEqual([]);
    expect(p.total).toBe(optimum);
  }
});

it("keeps search limits explicit and never saves an incomplete search as an infeasible proposal", () => {
  for (const count of [12, 65]) {
    const w = workspace();
    for (let i = 0; i < count; i++) offer(w, supplier(w), 100);
    const r = request(w);
    expect(() => execute(w, "coordinator-a", "propose", { id: r.id }, randomUUID()))
      .toThrow(expect.objectContaining({ code: "PLANNER_LIMIT" }));
    expect(w.proposals).toEqual([]);
  }
});

it("prices the standard demo from its exact pack quantities and once-per-supplier shipping", () => {
  const w = seedWorkspace();
  const p = plan(w, request(w, 50, 60000));
  expect(p.lines.map(l => [l.catalogId, l.packs])).toEqual([
    ["harvest-rice", 5], ["supply-rice", 1],
    ["harvest-beans", 5], ["supply-beans", 2],
    ["supply-oats", 7], ["supply-soap", 5],
  ]);
  expect(p.total).toBe(5 * 1800 + 1650 + 5 * 1320 + 2 * 1200 + 7 * 1080 + 5 * 1120 + 800 + 1200);
  expect(p.total).toBe(34810);
});
