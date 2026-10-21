import { randomUUID } from "node:crypto";
import { seedWorkspace } from "./seed";

export function ownedWorkspace(userId: string) {
  const w = seedWorkspace(randomUUID(), userId);
  const actorId = randomUUID();
  w.demo = false;
  w.actors = [
    {
      id: actorId,
      name: "Pantry owner",
      role: "owner",
      organizationId: "hope",
    },
  ];
  w.organizations = w.organizations.filter((o) => o.id === "hope");
  w.organizations[0].name = "My community pantry";
  w.organizations[0].description =
    "Set your organization details before publishing a campaign.";
  w.organizations[0].merchantProfile = `org-${w.id}`;
  w.organizations[0].sites = [];
  w.campaigns = [];
  w.funds = [];
  w.kits = [];
  w.inventory = [];
  w.suppliers = [];
  w.catalog = [];
  w.ledger = [];
  return w;
}
