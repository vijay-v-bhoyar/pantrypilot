import { beforeEach, expect, it, vi } from "vitest";
import { GET } from "@/app/api/campaigns/route";
import { execute, post, view } from "@/lib/commands";
import { seedWorkspace } from "@/lib/seed";
import type { Donation, Workspace } from "@/lib/types";

const storage = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("@/lib/storage", () => ({ loadWorkspace: storage.load }));
let workspace: Workspace;
function command<T>(name: string, data: unknown, actor = "owner-a") {
  return execute(workspace, actor, name, data, crypto.randomUUID()) as T;
}
function gift() {
  const donation = command<Donation>(
    "donation",
    { campaignId: "campaign-hope", amount: 2500 },
    "donor",
  );
  command("capture", { id: donation.id }, "donor");
  return donation;
}
async function publicCampaign() {
  const response = await GET(
    new Request(`http://127.0.0.1:3100/api/campaigns?workspace=${workspace.id}`),
  );
  expect(response.status).toBe(200);
  const data = await response.json();
  return data.campaigns.find((c: { id: string }) => c.id === "campaign-hope");
}
beforeEach(() => {
  vi.stubEnv("APP_ENV", "local");
  vi.stubEnv("STORAGE_MODE", "local");
  vi.stubEnv("PAYMENTS_MODE", "simulation");
  vi.stubEnv("FINANCIAL_ACTIONS_ENABLED", "true");
  workspace = seedWorkspace();
  storage.load.mockResolvedValue(workspace);
});

it("shares only campaign aggregates with donors while preserving private ledger isolation", async () => {
  gift();
  const donor = view(workspace, "donor");
  expect(donor.ledger).toEqual([]);
  expect(donor.funds).toEqual([]);
  expect(donor.approvals).toEqual([]);
  expect(donor).toMatchObject({ campaignReceived: { "campaign-hope": 2500 } });
  expect(view(workspace, "owner-a")).toMatchObject({
    campaignReceived: { "campaign-hope": 2500 },
  });
  expect(view(workspace, "owner-b")).toMatchObject({
    campaignReceived: { "campaign-river": 0 },
  });
  expect(await publicCampaign()).toMatchObject({ received: 2500 });
});

it("subtracts only confirmed gift refunds from public and member campaign progress", async () => {
  const donation = gift();
  command("donationRefund", { id: donation.id }, "finance-a");
  expect(await publicCampaign()).toMatchObject({ received: 2500 });
  command("confirmDonationRefund", { id: donation.id }, "finance-a");
  expect(await publicCampaign()).toMatchObject({ received: 0 });
  expect(view(workspace, "donor")).toMatchObject({
    campaignReceived: { "campaign-hope": 0 },
  });
  expect(workspace.ledger.filter((entry) => entry.kind === "donation")).toHaveLength(1);
  expect(workspace.ledger.filter((entry) => entry.kind === "donation_refund")).toHaveLength(1);
});

it("keeps opening funds, promised monthly gifts, spending and supplier refunds out of campaign giving", async () => {
  const donation = gift();
  const subscription = command<{ id: string }>(
    "subscription", { campaignId: "campaign-hope", amount: 2500 }, "donor",
  );
  command("activateSubscription", { id: subscription.id }, "donor");
  for (const [kind, amount] of [["spend", -1200], ["purchase_refund", 1200], ["reversal", 1200]] as const) {
    post(workspace, { organizationId: "hope", fundId: "hope-kits", amount,
      kind, subjectId: "supplier-order", source: "synthetic supplier fixture", evidence: "simulation" });
  }
  expect(await publicCampaign()).toMatchObject({ received: 2500 });
  post(workspace, { organizationId: "hope", fundId: "hope-kits", amount: -2500,
    kind: "reversal", subjectId: donation.id, source: "synthetic donation reversal", evidence: "simulation" });
  expect(await publicCampaign()).toMatchObject({ received: 0 });
  expect(view(workspace, "donor")).toMatchObject({ campaignReceived: { "campaign-hope": 0 } });
});

it("does not publish another organization's funding or donor identity through an aggregate", async () => {
  gift();
  post(workspace, { organizationId: "river", fundId: "hope-kits", amount: 900,
    kind: "donation", subjectId: "malformed-cross-org-fixture", source: "synthetic scope challenge", evidence: "simulation" });
  const campaign = await publicCampaign();
  expect(campaign.received).toBe(2500);
  expect(JSON.stringify(campaign)).not.toContain("Alex");
  expect(campaign).not.toHaveProperty("donorId");
});
