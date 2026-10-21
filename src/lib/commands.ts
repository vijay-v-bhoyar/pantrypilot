import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { configuration } from "./config";
import { ensure } from "./errors";
import { balances, cents } from "./money";
import { campaignReceived } from "./campaign-funding";
import { digest, kitReadiness, plan, stockDigest } from "./planner";
import { dashboardDefinition } from "./dashboard";
import { freeLot } from "./inventory";
import { agentPaused, stopAgents } from "./agent-control";
import { validDate } from "./dates";
import { approveCorrection, proposeCorrection } from "./stock-corrections";
import type {
  Actor,
  AppView,
  LedgerEntry,
  Order,
  Role,
  Workspace,
  StockMovement,
} from "./types";

const id = z.string().min(1).max(80);
const text = z.string().trim().min(1).max(2000);
const quantity = z.number().int().min(1).max(100000);
const amount = z.number().int().min(1).max(10000000);
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(validDate);
const role = z.enum(["owner", "finance", "coordinator", "donor"]);
const schemas = {
  organization: z.object({ name: text.max(120), description: text }).strict(),
  site: z.object({ name: text.max(100) }).strict(),
  campaign: z
    .object({
      title: text.max(160),
      description: text,
      goal: amount,
      targetKits: quantity,
      kitId: id,
      restricted: z.boolean(),
    })
    .strict(),
  campaignStatus: z
    .object({ id, status: z.enum(["published", "closed"]) })
    .strict(),
  request: z
    .object({
      siteId: id,
      kitId: id,
      fundId: id,
      target: quantity.max(1000),
      budget: amount,
      deadline: date,
      notes: z.string().max(2000).default(""),
    })
    .strict(),
  propose: z.object({ id }).strict(),
  approve: z.object({ id }).strict(),
  checkout: z.object({ id }).strict(),
  capture: z.object({ id }).strict(),
  cancelPayment: z.object({ id }).strict(),
  donation: z.object({ campaignId: id, amount }).strict(),
  subscription: z
    .object({
      campaignId: id,
      amount: z.union([
        z.literal(1000),
        z.literal(2500),
        z.literal(5000),
        z.literal(10000),
      ]),
    })
    .strict(),
  activateSubscription: z.object({ id }).strict(),
  billSubscription: z.object({ id, eventId: id }).strict(),
  cancelSubscription: z.object({ id }).strict(),
  donationRefund: z.object({ id }).strict(),
  confirmDonationRefund: z.object({ id }).strict(),
  inventory: z
    .object({
      siteId: id,
      sku: id,
      name: text.max(120),
      quantity,
      expiresAt: date.optional(),
    })
    .strict(),
  import: z
    .object({
      siteId: id,
      rows: z
        .array(
          z
            .object({
              sku: id,
              name: text.max(120),
              quantity,
              expiresAt: date.optional(),
            })
            .strict(),
        )
        .min(1)
        .max(100),
    })
    .strict(),
  adjust: z
    .object({ id, quantity: z.number().int().min(0).max(100000), reason: text })
    .strict(),
  transfer: z.object({ id, siteId: id, quantity }).strict(),
  kit: z
    .object({
      name: text.max(100),
      components: z
        .array(
          z
            .object({
              sku: id,
              name: text.max(100),
              quantity: quantity.max(100),
              attributes: z.array(z.enum(["shelf-stable", "household"])).max(4),
            })
            .strict(),
        )
        .min(1)
        .max(8),
    })
    .strict(),
  distribute: z.object({ siteId: id, kitId: id, quantity }).strict(),
  receive: z.object({ id }).strict(),
  correctionPropose: z.object({
    kind: z.enum(["distribution", "receipt"]), sourceId: id,
    quantity: z.number().int().min(0).max(100000),
    movements: z.array(z.object({ lotId: id, quantity: z.number().int().min(-100000).max(100000) }).strict()).min(1).max(100),
    reason: text, evidence: text,
  }).strict(),
  correctionApprove: z.object({ id, digest: z.string().length(64) }).strict(),
  correctionReject: z.object({ id }).strict(),
  fulfill: z.object({ id, status: z.enum(["accepted", "fulfilled"]) }).strict(),
  partialCancel: z
    .object({ id, catalogId: id, packs: quantity, reason: text })
    .strict(),
  requestRefund: z.object({ id }).strict(),
  cancelOrder: z.object({ id, reason: text }).strict(),
  confirmRefund: z.object({ id }).strict(),
  failRefund: z.object({ id }).strict(),
  replacement: z.object({ id }).strict(),
  catalog: z
    .object({
      id,
      price: amount,
      availablePacks: z.number().int().min(0).max(10000),
      deliveryDays: quantity.max(90),
    })
    .strict(),
  supplier: z
    .object({
      name: text.max(120),
      shipping: z.number().int().min(0).max(100000),
    })
    .strict(),
  catalogCreate: z
    .object({
      sku: id,
      name: text.max(120),
      unit: text.max(30),
      packSize: quantity.max(1000),
      price: amount,
      availablePacks: z.number().int().min(0).max(10000),
      deliveryDays: quantity.max(90),
      attributes: z.array(z.enum(["shelf-stable", "household"])).max(2),
      expiresAt: date.optional(),
    })
    .strict(),
  invite: z
    .object({
      role: z.enum(["owner", "finance", "coordinator", "donor", "supplier"]),
      supplierId: id.optional(),
    })
    .strict(),
  member: z.object({ id, role }).strict(),
  revoke: z.object({ id }).strict(),
  dashboard: z
    .object({ name: text.max(100), definition: dashboardDefinition })
    .strict(),
  stop: z.object({ enabled: z.boolean() }).strict(),
  agentStop: z.object({ enabled: z.boolean() }).strict(),
};
export type CommandName = keyof typeof schemas;
export function actorFor(w: Workspace, actorId: string) {
  const actor = w.actors.find((a) => a.id === actorId);
  ensure(actor, "SESSION_REVOKED", "Your membership has ended.", 401);
  return actor;
}
export function permission(actor: Actor, allowed: Role[]) {
  ensure(
    allowed.includes(actor.role),
    "FORBIDDEN",
    "Your role cannot perform this action.",
    403,
  );
}
export function scoped<T extends { id: string; organizationId: string }>(
  rows: T[],
  itemId: string,
  actor: Actor,
): T {
  const item = rows.find(
    (x) => x.id === itemId && x.organizationId === actor.organizationId,
  );
  ensure(item, "NOT_FOUND", "Record not found in this nonprofit.", 404);
  return item;
}
export function record(
  w: Workspace,
  actor: Actor,
  action: string,
  subjectId: string,
  detail: string,
) {
  w.audit.push({
    id: randomUUID(),
    organizationId: actor.organizationId,
    actorId: actor.id,
    action,
    subjectId,
    detail,
    createdAt: new Date().toISOString(),
  });
}
export function post(
  w: Workspace,
  entry: Omit<LedgerEntry, "id" | "createdAt">,
) {
  ensure(
    Number.isSafeInteger(entry.amount),
    "AMOUNT",
    "Invalid ledger amount.",
  );
  if (
    !w.ledger.some(
      (e) => e.subjectId === entry.subjectId && e.kind === entry.kind,
    )
  )
    w.ledger.push({
      ...entry,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    });
}
const staff: Role[] = ["owner", "finance", "coordinator"];
const finance: Role[] = ["owner", "finance"];
function site(w: Workspace, actor: Actor, siteId: string) {
  ensure(
    w.organizations
      .find((o) => o.id === actor.organizationId)
      ?.sites.some((s) => s.id === siteId),
    "SITE",
    "Site not found.",
  );
}
function supplierOrder(w: Workspace, actor: Actor, itemId: string) {
  permission(actor, ["supplier"]);
  const order = scoped(w.orders, itemId, actor);
  ensure(
    order.supplierId === actor.supplierId,
    "MERCHANT",
    "This order belongs to another supplier.",
    403,
  );
  return order;
}
function localPayment(w: Workspace) {
  ensure(
    configuration().payments === "simulation" && w.demo,
    "PROVIDER_REQUIRED",
    "Use the configured PayPal sandbox flow. Simulation cannot confirm external payments.",
    409,
  );
}
function spendEnabled(w: Workspace, organizationId: string) {
  ensure(
    configuration().financialActions &&
      w.audit
        .filter(
          (a) => a.action === "stop" && a.organizationId === organizationId,
        )
        .at(-1)?.detail !== "disabled",
    "STOPPED",
    "Financial actions are paused.",
    409,
  );
}
function consumeStock(
  w: Workspace,
  actor: Actor,
  siteId: string,
  sku: string,
  count: number,
) {
  let remaining = count;
  const movements: StockMovement[] = [];
  const today = new Date().toISOString().slice(0, 10);
  const lots = w.inventory
    .filter(
      (l) =>
        l.organizationId === actor.organizationId &&
        l.siteId === siteId &&
        l.sku === sku &&
        (!l.expiresAt || l.expiresAt >= today),
    )
    .sort((a, b) =>
      (a.expiresAt ?? "9999").localeCompare(b.expiresAt ?? "9999"),
    );
  ensure(
    lots.reduce((s, l) => s + freeLot(w, l), 0) >= count,
    "STOCK",
    "Not enough usable stock.",
  );
  for (const lot of lots) {
    const take = Math.min(remaining, freeLot(w, lot));
    if (!take) continue;
    lot.quantity -= take;
    lot.version++;
    remaining -= take;
    movements.push({ lotId: lot.id, sku: lot.sku, quantity: -take });
  }
  return movements;
}
function releaseStock(w: Workspace, proposalId: string) {
  if (
    w.orders
      .filter((o) => o.proposalId === proposalId)
      .every((o) => ["received", "cancelled"].includes(o.status))
  )
    for (const reservation of w.stockReservations.filter(
      (r) => r.proposalId === proposalId,
    ))
      reservation.released = true;
}
export function cancelUnpaidOrder(w: Workspace, o: Order) {
  ensure(
    o.status === "awaiting_payer",
    "STATE",
    "Only an uncaptured order can be retired.",
  );
  o.status = "cancelled";
  for (const l of o.lines) {
    const c = w.catalog.find((c) => c.id === l.catalogId)!;
    c.availablePacks += l.packs;
    c.version++;
  }
  releaseStock(w, o.proposalId);
}
export function execute(
  w: Workspace,
  actorId: string,
  name: string,
  raw: unknown,
  key: string,
): unknown {
  const actor = actorFor(w, actorId);
  ensure(Object.hasOwn(schemas, name), "COMMAND", "Unknown command.");
  ensure(
    /^[a-zA-Z0-9-]{8,100}$/.test(key),
    "IDEMPOTENCY",
    "A valid operation key is required.",
  );
  const parsed = schemas[name as CommandName].safeParse(raw);
  ensure(
    parsed.success,
    "INPUT",
    parsed.success
      ? ""
      : parsed.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; "),
  );
  const fingerprint = digest({ actorId, name, data: parsed.data });
  // A replay cannot restore a permission that has since been revoked.
  if (name === "correctionApprove") permission(actor, ["owner"]);
  if (name === "correctionPropose") permission(actor, ["coordinator"]);
  if (name === "correctionReject") permission(actor, ["owner", "coordinator"]);
  const prior = w.idempotency[key];
  if (prior) {
    ensure(
      prior.fingerprint === fingerprint,
      "IDEMPOTENCY_CONFLICT",
      "This operation key was already used for another request.",
      409,
    );
    return prior.result;
  }
  const now = new Date().toISOString();
  let result: unknown;
  // Each branch receives an already strict-validated command; use typed branch parsing.
  switch (name as CommandName) {
    case "organization": {
      permission(actor, ["owner"]);
      const d = schemas.organization.parse(raw);
      Object.assign(
        w.organizations.find((o) => o.id === actor.organizationId)!,
        d,
      );
      result = { id: actor.organizationId };
      break;
    }
    case "site": {
      permission(actor, ["owner"]);
      const d = schemas.site.parse(raw);
      const s = { id: randomUUID(), name: d.name };
      w.organizations.find((o) => o.id === actor.organizationId)!.sites.push(s);
      result = s;
      break;
    }
    case "campaign": {
      permission(actor, ["owner"]);
      ensure(w.organizations.find(o => o.id === actor.organizationId)?.sites.length,
        "SETUP", "Add your first pantry site before creating a campaign.", 409);
      const d = schemas.campaign.parse(raw);
      scoped(w.kits, d.kitId, actor);
      const fundId = randomUUID();
      const campaign = {
        ...d,
        id: randomUUID(),
        organizationId: actor.organizationId,
        fundId,
        status: "draft" as const,
        createdAt: now,
      };
      w.funds.push({
        id: fundId,
        organizationId: actor.organizationId,
        name: d.title,
        purpose: d.kitId,
        restricted: d.restricted,
      });
      w.campaigns.push(campaign);
      result = campaign;
      break;
    }
    case "campaignStatus": {
      permission(actor, ["owner"]);
      const d = schemas.campaignStatus.parse(raw);
      const c = scoped(w.campaigns, d.id, actor);
      ensure(
        c.status !== "closed",
        "STATE",
        "Closed campaigns cannot be reopened.",
      );
      c.status = d.status;
      result = c;
      break;
    }
    case "request": {
      permission(actor, staff);
      const d = schemas.request.parse(raw);
      site(w, actor, d.siteId);
      const kit = scoped(w.kits, d.kitId, actor);
      const fund = scoped(w.funds, d.fundId, actor);
      ensure(
        !fund.restricted || fund.purpose === kit.id,
        "RESTRICTION",
        "Fund purpose does not match the kit.",
      );
      ensure(
        d.deadline >= now.slice(0, 10),
        "DEADLINE",
        "Choose today or a future deadline.",
      );
      const r = {
        ...d,
        id: randomUUID(),
        organizationId: actor.organizationId,
        createdAt: now,
      };
      w.requests.push(r);
      result = r;
      break;
    }
    case "propose": {
      permission(actor, staff);
      const d = schemas.propose.parse(raw);
      const proposal = plan(w, scoped(w.requests, d.id, actor));
      w.proposals.push(proposal);
      w.agentRuns.push({
        id: randomUUID(),
        organizationId: actor.organizationId,
        status: "completed",
        source: "deterministic",
        evidence: [proposal.digest, ...proposal.explanations],
        createdAt: now,
      });
      result = proposal;
      break;
    }
    case "approve": {
      permission(actor, finance);
      spendEnabled(w, actor.organizationId);
      const p = scoped(w.proposals, schemas.approve.parse(raw).id, actor);
      const r = scoped(w.requests, p.requestId, actor);
      ensure(
        p.lines.length > 0 && !p.shortages.length,
        "INFEASIBLE",
        "Resolve the proposal shortages before approval.",
      );
      ensure(
        p.stockDigest === stockDigest(w, r),
        "STALE",
        "Stock or catalogue changed. Generate a fresh proposal.",
        409,
      );
      ensure(
        p.total <= balances(w, p.fundId).available,
        "FUNDS",
        "Insufficient available funds.",
      );
      const a = {
        id: randomUUID(),
        organizationId: actor.organizationId,
        actorId,
        proposalId: p.id,
        digest: p.digest,
        amount: p.total,
        fundId: p.fundId,
        expiresAt: new Date(Date.now() + 900000).toISOString(),
        consumed: false,
      };
      w.approvals.push(a);
      result = a;
      break;
    }
    case "checkout": {
      permission(actor, finance);
      spendEnabled(w, actor.organizationId);
      const a = scoped(w.approvals, schemas.checkout.parse(raw).id, actor);
      const approver = actorFor(w, a.actorId);
      ensure(
        approver.organizationId === actor.organizationId,
        "APPROVAL",
        "Approver membership changed.",
      );
      permission(approver, finance);
      const p = scoped(w.proposals, a.proposalId, actor);
      const r = scoped(w.requests, p.requestId, actor);
      ensure(
        !a.consumed &&
          a.expiresAt > now &&
          a.digest === p.digest &&
          a.amount === p.total,
        "APPROVAL",
        "Approval has expired, changed, or was used.",
      );
      ensure(
        p.stockDigest === stockDigest(w, r),
        "STALE",
        "Stock or catalogue changed. Replan and approve again.",
        409,
      );
      ensure(
        p.total <= balances(w, p.fundId).available,
        "FUNDS",
        "Another purchase reserved these funds.",
        409,
      );
      const orders: Order[] = [
        ...new Set(p.lines.map((l) => l.supplierId)),
      ].map((supplierId) => {
        const lines = p.lines
          .filter((l) => l.supplierId === supplierId)
          .map((l) => ({ ...l }));
        return {
          id: randomUUID(),
          organizationId: actor.organizationId,
          proposalId: p.id,
          approvalId: a.id,
          fundId: p.fundId,
          supplierId,
          siteId: r.siteId,
          lines,
          total:
            lines.reduce((s, l) => s + l.cost, 0) +
            w.suppliers.find((s) => s.id === supplierId)!.shipping,
          cancelledAmount: 0,
          status: "awaiting_payer",
          evidence:
            configuration().payments === "simulation"
              ? "simulation"
              : "paypal_sandbox",
          createdAt: now,
        };
      });
      for (const l of p.lines) {
        const offer = w.catalog.find((c) => c.id === l.catalogId)!;
        ensure(
          offer.availablePacks >= l.packs,
          "CATALOG",
          "Offer availability changed.",
        );
        offer.availablePacks -= l.packs;
        offer.version++;
      }
      w.orders.push(...orders);
      const kit = w.kits.find((k) => k.id === r.kitId)!;
      for (const component of kit.components) {
        let need = r.target * component.quantity;
        for (const lot of w.inventory
          .filter(
            (l) =>
              l.organizationId === actor.organizationId &&
              l.siteId === r.siteId &&
              l.sku === component.sku &&
              (!l.expiresAt || l.expiresAt >= now.slice(0, 10)),
          )
          .sort((a, b) =>
            (a.expiresAt ?? "9999").localeCompare(b.expiresAt ?? "9999"),
          )) {
          const reserve = Math.min(need, freeLot(w, lot));
          if (reserve)
            w.stockReservations.push({
              id: randomUUID(),
              organizationId: actor.organizationId,
              proposalId: p.id,
              lotId: lot.id,
              quantity: reserve,
              released: false,
            });
          need -= reserve;
        }
      }
      a.consumed = true;
      result = orders;
      break;
    }
    case "donation": {
      permission(actor, ["donor"]);
      spendEnabled(w, actor.organizationId);
      const d = schemas.donation.parse(raw);
      const c = scoped(w.campaigns, d.campaignId, actor);
      ensure(
        c.status === "published",
        "CAMPAIGN",
        "Campaign is not accepting donations.",
      );
      const donation = {
        id: randomUUID(),
        organizationId: actor.organizationId,
        donorId: actor.id,
        campaignId: c.id,
        fundId: c.fundId,
        amount: cents(d.amount),
        status: "awaiting_payer" as const,
        evidence:
          configuration().payments === "simulation"
            ? ("simulation" as const)
            : ("paypal_sandbox" as const),
        createdAt: now,
      };
      w.donations.push(donation);
      result = donation;
      break;
    }
    case "capture": {
      localPayment(w);
      spendEnabled(w, actor.organizationId);
      const d = schemas.capture.parse(raw);
      const donation = w.donations.find(
        (x) =>
          x.id === d.id &&
          x.organizationId === actor.organizationId &&
          x.donorId === actor.id,
      );
      if (donation) {
        permission(actor, ["donor"]);
        ensure(
          donation.status === "awaiting_payer",
          "STATE",
          "Donation is no longer awaiting payer approval.",
        );
        donation.status = "confirmed";
        donation.net = donation.amount;
        donation.captureId = `SIM-${randomUUID()}`;
        post(w, {
          organizationId: actor.organizationId,
          fundId: donation.fundId,
          amount: donation.net,
          kind: "donation",
          subjectId: donation.id,
          source: "local simulated payer approval",
          evidence: "simulation",
        });
        result = donation;
      } else {
        permission(actor, finance);
        const o = scoped(w.orders, d.id, actor);
        ensure(
          o.status === "awaiting_payer",
          "STATE",
          "Order is no longer awaiting payer approval.",
        );
        o.status = "paid";
        o.captureId = `SIM-${randomUUID()}`;
        post(w, {
          organizationId: actor.organizationId,
          fundId: o.fundId,
          amount: -o.total,
          kind: "spend",
          subjectId: o.id,
          source: "local simulated payer approval",
          evidence: "simulation",
        });
        result = o;
      }
      break;
    }
    case "cancelPayment": {
      localPayment(w);
      const d = schemas.cancelPayment.parse(raw);
      const donation = w.donations.find(
        (x) =>
          x.id === d.id &&
          x.donorId === actor.id &&
          x.organizationId === actor.organizationId,
      );
      if (donation) {
        ensure(
          donation.status === "awaiting_payer",
          "STATE",
          "Payment cannot be cancelled.",
        );
        donation.status = "cancelled";
        result = donation;
      } else {
        permission(actor, finance);
        const o = scoped(w.orders, d.id, actor);
        ensure(
          o.status === "awaiting_payer",
          "STATE",
          "Payment cannot be cancelled.",
        );
        o.status = "cancelled";
        releaseStock(w, o.proposalId);
        for (const l of o.lines) {
          const c = w.catalog.find((c) => c.id === l.catalogId)!;
          c.availablePacks += l.packs;
          c.version++;
        }
        result = o;
      }
      break;
    }
    case "subscription": {
      permission(actor, ["donor"]);
      spendEnabled(w, actor.organizationId);
      const d = schemas.subscription.parse(raw);
      const c = scoped(w.campaigns, d.campaignId, actor);
      ensure(c.status === "published", "CAMPAIGN", "Campaign is closed.");
      const s = {
        id: randomUUID(),
        organizationId: actor.organizationId,
        donorId: actor.id,
        campaignId: c.id,
        amount: d.amount,
        status: "awaiting_payer" as const,
        evidence:
          configuration().payments === "simulation"
            ? ("simulation" as const)
            : ("paypal_sandbox" as const),
        createdAt: now,
      };
      w.subscriptions.push(s);
      result = s;
      break;
    }
    case "activateSubscription": {
      localPayment(w);
      permission(actor, ["donor"]);
      spendEnabled(w, actor.organizationId);
      const s = scoped(
        w.subscriptions,
        schemas.activateSubscription.parse(raw).id,
        actor,
      );
      ensure(
        s.donorId === actor.id,
        "FORBIDDEN",
        "Subscription belongs to another donor.",
        403,
      );
      ensure(
        s.status === "awaiting_payer",
        "STATE",
        "Subscription cannot be activated.",
      );
      s.status = "active";
      result = s;
      break;
    }
    case "billSubscription": {
      localPayment(w);
      permission(actor, finance);
      spendEnabled(w, actor.organizationId);
      const d = schemas.billSubscription.parse(raw);
      const s = scoped(w.subscriptions, d.id, actor);
      ensure(s.status === "active", "STATE", "Subscription is not active.");
      const c = scoped(w.campaigns, s.campaignId, actor);
      const subjectId = `subscription-${s.id}-${d.eventId}`;
      let receipt = w.donations.find((d) => d.captureId === subjectId);
      if (!receipt) {
        receipt = {
          id: randomUUID(),
          organizationId: s.organizationId,
          donorId: s.donorId,
          campaignId: c.id,
          fundId: c.fundId,
          amount: s.amount,
          net: s.amount,
          status: "confirmed",
          captureId: subjectId,
          evidence: "simulation",
          createdAt: now,
          subscriptionId: s.id,
        };
        w.donations.push(receipt);
      }
      post(w, {
        organizationId: actor.organizationId,
        fundId: c.fundId,
        amount: s.amount,
        kind: "donation",
        subjectId: receipt.id,
        source: "simulated monthly billing event",
        evidence: "simulation",
      });
      result = { subjectId };
      break;
    }
    case "cancelSubscription": {
      localPayment(w);
      const s = scoped(
        w.subscriptions,
        schemas.cancelSubscription.parse(raw).id,
        actor,
      );
      ensure(
        s.donorId === actor.id,
        "FORBIDDEN",
        "Only the donor can cancel this subscription.",
        403,
      );
      ensure(
        ["active", "awaiting_payer", "suspended"].includes(s.status),
        "STATE",
        "Subscription already cancelled.",
      );
      s.status = "cancelled";
      result = s;
      break;
    }
    case "donationRefund": {
      permission(actor, finance);
      spendEnabled(w, actor.organizationId);
      const d = scoped(
        w.donations,
        schemas.donationRefund.parse(raw).id,
        actor,
      );
      ensure(
        d.status === "confirmed",
        "STATE",
        "Only confirmed donations can be refunded.",
      );
      ensure(
        balances(w, d.fundId).available >= d.amount,
        "FUNDS",
        "Insufficient funds to reserve this refund.",
      );
      d.status = "refund_pending";
      result = d;
      break;
    }
    case "confirmDonationRefund": {
      localPayment(w);
      permission(actor, finance);
      spendEnabled(w, actor.organizationId);
      const d = scoped(
        w.donations,
        schemas.confirmDonationRefund.parse(raw).id,
        actor,
      );
      ensure(
        d.status === "refund_pending",
        "STATE",
        "No approved refund is pending.",
      );
      post(w, {
        organizationId: actor.organizationId,
        fundId: d.fundId,
        amount: -d.amount,
        kind: "donation_refund",
        subjectId: d.id,
        source: "simulated nonprofit merchant refund",
        evidence: "simulation",
      });
      d.status = "refunded";
      result = d;
      break;
    }
    case "inventory": {
      permission(actor, staff);
      const d = schemas.inventory.parse(raw);
      site(w, actor, d.siteId);
      const lot = {
        ...d,
        id: randomUUID(),
        organizationId: actor.organizationId,
        version: 1,
      };
      w.inventory.push(lot);
      result = lot;
      break;
    }
    case "import": {
      permission(actor, staff);
      const d = schemas.import.parse(raw);
      site(w, actor, d.siteId);
      const lots = d.rows.map((row) => ({
        ...row,
        siteId: d.siteId,
        id: randomUUID(),
        organizationId: actor.organizationId,
        version: 1,
      }));
      w.inventory.push(...lots);
      result = { count: lots.length };
      break;
    }
    case "adjust": {
      permission(actor, staff);
      const d = schemas.adjust.parse(raw);
      const lot = scoped(w.inventory, d.id, actor);
      ensure(
        d.quantity >= lot.quantity - freeLot(w, lot),
        "RESERVED_STOCK",
        "This lot is reserved for an approved purchase.",
      );
      lot.quantity = d.quantity;
      lot.version++;
      result = lot;
      break;
    }
    case "transfer": {
      permission(actor, staff);
      const d = schemas.transfer.parse(raw);
      const lot = scoped(w.inventory, d.id, actor);
      site(w, actor, d.siteId);
      ensure(
        lot.siteId !== d.siteId && freeLot(w, lot) >= d.quantity,
        "STOCK",
        "Choose another site and an available quantity.",
      );
      lot.quantity -= d.quantity;
      lot.version++;
      const next = {
        ...lot,
        id: randomUUID(),
        siteId: d.siteId,
        quantity: d.quantity,
        version: 1,
      };
      w.inventory.push(next);
      result = next;
      break;
    }
    case "kit": {
      permission(actor, staff);
      const d = schemas.kit.parse(raw);
      ensure(
        new Set(d.components.map((c) => c.sku)).size === d.components.length,
        "KIT",
        "Component SKUs must be unique.",
      );
      const k = {
        ...d,
        id: randomUUID(),
        organizationId: actor.organizationId,
      };
      w.kits.push(k);
      result = k;
      break;
    }
    case "distribute": {
      permission(actor, staff);
      const d = schemas.distribute.parse(raw);
      site(w, actor, d.siteId);
      const k = scoped(w.kits, d.kitId, actor);
      ensure(
        kitReadiness(w, actor.organizationId, d.siteId, k.id) >= d.quantity,
        "STOCK",
        "Not enough complete kits at this site.",
      );
      const movements = k.components.flatMap(c =>
        consumeStock(w, actor, d.siteId, c.sku, c.quantity * d.quantity));
      const dist = {
        ...d,
        movements,
        components: k.components.map(c => ({ sku: c.sku, quantity: c.quantity })),
        id: randomUUID(),
        organizationId: actor.organizationId,
        createdAt: now,
      };
      w.distributions.push(dist);
      result = dist;
      break;
    }
    case "correctionPropose": {
      result = proposeCorrection(w, actor, schemas.correctionPropose.parse(raw));
      break;
    }
    case "correctionApprove": {
      const d = schemas.correctionApprove.parse(raw);
      result = approveCorrection(w, actor, d.id, d.digest);
      break;
    }
    case "correctionReject": {
      const d = schemas.correctionReject.parse(raw);
      const c = scoped(w.stockCorrections ?? [], d.id, actor);
      ensure(actor.role === "owner" || c.proposerId === actor.id,
        "FORBIDDEN", "Only the owner or proposing coordinator can reject this proposal.", 403);
      ensure(c.status === "proposed", "STATE", "This correction has already been reviewed.", 409);
      c.status = "rejected";
      c.rejectedBy = actor.id;
      result = c;
      break;
    }
    case "fulfill": {
      const d = schemas.fulfill.parse(raw);
      const o = supplierOrder(w, actor, d.id);
      ensure(
        ["paid", "accepted", "partial"].includes(o.status),
        "STATE",
        "Order cannot enter fulfillment.",
      );
      o.status = d.status;
      result = o;
      break;
    }
    case "partialCancel": {
      const d = schemas.partialCancel.parse(raw);
      const o = supplierOrder(w, actor, d.id);
      ensure(
        ["paid", "accepted", "partial"].includes(o.status),
        "STATE",
        "Order cannot be partially cancelled.",
      );
      const line = o.lines.find((l) => l.catalogId === d.catalogId);
      ensure(
        line && d.packs <= line.packs,
        "QUANTITY",
        "Cannot cancel more than the remaining packs.",
      );
      const cost = line.unitPrice * d.packs;
      line.packs -= d.packs;
      line.units -=
        d.packs * w.catalog.find((c) => c.id === line.catalogId)!.packSize;
      line.cost -= cost;
      o.cancelledAmount += cost;
      o.status = "partial";
      const offer = w.catalog.find((c) => c.id === line.catalogId)!;
      offer.availablePacks = 0;
      offer.version++;
      const r = {
        id: randomUUID(),
        organizationId: actor.organizationId,
        orderId: o.id,
        amount: cost,
        reason: d.reason,
        status: "opened" as const,
        createdAt: now,
      };
      w.recoveries.push(r);
      result = r;
      break;
    }
    case "cancelOrder": {
      const d = schemas.cancelOrder.parse(raw);
      const o = supplierOrder(w, actor, d.id);
      ensure(
        ["paid", "accepted", "partial"].includes(o.status),
        "STATE",
        "Only a paid, unfulfilled order can be cancelled.",
      );
      const remaining = o.total - o.cancelledAmount;
      ensure(remaining > 0, "STATE", "This order is already fully cancelled.");
      for (const l of o.lines) {
        const c = w.catalog.find((c) => c.id === l.catalogId)!;
        c.availablePacks = 0;
        c.version++;
        l.packs = 0;
        l.units = 0;
        l.cost = 0;
      }
      o.cancelledAmount = o.total;
      o.status = "cancelled";
      releaseStock(w, o.proposalId);
      const r = {
        id: randomUUID(),
        organizationId: actor.organizationId,
        orderId: o.id,
        amount: remaining,
        reason: d.reason,
        status: "opened" as const,
        createdAt: now,
      };
      w.recoveries.push(r);
      result = r;
      break;
    }
    case "requestRefund": {
      permission(actor, finance);
      spendEnabled(w, actor.organizationId);
      const r = scoped(
        w.recoveries,
        schemas.requestRefund.parse(raw).id,
        actor,
      );
      ensure(
        ["opened", "refund_failed"].includes(r.status),
        "STATE",
        "Refund already requested.",
      );
      r.status = "refund_requested";
      result = r;
      break;
    }
    case "confirmRefund": {
      localPayment(w);
      spendEnabled(w, actor.organizationId);
      const r = scoped(
        w.recoveries,
        schemas.confirmRefund.parse(raw).id,
        actor,
      );
      supplierOrder(w, actor, r.orderId);
      ensure(
        r.status === "refund_requested",
        "STATE",
        "Buyer has not requested a refund.",
      );
      r.status = "refund_confirmed";
      r.refundId = `SIM-${randomUUID()}`;
      const o = scoped(w.orders, r.orderId, actor);
      post(w, {
        organizationId: actor.organizationId,
        fundId: o.fundId,
        amount: r.amount,
        kind: "purchase_refund",
        subjectId: r.id,
        source: "simulated supplier merchant refund",
        evidence: "simulation",
      });
      result = r;
      break;
    }
    case "failRefund": {
      localPayment(w);
      const r = scoped(w.recoveries, schemas.failRefund.parse(raw).id, actor);
      supplierOrder(w, actor, r.orderId);
      ensure(r.status === "refund_requested", "STATE", "Refund not requested.");
      r.status = "refund_failed";
      result = r;
      break;
    }
    case "replacement": {
      permission(actor, staff);
      const r = scoped(w.recoveries, schemas.replacement.parse(raw).id, actor);
      ensure(
        r.status === "refund_confirmed",
        "STATE",
        "Wait for the confirmed refund before replacement.",
      );
      const o = scoped(w.orders, r.orderId, actor);
      ensure(
        ["received", "cancelled"].includes(o.status) &&
          w.orders
            .filter((order) => order.proposalId === o.proposalId)
            .every((order) => ["received", "cancelled"].includes(order.status)),
        "STATE",
        "Receive the remaining shipment first so replacement does not buy it twice.",
      );
      const original = w.proposals.find((p) => p.id === o.proposalId)!;
      const request = w.requests.find((x) => x.id === original.requestId)!;
      const newRequest = {
        ...request,
        id: randomUUID(),
        createdAt: now,
        replacesRequestId: request.replacesRequestId ?? request.id,
      };
      w.requests.push(newRequest);
      const p = plan(w, newRequest);
      w.proposals.push(p);
      r.status = "replacement_proposed";
      r.replacementProposalId = p.id;
      result = p;
      break;
    }
    case "receive": {
      permission(actor, staff);
      const o = scoped(w.orders, schemas.receive.parse(raw).id, actor);
      ensure(
        o.status === "fulfilled",
        "STATE",
        "Supplier must mark the shipment fulfilled first.",
      );
      const movements: StockMovement[] = [];
      for (const l of o.lines.filter((l) => l.units > 0)) {
        const c = w.catalog.find((c) => c.id === l.catalogId)!;
        const lotId = randomUUID();
        w.inventory.push({
          id: lotId,
          organizationId: actor.organizationId,
          siteId: o.siteId,
          sku: l.sku,
          name: l.name,
          quantity: l.units,
          expiresAt: c.expiresAt,
          version: 1,
        });
        movements.push({ lotId, sku: l.sku, quantity: l.units });
      }
      o.receipt = { id: randomUUID(), createdAt: now, movements };
      o.status = "received";
      releaseStock(w, o.proposalId);
      for (const recovery of w.recoveries.filter(
        (r) => r.replacementProposalId === o.proposalId,
      )) {
        if (
          w.orders
            .filter((order) => order.proposalId === o.proposalId)
            .every((order) => order.status === "received")
        )
          recovery.status = "resolved";
      }
      result = o;
      break;
    }
    case "supplier": {
      permission(actor, ["owner"]);
      const d = schemas.supplier.parse(raw);
      const supplierId = randomUUID();
      const supplier = {
        id: supplierId,
        ...d,
        merchantProfile: `sup-${supplierId}`,
        organizationIds: [actor.organizationId],
      };
      w.suppliers.push(supplier);
      result = supplier;
      break;
    }
    case "catalogCreate": {
      permission(actor, ["supplier"]);
      const d = schemas.catalogCreate.parse(raw);
      ensure(
        w.suppliers.some(
          (s) =>
            s.id === actor.supplierId &&
            s.organizationIds.includes(actor.organizationId),
        ),
        "MERCHANT",
        "Supplier membership is unavailable.",
      );
      ensure(
        !w.catalog.some(
          (c) => c.supplierId === actor.supplierId && c.sku === d.sku,
        ),
        "CATALOG",
        "Update the existing offer for this SKU.",
      );
      const offer = {
        ...d,
        id: randomUUID(),
        supplierId: actor.supplierId!,
        version: 1,
        provenance: "merchant" as const,
      };
      w.catalog.push(offer);
      result = offer;
      break;
    }
    case "catalog": {
      permission(actor, ["supplier"]);
      const d = schemas.catalog.parse(raw);
      const c = w.catalog.find(
        (c) => c.id === d.id && c.supplierId === actor.supplierId,
      );
      ensure(c, "MERCHANT", "Offer belongs to another supplier.", 403);
      Object.assign(c, {
        price: d.price,
        availablePacks: d.availablePacks,
        deliveryDays: d.deliveryDays,
        version: c.version + 1,
      });
      result = c;
      break;
    }
    case "invite": {
      permission(actor, ["owner"]);
      const d = schemas.invite.parse(raw);
      ensure(
        d.role === "supplier"
          ? !!d.supplierId &&
              w.suppliers.some(
                (s) =>
                  s.id === d.supplierId &&
                  s.organizationIds.includes(actor.organizationId),
              )
          : !d.supplierId,
        "INVITATION",
        "Supplier invitations require an approved supplier in this organization.",
      );
      const token = randomBytes(24).toString("hex");
      const invitation = {
        id: randomUUID(),
        organizationId: actor.organizationId,
        role: d.role,
        supplierId: d.supplierId,
        tokenHash: digest(token),
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        used: false,
      };
      w.invitations.push(invitation);
      result = { token, id: invitation.id, expiresAt: invitation.expiresAt };
      break;
    }
    case "member": {
      permission(actor, ["owner"]);
      const d = schemas.member.parse(raw);
      const member = scoped(w.actors, d.id, actor);
      ensure(
        member.id !== actor.id && member.role !== "supplier",
        "MEMBER",
        "Cannot change yourself or supplier authority.",
      );
      ensure(
        member.role !== "owner" ||
          w.actors.filter(
            (a) =>
              a.organizationId === actor.organizationId && a.role === "owner",
          ).length > 1,
        "OWNER",
        "The last owner cannot be demoted.",
      );
      member.role = d.role;
      result = member;
      break;
    }
    case "revoke": {
      permission(actor, ["owner"]);
      const member = scoped(w.actors, schemas.revoke.parse(raw).id, actor);
      ensure(member.id !== actor.id, "MEMBER", "Cannot revoke yourself.");
      ensure(
        member.role !== "owner" ||
          w.actors.filter(
            (a) =>
              a.organizationId === actor.organizationId && a.role === "owner",
          ).length > 1,
        "OWNER",
        "The last owner cannot be revoked.",
      );
      w.actors = w.actors.filter((a) => a.id !== member.id);
      result = { revoked: member.id };
      break;
    }
    case "dashboard": {
      permission(actor, staff);
      const d = schemas.dashboard.parse(raw);
      const dashboard = {
        ...d,
        id: randomUUID(),
        organizationId: actor.organizationId,
      };
      w.dashboards.push(dashboard);
      result = dashboard;
      break;
    }
    case "stop": {
      permission(actor, ["owner"]);
      const d = schemas.stop.parse(raw);
      record(w, actor, "stop", w.id, d.enabled ? "enabled" : "disabled");
      result = d;
      break;
    }
    case "agentStop": {
      permission(actor, ["owner"]);
      const d = schemas.agentStop.parse(raw);
      record(w, actor, "agentStop", w.id, d.enabled ? "enabled" : "disabled");
      if (!d.enabled) stopAgents(w.id, actor.organizationId);
      result = d;
      break;
    }
  }
  if (name !== "stop" && name !== "agentStop")
    record(
      w,
      actor,
      name,
      (result as { id?: string })?.id ?? key,
      JSON.stringify(parsed.data),
    );
  w.idempotency[key] = {
    fingerprint,
    result:
      name === "invite"
        ? { id: (result as { id: string }).id, tokenReturned: true }
        : result,
  };
  return result;
}
export function view(w: Workspace, actorId: string): AppView {
  const actor = actorFor(w, actorId);
  const org = actor.organizationId;
  const isStaff = staff.includes(actor.role);
  const isSupplier = actor.role === "supplier";
  const own = <T extends { organizationId: string }>(rows: T[]) =>
    rows.filter((x) => x.organizationId === org);
  const orders = own(w.orders).filter(
    (o) => isStaff || (isSupplier && o.supplierId === actor.supplierId),
  );
  const donations = own(w.donations).filter(
    (d) => isStaff || d.donorId === actor.id,
  );
  const funds = isStaff ? own(w.funds) : [];
  return {
    id: w.id,
    stockReservations: isStaff ? own(w.stockReservations) : [],
    revision: w.revision,
    demo: w.demo,
    ownerId: "",
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
    actor,
    actors: isStaff ? own(w.actors) : [actor],
    organizations: w.organizations
      .filter((o) => o.id === org)
      .map((o) => ({ ...o, merchantProfile: "" })),
    campaigns: own(w.campaigns).filter(
      (c) => isStaff || c.status === "published",
    ),
    campaignReceived: Object.fromEntries(
      own(w.campaigns)
        .filter((c) => isStaff || c.status === "published")
        .map((c) => [c.id, campaignReceived(w, c)]),
    ),
    funds,
    ledger: isStaff ? own(w.ledger) : [],
    suppliers: w.suppliers
      .filter((s) => s.organizationIds.includes(org))
      .map((s) => ({ ...s, merchantProfile: "", organizationIds: [org] })),
    catalog: w.catalog.filter((c) =>
      w.suppliers.some(
        (s) => s.id === c.supplierId && s.organizationIds.includes(org),
      ),
    ),
    inventory: isStaff ? own(w.inventory) : [],
    kits: own(w.kits),
    requests: isStaff ? own(w.requests) : [],
    proposals: isStaff ? own(w.proposals) : [],
    approvals: isStaff ? own(w.approvals) : [],
    orders: isStaff ? orders : orders.map(o => ({ ...o, receipt: undefined })),
    donations,
    subscriptions: own(w.subscriptions).filter(
      (s) => isStaff || s.donorId === actor.id,
    ),
    recoveries: own(w.recoveries).filter((r) =>
      orders.some((o) => o.id === r.orderId),
    ),
    audit: isStaff ? own(w.audit) : [],
    distributions: isStaff ? own(w.distributions) : [],
    stockCorrections: isStaff ? own(w.stockCorrections ?? []) : [],
    paymentOperations: isStaff
      ? w.paymentOperations.filter(
          (p) =>
            orders.some((o) => o.id === p.subjectId) ||
            donations.some((d) => d.id === p.subjectId),
        )
      : [],
    agentRuns: isStaff ? own(w.agentRuns) : [],
    dashboards: isStaff ? own(w.dashboards) : [],
    invitations:
      actor.role === "owner"
        ? own(w.invitations).map(({ id, role, expiresAt, used }) => ({
            id,
            role,
            expiresAt,
            used,
          }))
        : [],
    available: Object.fromEntries(
      funds.map((f) => [f.id, balances(w, f.id).available]),
    ),
    reserved: Object.fromEntries(
      funds.map((f) => [f.id, balances(w, f.id).reserved]),
    ),
    modes: {
      payments: configuration().payments,
      ai: configuration().ai,
      aiPaused: agentPaused(w, org),
      storage: configuration().storage,
      financialActions:
        configuration().financialActions &&
        w.audit
          .filter((a) => a.action === "stop" && a.organizationId === org)
          .at(-1)?.detail !== "disabled",
    },
  };
}
