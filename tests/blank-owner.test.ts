import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { ownedWorkspace } from "@/lib/enrollment";
import { seedWorkspace } from "@/lib/seed";
import { execute, view } from "@/lib/commands";
import type { Workspace } from "@/lib/types";

let w: Workspace;
beforeEach(() => {
  for (const [key, value] of Object.entries({ APP_ENV: "local", VERCEL: "", STORAGE_MODE: "local", PAYMENTS_MODE: "simulation", PROVIDER_ACTIONS_ENABLED: "false", FINANCIAL_ACTIONS_ENABLED: "true", AI_MODE: "manual" })) vi.stubEnv(key, value);
  w = ownedWorkspace("synthetic-owner-id");
});
afterEach(() => vi.unstubAllEnvs());
const run = <T>(name: string, data: unknown, actor?: string) => execute(w, actor ?? w.actors[0].id, name, data, randomUUID()) as T;
it("starts new owners fully blank and does not alter existing demo data", () => {
  const demo = seedWorkspace(), original = structuredClone(demo); ownedWorkspace("another-owner"); expect(demo).toEqual(original);
  expect(w.organizations).toHaveLength(1); expect(w.organizations[0].sites).toEqual([]); expect(w.demo).toBe(false);
  for (const field of ["funds", "kits", "inventory", "ledger", "campaigns", "orders", "distributions", "requests", "suppliers", "catalog"] as const) expect(w[field]).toEqual([]);
  const projected = view(w, w.actors[0].id); expect(projected.available).toEqual({}); expect(projected.reserved).toEqual({});
});
it.each(["inventory", "request", "distribute", "campaign"])("denies stale seeded references on blank-owner %s", name => {
  const data = name === "inventory" ? { siteId: "hope-main", sku: "rice", name: "Rice", quantity: 1 }
    : name === "campaign" ? { title: "First campaign", description: "Purpose", goal: 10000, targetKits: 10, kitId: "kit-hope", restricted: true }
      : name === "distribute" ? { siteId: "hope-main", kitId: "kit-hope", quantity: 1 }
        : { siteId: "hope-main", kitId: "kit-hope", fundId: "hope-kits", target: 10, budget: 10000, deadline: "2027-01-01", notes: "" };
  const original = structuredClone(w); expect(() => run(name, data)).toThrow(); expect(w).toEqual(original);
});
it("supports first site then kit then campaign/fund without inventing money, suppliers or paid receipts", () => {
  const site = run<{ id: string }>("site", { name: "Our first pantry" });
  const kit = run<{ id: string }>("kit", { name: "Our food kit", components: [{ sku: "rice", name: "Rice", quantity: 2, attributes: ["shelf-stable"] }] });
  const campaign = run<{ id: string; fundId: string }>("campaign", { title: "Our campaign", description: "Food support", goal: 10000, targetKits: 10, kitId: kit.id, restricted: true });
  run("campaignStatus", { id: campaign.id, status: "published" });
  run("inventory", { siteId: site.id, sku: "rice", name: "Rice", quantity: 10 });
  run("distribute", { siteId: site.id, kitId: kit.id, quantity: 1 });
  expect(w.funds).toHaveLength(1); expect(w.funds[0].purpose).toBe(kit.id);
  expect(w.ledger).toEqual([]); expect(w.orders).toEqual([]); expect(w.suppliers).toEqual([]); expect(w.donations).toEqual([]);
  expect(view(w, w.actors[0].id).available[campaign.fundId]).toBe(0);
});
it("denies non-owner site creation and cross-organization kit references", () => {
  w.actors.push({ id: "coordinator", name: "Coordinator", role: "coordinator", organizationId: "hope" });
  expect(() => run("site", { name: "Denied" }, "coordinator")).toThrow("role");
  run("site", { name: "Our site" }); const foreign = seedWorkspace().kits[0]; foreign.organizationId = "other"; w.kits.push(foreign);
  expect(() => run("campaign", { title: "Bad", description: "Wrong purpose", goal: 100, targetKits: 1, kitId: foreign.id, restricted: true })).toThrow("not found");
});
