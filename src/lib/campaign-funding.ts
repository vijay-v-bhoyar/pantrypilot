import type { Campaign, Workspace } from "./types";

export function campaignReceived(
  workspace: Pick<Workspace, "ledger" | "donations">,
  campaign: Campaign,
) {
  const donationIds = new Set(
    workspace.donations
      .filter(
        (donation) =>
          donation.organizationId === campaign.organizationId &&
          donation.campaignId === campaign.id &&
          donation.fundId === campaign.fundId,
      )
      .map((donation) => donation.id),
  );
  return workspace.ledger
    .filter(
      (entry) =>
        entry.organizationId === campaign.organizationId &&
        entry.fundId === campaign.fundId &&
        (entry.kind === "donation" ||
          entry.kind === "donation_refund" ||
          (entry.kind === "reversal" && donationIds.has(entry.subjectId))),
    )
    .reduce((total, entry) => total + entry.amount, 0);
}
