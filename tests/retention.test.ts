import { execute } from "@/lib/commands";
import { randomUUID } from "node:crypto";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { seedWorkspace } from "@/lib/seed";
import { archiveEligible } from "@/lib/retention";
it("archives only inactive synthetic workspaces without provider evidence", () => {
  const w = seedWorkspace();
  expect(archiveEligible(w)).toBe(false);
  w.updatedAt = new Date(Date.now() - 8 * 86400000).toISOString();
  expect(archiveEligible(w)).toBe(true);
  w.demo = false;
  expect(archiveEligible(w)).toBe(false);
  w.demo = true;
  w.ledger[0].evidence = "paypal_sandbox";
  expect(archiveEligible(w)).toBe(false);
});
it("keeps unknown or in-flight provider operations for reconciliation", () => {
  const w = seedWorkspace();
  w.updatedAt = new Date(Date.now() - 8 * 86400000).toISOString();
  w.paymentOperations.push({
    id: "op",
    subjectId: "gift",
    action: "capture",
    profile: "hope",
    requestId: "request",
    status: "uncertain",
    createdAt: w.updatedAt,
  });
  expect(archiveEligible(w)).toBe(false);
  w.paymentOperations = [];
  w.updatedAt = "invalid";
  expect(archiveEligible(w)).toBe(false);
});

// Proposed append to tests/retention.test.ts after approval.
// Add beforeEach/afterEach/vi to the existing Vitest import and import execute
// from @/lib/commands and randomUUID from node:crypto.
beforeEach(() => {
  for (const [name,value] of Object.entries({ APP_ENV:"local", VERCEL:"", STORAGE_MODE:"local", PAYMENTS_MODE:"simulation", AI_MODE:"manual", PROVIDER_ACTIONS_ENABLED:"false", FINANCIAL_ACTIONS_ENABLED:"true" })) vi.stubEnv(name,value);
});
afterEach(() => vi.unstubAllEnvs());
function pendingCheckout() {
  const w = seedWorkspace();
  const request = execute(w,"coordinator-a","request",{siteId:"hope-main",kitId:"kit-hope",fundId:"hope-kits",target:50,budget:60000,deadline:new Date(Date.now()+7*86400000).toISOString().slice(0,10),notes:"Synthetic retention regression"},randomUUID()) as {id:string};
  const proposal = execute(w,"coordinator-a","propose",{id:request.id},randomUUID()) as {id:string};
  const approval = execute(w,"finance-a","approve",{id:proposal.id},randomUUID()) as {id:string};
  execute(w,"finance-a","checkout",{id:approval.id},randomUUID());
  return w;
}
it.each(["checkout","gift","monthly","recovery"] as const)("keeps stale simulated %s obligations out of archive candidates", (kind) => {
  const w = kind === "checkout" || kind === "recovery" ? pendingCheckout() : seedWorkspace();
  if (kind === "gift") execute(w,"donor","donation",{campaignId:"campaign-hope",amount:2500},randomUUID());
  if (kind === "monthly") {
    const sub = execute(w,"donor","subscription",{campaignId:"campaign-hope",amount:2500},randomUUID()) as {id:string};
    execute(w,"donor","activateSubscription",{id:sub.id},randomUUID());
  }
  if (kind === "recovery") {
    const order = w.orders.find(o=>o.supplierId==="harvest")!;
    execute(w,"finance-a","capture",{id:order.id},randomUUID());
    execute(w,"supplier-a","partialCancel",{id:order.id,catalogId:order.lines.find(l=>l.sku==="rice")!.catalogId,packs:2,reason:"Synthetic shortage"},randomUUID());
  }
  w.updatedAt = new Date(Date.now()-8*86400000).toISOString();
  expect(w.paymentOperations).toHaveLength(0);
  expect(archiveEligible(w)).toBe(false);
});
it("permits an old fully received simulated checkout with released stock obligations", () => {
  const w = pendingCheckout();
  for (const order of w.orders) {
    execute(w,"finance-a","capture",{id:order.id},randomUUID());
    const supplier = order.supplierId === "harvest" ? "supplier-a" : "supplier-b";
    execute(w,supplier,"fulfill",{id:order.id,status:"fulfilled"},randomUUID());
    execute(w,"coordinator-a","receive",{id:order.id},randomUUID());
  }
  expect(w.orders.every(o=>o.status==="received")).toBe(true);
  expect(w.stockReservations.every(r=>r.released)).toBe(true);
  w.updatedAt = new Date(Date.now()-8*86400000).toISOString();
  expect(archiveEligible(w)).toBe(true);
});
