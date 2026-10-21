import { timingSafeEqual } from "node:crypto";
import { serviceClient } from "@/lib/auth";
import { paymentAction } from "@/lib/payments";
import { withWorkspace } from "@/lib/storage";
import { respond } from "@/lib/http";
import { AppError, ensure } from "@/lib/errors";
import type { Workspace } from "@/lib/types";
export const maxDuration = 60;

function candidates(w: Workspace) {
  const staff = (org: string) => w.actors.find(a =>
    a.organizationId === org && ["owner", "finance"].includes(a.role));
  const orders = w.orders.filter(o => o.providerId &&
    ["awaiting_payer", "uncertain"].includes(o.status)).map(o => ({
      key: `order:${o.id}`, id: o.id, actorId: staff(o.organizationId)?.id,
    }));
  const donations = w.donations.filter(d => (d.providerId || d.refundId) &&
    ["awaiting_payer", "uncertain", "refund_pending"].includes(d.status)).map(d => ({
      key: `donation:${d.id}`, id: d.id, actorId: staff(d.organizationId)?.id,
    }));
  const recoveries = w.recoveries.filter(r => r.refundId &&
    r.status === "refund_pending").map(r => {
      const order = w.orders.find(o => o.id === r.orderId);
      const actor = order && w.actors.find(a => a.role === "supplier" &&
        a.organizationId === r.organizationId && a.supplierId === order.supplierId);
      return { key: `recovery:${r.id}`, id: r.id, actorId: actor?.id };
    });
  const subscriptions = w.subscriptions.filter(s => s.providerId &&
    s.status === "awaiting_payer").map(s => ({
      key: `subscription:${s.id}`, id: s.id, actorId: staff(s.organizationId)?.id,
    }));
  return [...orders, ...donations, ...recoveries, ...subscriptions]
    .sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

function outcome(subject: Awaited<ReturnType<typeof paymentAction>>) {
  if ("refundStatus" in subject && subject.refundStatus === "failed") return "failed";
  if (["paid", "confirmed", "refund_confirmed", "refunded"].includes(subject.status))
    return "confirmed";
  if (["awaiting_payer", "uncertain", "refund_pending"].includes(subject.status))
    return "pending";
  if (subject.status === "refund_failed") return "failed";
  if (["active", "cancelled", "suspended"].includes(subject.status)) return subject.status;
  return "needs_review";
}

export async function POST(request: Request) {
  return respond(async () => {
    const started = Date.now();
    const configured = process.env.RECONCILE_TOKEN;
    ensure(configured && configured.length >= 32, "RECONCILE_CONFIG",
      "Reconciliation job is not configured.", 503);
    const supplied = request.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1] || "";
    const a = Buffer.from(configured), b = Buffer.from(supplied);
    ensure(a.length === b.length && timingSafeEqual(a, b), "AUTH",
      "Reconciliation authorization failed.", 401);

    // Null-first JSON ordering reaches unscanned records beyond any former 100-row
    // prefix. ISO timestamps and id ties give deterministic least-recent scans.
    const client = serviceClient();
    const [scan, latest] = await Promise.all([
      client.from("workspaces").select("id")
        .order("payload->>reconcileScannedAt", { ascending: true, nullsFirst: true })
        .order("id", { ascending: true }).limit(1),
      client.from("workspaces").select("reconcileScannedAt:payload->>reconcileScannedAt")
        .order("payload->>reconcileScannedAt", { ascending: false, nullsFirst: false })
        .limit(1),
    ]);
    ensure(!scan.error && !latest.error, "PERSISTENCE", "Workspace read unavailable.", 503);
    const data = scan.data;
    const latestValue = latest.data?.[0]?.reconcileScannedAt;
    const latestScan = typeof latestValue === "string" ? Date.parse(latestValue) : 0;
    ensure(Number.isFinite(latestScan), "PERSISTENCE", "Scan progress is invalid.", 503);
    const workspaceId: string | null = data?.[0]?.id ?? null;
    const results: { id: string; status: string; readback: string;
      domainStatus?: string; reason?: string }[] = [];
    const attempted = new Set<string>();
    let candidateCount = 0;
    if (workspaceId) {
      ensure(/^[a-zA-Z0-9-]{1,80}$/.test(workspaceId), "PERSISTENCE",
        "Workspace identifier is invalid.", 503);
      for (let slot = 0; slot < 4; slot++) {
        if (slot > 0 && Date.now() - started >= 25000) break;
        const candidate = await withWorkspace(workspaceId, w => {
          ensure(w.id === workspaceId, "PERSISTENCE", "Workspace identity mismatch.", 503);
          const all = candidates(w);
          if (slot === 0) {
            candidateCount = all.length;
            const previousScan = Date.parse(w.reconcileScannedAt || "");
            // Advance beyond the persisted global maximum as well as local time,
            // so clock skew cannot leave future-dated workspaces unvisited.
            w.reconcileScannedAt = new Date(Math.max(Date.now(), latestScan + 1,
              Number.isFinite(previousScan) ? previousScan + 1 : 0)).toISOString();
          }
          if (Date.now() - started >= 25000) return undefined;
          const eligible = all.filter(c => !attempted.has(c.key));
          const next = eligible.find(c => c.key > (w.reconcileCursor || "")) ?? eligible[0];
          // Persist each actual dispatch before readback, including failed/missing
          // actors. Unstarted candidates are never advanced past the time cutoff.
          if (next) w.reconcileCursor = next.key;
          return next;
        });
        if (!candidate) break;
        attempted.add(candidate.key);
        if (!candidate.actorId) {
          results.push({ id: candidate.id, status: "needs_review",
            readback: "not_started", reason: "actor_unavailable" });
          continue;
        }
        try {
          const subject = await paymentAction({ workspaceId, actorId: candidate.actorId,
            expiresAt: Date.now() + 60000, nonce: "authorized-readback-job" },
          candidate.id, "reconcile");
          results.push({ id: candidate.id, status: outcome(subject),
            readback: "completed", domainStatus: subject.status });
        } catch (error) {
          results.push({ id: candidate.id,
            status: error instanceof AppError && error.code === "PAYMENT_PENDING" ? "pending" : "needs_review",
            readback: "unresolved" });
        }
      }
    }
    return { readOnlyProviderCalls: true, workspaceId, examined: results.length,
      candidateCount, remaining: Math.max(0, candidateCount - results.length),
      remainingScope: "selected_workspace", results };
  });
}
