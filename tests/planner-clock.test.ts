import { afterEach, expect, it, vi } from "vitest";
import { seedWorkspace } from "../src/lib/seed";
import { execute } from "../src/lib/commands";
import { plan } from "../src/lib/planner";
import { plannerCases } from "../scripts/lib/planner-evaluation";
import type { PurchaseRequest } from "../src/lib/types";
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
it("IMP-T01 frozen fixture planning stays equivalent across twelve days while default and safety clocks move", () => {
  vi.stubEnv("APP_ENV", "local"); vi.stubEnv("STORAGE_MODE", "local");
  vi.stubEnv("PAYMENTS_MODE", "simulation"); vi.stubEnv("FINANCIAL_ACTIONS_ENABLED", "false");
  vi.stubEnv("PROVIDER_ACTIONS_ENABLED", "false");
  vi.useFakeTimers(); const fixed = Date.UTC(2026, 9, 27, 12); vi.setSystemTime(fixed);
  const workspace = seedWorkspace();
  for (const fixture of plannerCases(fixed)) {
    vi.setSystemTime(fixed);
    const request = execute(workspace, "owner-a", "request", { siteId: fixture.siteId, kitId: fixture.kitId,
      fundId: fixture.fundId, target: fixture.target, budget: fixture.budget, deadline: fixture.deadline,
      notes: fixture.notes }, `fixture-${fixture.case}`) as PurchaseRequest;
    const reference = plan(workspace, request, undefined, fixed);
    for (let day = 0; day < 12; day++) {
      vi.setSystemTime(fixed + day * 86400000);
      const candidate = plan(workspace, request, undefined, fixed);
      expect({ ...candidate, id: "normalized" }).toEqual({ ...reference, id: "normalized" });
      expect(Date.now()).toBe(fixed + day * 86400000);
    }
    expect(plan(workspace, request).createdAt).toBe(new Date(Date.now()).toISOString());
  }
});
it("IMP-T01 rejects invalid fixture clocks without changing default planner behavior", () => {
  const workspace = seedWorkspace(); const request = { ...plannerCases(Date.now())[0], id: "request",
    organizationId: "hope", createdAt: new Date().toISOString() } as PurchaseRequest;
  for (const value of [NaN, Infinity, -Infinity]) expect(() => plan(workspace, request, undefined, value)).toThrow();
});
