import { randomUUID } from "node:crypto";
import { z } from "zod";
import { digest } from "./planner";
import { ensure } from "./errors";
import type { Workspace } from "./types";
export function snapshot(w: Workspace) {
  return { format: "pantrypilot-demo-v1", sha256: digest(w), workspace: w };
}
export function restoreDemo(raw: unknown): Workspace {
  const file = z
    .object({
      format: z.literal("pantrypilot-demo-v1"),
      sha256: z.string().length(64),
      workspace: z.record(z.string(), z.unknown()),
    })
    .strict()
    .parse(raw);
  ensure(
    file.sha256 === digest(file.workspace),
    "CHECKSUM",
    "Snapshot checksum does not match.",
  );
  const w = structuredClone(file.workspace) as unknown as Workspace;
  ensure(
    w.demo === true,
    "RESTORE_SCOPE",
    "This restore command supports isolated synthetic demos only.",
  );
  const arrays = [
    "actors",
    "organizations",
    "campaigns",
    "funds",
    "ledger",
    "suppliers",
    "catalog",
    "inventory",
    "kits",
    "requests",
    "proposals",
    "approvals",
    "orders",
    "donations",
    "subscriptions",
    "recoveries",
    "audit",
    "distributions",
    "paymentOperations",
    "providerEvents",
    "agentRuns",
    "dashboards",
    "invitations",
    "stockReservations",
  ] as const;
  for (const key of arrays)
    ensure(
      Array.isArray(w[key]) && w[key].length <= 100000,
      "SNAPSHOT",
      "Snapshot structure is invalid.",
    );
  ensure(
    w.actors.length > 0 &&
      w.organizations.length > 0 &&
      typeof w.idempotency === "object" &&
      w.idempotency !== null,
    "SNAPSHOT",
    "Snapshot membership is invalid.",
  );
  ensure(
    w.ledger.every((l) => l.evidence === "simulation") &&
      [...w.orders, ...w.donations, ...w.subscriptions].every(
        (p) => p.evidence === "simulation" && !p.providerId,
      ) &&
      w.providerEvents.length === 0 &&
      w.paymentOperations.length === 0,
    "RESTORE_SCOPE",
    "Provider-backed workspaces require operator reconciliation; they cannot be cloned as demos.",
  );
  w.id = randomUUID();
  w.ownerId = "local-restored-demo";
  w.revision = 0;
  w.updatedAt = new Date().toISOString();
  w.approvals.forEach((a) => (a.expiresAt = new Date(0).toISOString()));
  w.invitations = [];
  w.idempotency = {};
  return w;
}
