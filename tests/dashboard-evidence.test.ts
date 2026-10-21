import { expect, it, vi, afterEach } from "vitest";
import { seedWorkspace } from "@/lib/seed";
import { view } from "@/lib/commands";
import { dashboardEvidence, evidenceBrief, recommendedFocus } from "@/lib/dashboard-evidence";

afterEach(() => vi.unstubAllEnvs());
function fixture() {
  vi.stubEnv("APP_ENV", "local");
  vi.stubEnv("STORAGE_MODE", "local");
  vi.stubEnv("PAYMENTS_MODE", "simulation");
  vi.stubEnv("AI_MODE", "manual");
  return seedWorkspace();
}
it("provides scoped, factual manual evidence without requiring a model", () => {
  const w = fixture();
  const facts = dashboardEvidence(view(w, "finance-a"));
  expect(facts).toMatchObject({ availableCents: 60000, reservedCents: 0, readyKits: 10, recordedKits: 0, receivedShipments: 0 });
  const brief = evidenceBrief("funds", facts);
  expect(brief.summary).toContain("$600.00");
  expect(brief.summary).toContain("$0.00 reserved");
  expect(brief.nextStep).toContain("approval");
  expect(w.agentRuns).toEqual([]);
});
it("excludes names, notes, merchant mappings and other organizations", () => {
  const w = fixture();
  w.organizations[0].name = "PRIVATE-NONPROFIT";
  w.kits[0].name = "PRIVATE-KIT";
  const a = dashboardEvidence(view(w, "finance-a"));
  const b = dashboardEvidence(view(w, "owner-b"));
  expect(JSON.stringify(a)).not.toContain("PRIVATE-");
  expect(Object.keys(a).sort()).toEqual(["availableCents", "pendingRecoveryCases", "pendingRecoveryCents", "readyKits", "receivedShipments", "recordedKits", "reservedCents", "unreceivedOrders"].sort());
  expect(b.availableCents).not.toBe(a.availableCents);
});
it("separates pending recovery from available funds and prioritizes its review", () => {
  const facts = { availableCents: 24800, reservedCents: 0, pendingRecoveryCents: 3600, pendingRecoveryCases: 1, readyKits: 0, recordedKits: 0, receivedShipments: 0, unreceivedOrders: 2 };
  const brief = evidenceBrief("recovery", facts);
  expect(brief.summary).toContain("$36.00");
  expect(brief.summary).toContain("not available");
  expect(recommendedFocus(facts)).toBe("recovery");
  expect(facts.availableCents).toBe(24800);
});
it("keeps received, ready and distributed evidence distinct", () => {
  const facts = { availableCents: 22250, reservedCents: 0, pendingRecoveryCents: 0, pendingRecoveryCases: 0, readyKits: 0, recordedKits: 50, receivedShipments: 3, unreceivedOrders: 0 };
  const brief = evidenceBrief("evidence", facts);
  expect(brief.summary).toContain("50 recorded");
  expect(brief.summary).toContain("3 received");
  expect(brief.nextStep).toContain("physical");
  expect(evidenceBrief("readiness", facts).summary).toContain("0 complete kits");
});
