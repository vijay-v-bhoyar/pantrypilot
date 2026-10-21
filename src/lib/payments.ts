import { randomUUID } from "node:crypto";
import {
  actorFor,
  cancelUnpaidOrder,
  permission,
  post,
  record,
} from "./commands";
import { configuration } from "./config";
import { ensure } from "./errors";
import { providerCents } from "./money";
import { approvalLink, decimal, merchant, paypal } from "./paypal";
import { withWorkspace } from "./storage";
import type { Session, Workspace } from "./types";
type Action =
  | "create"
  | "capture"
  | "cancel"
  | "refund"
  | "subscription"
  | "cancel_subscription"
  | "reconcile";
function context(
  w: Workspace,
  actorId: string,
  subjectId: string,
  action: Action,
) {
  const actor = actorFor(w, actorId);
  const order = w.orders.find(
    (o) => o.id === subjectId && o.organizationId === actor.organizationId,
  );
  const donation = w.donations.find(
    (d) => d.id === subjectId && d.organizationId === actor.organizationId,
  );
  const recovery = w.recoveries.find(
    (r) => r.id === subjectId && r.organizationId === actor.organizationId,
  );
  const subscription = w.subscriptions.find(
    (s) => s.id === subjectId && s.organizationId === actor.organizationId,
  );
  const original = recovery
    ? w.orders.find((o) => o.id === recovery.orderId)!
    : order;
  if (recovery) {
    permission(actor, ["supplier"]);
    ensure(
      actor.supplierId === original?.supplierId,
      "MERCHANT",
      "Only this supplier merchant can issue the refund.",
      403,
    );
    ensure(
      recovery.status === "refund_requested" || action === "reconcile",
      "STATE",
      "Finance must request the refund first.",
    );
  } else if (order) {
    permission(actor, ["owner", "finance"]);
  } else if (donation) {
    if (action === "refund") {
      permission(actor, ["owner", "finance"]);
      ensure(
        donation.status === "refund_pending",
        "STATE",
        "Finance must approve the refund first.",
      );
    } else {
      ensure(
        donation.donorId === actor.id ||
          (["owner", "finance"].includes(actor.role) && action === "reconcile"),
        "DONOR",
        "This payment belongs to another donor.",
        403,
      );
    }
  } else if (subscription) {
    ensure(
      subscription.donorId === actor.id ||
        (["owner", "finance"].includes(actor.role) && action === "reconcile"),
      "DONOR",
      "Only the donor can manage this subscription.",
      403,
    );
  }
  ensure(
    order || donation || recovery || subscription,
    "NOT_FOUND",
    "Payment not found.",
    404,
  );
  const org = w.organizations.find((o) => o.id === actor.organizationId)!;
  const profile = original
    ? w.suppliers.find((s) => s.id === original.supplierId)!.merchantProfile
    : org.merchantProfile;
  return {
    actor,
    order,
    donation,
    recovery,
    subscription,
    original,
    profile,
    subject: recovery ?? order ?? donation ?? subscription!,
    amount:
      recovery?.amount ??
      order?.total ??
      donation?.amount ??
      subscription?.amount ??
      0,
  };
}
export async function paymentAction(
  session: Session,
  subjectId: string,
  action: Action,
) {
  ensure(
    configuration().payments === "sandbox",
    "MODE",
    "This endpoint only runs PayPal sandbox payments.",
  );
  const intent = await withWorkspace(session.workspaceId, (w) => {
    const c = context(w, session.actorId, subjectId, action);
    if (action === "refund")
      ensure(
        c.recovery || c.donation,
        "MERCHANT",
        "Buyer cannot issue a supplier refund; open a recovery case and obtain merchant approval.",
        403,
      );
    merchant(c.profile);
    ensure(
      action === "reconcile" ||
        (configuration().financialActions &&
          w.audit
            .filter(
              (a) =>
                a.action === "stop" &&
                a.organizationId === c.actor.organizationId,
            )
            .at(-1)?.detail !== "disabled"),
      "STOPPED",
      "Financial actions are paused.",
    );
    const previous =
      action === "reconcile"
        ? undefined
        : w.paymentOperations.find(
            (p) => p.subjectId === subjectId && p.action === action,
          );
    if (previous) {
      ensure(
        previous.status === "completed",
        "UNCERTAIN",
        "An earlier operation needs reconciliation; do not repeat it.",
        409,
      );
      return { existing: true, operation: previous, c };
    }
    if (action === "create")
      ensure(
        (c.order ?? c.donation)?.status === "awaiting_payer",
        "STATE",
        "Payment is not awaiting checkout.",
      );
    if (action === "capture")
      ensure(
        (c.order ?? c.donation)?.status === "awaiting_payer" &&
          !!(c.order ?? c.donation)?.providerId,
        "STATE",
        "Create and approve PayPal checkout before capture.",
      );
    if (action === "capture" || action === "create")
      ensure(
        !w.paymentOperations.some(
          (p) => p.subjectId === subjectId && p.action === "cancel",
        ),
        "STATE",
        "This checkout is being retired; reconcile it before further action.",
      );
    if (action === "cancel") {
      ensure(
        (c.order ?? c.donation)?.status === "awaiting_payer",
        "STATE",
        "Only an uncaptured checkout can be retired.",
      );
      ensure(
        !w.paymentOperations.some(
          (p) =>
            p.subjectId === subjectId &&
            (p.action === "capture" ||
              (p.action === "create" && p.status !== "completed")),
        ),
        "UNCERTAIN",
        "A payment operation may still be in flight; reconcile it before retiring checkout.",
      );
    }
    if (action === "subscription")
      ensure(
        c.subscription?.status === "awaiting_payer",
        "STATE",
        "Subscription is not awaiting approval.",
      );
    if (action === "cancel_subscription")
      ensure(
        c.subscription?.providerId && c.subscription.status !== "cancelled",
        "STATE",
        "Subscription cannot be cancelled.",
      );
    if (action === "refund")
      ensure(
        c.original?.captureId || c.donation?.captureId,
        "CAPTURE",
        "No confirmed capture is available.",
      );
    const operation = {
      id: randomUUID(),
      subjectId,
      action,
      profile: c.profile,
      requestId: randomUUID(),
      status: "started" as const,
      createdAt: new Date().toISOString(),
    };
    w.paymentOperations.push(operation);
    return { existing: false, operation, c };
  });
  if (intent.existing) return intent.c.subject;
  const { c, operation } = intent;
  try {
    let result: Record<string, unknown>;
    const callback = `${process.env.APP_URL || "http://127.0.0.1:3100"}/workspace?payment=${encodeURIComponent(subjectId)}`;
    if (action === "create")
      result = await paypal(
        c.profile,
        "/v2/checkout/orders",
        "POST",
        {
          intent: "CAPTURE",
          purchase_units: [
            {
              custom_id: `${session.workspaceId}:${subjectId}`,
              reference_id: subjectId,
              payee: { merchant_id: merchant(c.profile).merchantId },
              amount: { currency_code: "USD", value: decimal(c.amount) },
            },
          ],
          payment_source: {
            paypal: {
              experience_context: {
                return_url: callback,
                cancel_url: `${callback}&cancelled=1`,
                user_action: "PAY_NOW",
                shipping_preference: "NO_SHIPPING",
              },
            },
          },
        },
        operation.requestId,
      );
    else if (action === "cancel")
      result = (c.order ?? c.donation)?.providerId
        ? await paypal(
            c.profile,
            `/v2/checkout/orders/${(c.order ?? c.donation)!.providerId}`,
          )
        : {};
    else if (action === "capture")
      result = await paypal(
        c.profile,
        `/v2/checkout/orders/${(c.order ?? c.donation)!.providerId}/capture`,
        "POST",
        {},
        operation.requestId,
      );
    else if (action === "refund")
      result = await paypal(
        c.profile,
        c.donation?.subscriptionId
          ? `/v1/payments/sale/${c.donation.captureId}/refund`
          : `/v2/payments/captures/${c.original?.captureId ?? c.donation?.captureId}/refund`,
        "POST",
        c.donation?.subscriptionId
          ? { amount: { currency: "USD", total: decimal(c.amount) } }
          : { amount: { currency_code: "USD", value: decimal(c.amount) } },
        operation.requestId,
      );
    else if (action === "subscription") {
      const plan = merchant(c.profile).monthlyPlans?.[String(c.amount)];
      ensure(
        plan,
        "PLAN",
        "Configure an existing USD monthly PayPal plan for this amount.",
        503,
      );
      const planDetails = await paypal(c.profile, `/v1/billing/plans/${plan}`);
      const cycles = planDetails.billing_cycles as
        | {
            tenure_type: string;
            frequency: { interval_unit: string; interval_count: number };
            pricing_scheme: {
              fixed_price: { currency_code: string; value: string };
            };
          }[]
        | undefined;
      ensure(
        planDetails.status === "ACTIVE" &&
          cycles?.length === 1 &&
          cycles[0].tenure_type === "REGULAR" &&
          cycles[0].frequency.interval_unit === "MONTH" &&
          cycles[0].frequency.interval_count === 1 &&
          cycles[0].pricing_scheme.fixed_price.currency_code === "USD" &&
          cycles[0].pricing_scheme.fixed_price.value === decimal(c.amount),
        "PLAN",
        "Configured plan is not the approved USD monthly amount.",
      );
      result = await paypal(
        c.profile,
        "/v1/billing/subscriptions",
        "POST",
        {
          plan_id: plan,
          custom_id: `${session.workspaceId}:${subjectId}`,
          application_context: {
            brand_name: "PantryPilot sandbox",
            return_url: callback,
            cancel_url: `${callback}&cancelled=1`,
            user_action: "SUBSCRIBE_NOW",
          },
        },
        operation.requestId,
      );
    } else if (action === "cancel_subscription")
      result = await paypal(
        c.profile,
        `/v1/billing/subscriptions/${c.subscription!.providerId}/cancel`,
        "POST",
        { reason: "Donor requested cancellation" },
        operation.requestId,
      );
    else {
      const s = c.order ?? c.donation ?? c.subscription;
      ensure(
        s?.providerId || c.recovery?.refundId || c.donation?.refundId,
        "READBACK",
        "No provider resource ID is available. Investigate the recorded request ID manually.",
      );
      result = await paypal(
        c.profile,
        c.recovery
          ? `/v2/payments/refunds/${c.recovery.refundId}`
          : c.donation?.refundId
            ? c.donation.subscriptionId
              ? `/v1/payments/refund/${c.donation.refundId}`
              : `/v2/payments/refunds/${c.donation.refundId}`
            : c.subscription
              ? `/v1/billing/subscriptions/${c.subscription.providerId}`
              : `/v2/checkout/orders/${s!.providerId}`,
      );
    }
    return await withWorkspace(session.workspaceId, (w) => {
      const current = context(w, session.actorId, subjectId, action);
      const op = w.paymentOperations.find((p) => p.id === operation.id)!;
      if (action === "reconcile") {
        const expectedId = current.recovery?.refundId ??
          current.donation?.refundId ??
          (current.order ?? current.donation ?? current.subscription)?.providerId;
        ensure(result.id === expectedId, "READBACK_RESOURCE",
          "Readback resource does not match the recorded payment.");
        if (current.subscription)
          ensure(result.custom_id === `${w.id}:${subjectId}`, "MERCHANT",
            "Subscription ownership does not match.");
      }
      if (action === "create" || action === "subscription") {
        const link = approvalLink(result);
        const target =
          current.order ?? current.donation ?? current.subscription!;
        target.providerId = String(result.id);
        target.approvalUrl = link;
      } else if (
        action === "cancel" ||
        (action === "reconcile" &&
          (current.order ?? current.donation)?.status === "awaiting_payer" &&
          w.paymentOperations.some(
            (p) =>
              p.subjectId === subjectId &&
              p.action === "cancel" &&
              p.status === "uncertain",
          ))
      ) {
        const target = current.order ?? current.donation!;
        let capturedOnReadback = false;
        if (target.providerId) {
          const units = result.purchase_units as
            | {
                custom_id: string;
                payee: { merchant_id: string };
                amount: { currency_code: string; value: string };
                payments?: { captures?: unknown[]; authorizations?: unknown[] };
              }[]
            | undefined;
          ensure(
            result.id === target.providerId &&
              units?.length === 1 &&
              units[0].custom_id === `${w.id}:${subjectId}` &&
              units[0].payee?.merchant_id ===
                merchant(current.profile).merchantId,
            "MERCHANT",
            "Uncaptured order ownership does not match.",
          );
          ensure(
            units[0].amount?.currency_code === "USD" &&
              units[0].amount.value === decimal(current.amount),
            "PROVIDER_AMOUNT",
            "Order amount mismatch.",
          );
          capturedOnReadback = action === "reconcile" &&
            units[0].payments?.captures?.some((capture) =>
              typeof capture === "object" && capture !== null &&
              "status" in capture && capture.status === "COMPLETED") === true;
          if (!capturedOnReadback) ensure(
            ["CREATED", "APPROVED", "VOIDED"].includes(String(result.status)) &&
              !units[0].payments?.captures?.length &&
              !units[0].payments?.authorizations?.length,
            "UNCERTAIN",
            "Provider funds may be captured or authorized; do not release the reservation.",
          );
        }
        if (capturedOnReadback) {
          settleCapture(w, current.profile, subjectId, result);
          for (const pending of w.paymentOperations.filter(
            (p) => p.subjectId === subjectId && p.action === "cancel" && p.status === "uncertain",
          )) {
            pending.status = "failed";
            pending.error = "Checkout was not retired: verified readback confirmed capture.";
          }
        } else {
          if (current.order) cancelUnpaidOrder(w, current.order);
          else current.donation!.status = "cancelled";
          target.approvalUrl = undefined;
          for (const pending of w.paymentOperations.filter(
            (p) => p.subjectId === subjectId && p.action === "cancel",
          ))
            pending.status = "completed";
        }
      } else if (
        action === "capture" ||
        (action === "reconcile" &&
          !current.subscription &&
          !current.recovery &&
          !current.donation?.refundId)
      ) {
        settleCapture(w, current.profile, subjectId, result);
      } else if (
        action === "refund" ||
        (action === "reconcile" &&
          (current.recovery || current.donation?.refundId))
      ) {
        settleRefund(w, current.profile, subjectId, result);
      } else if (action === "cancel_subscription")
        current.subscription!.status = "cancelled";
      else if (current.subscription) {
        const status = String(result.status);
        if (["ACTIVE", "CANCELLED", "SUSPENDED"].includes(status))
          current.subscription.status = status.toLowerCase() as
            | "active"
            | "cancelled"
            | "suspended";
      }
      op.status = "completed";
      op.providerId = typeof result.id === "string" ? result.id : undefined;
      record(
        w,
        current.actor,
        `paypal_${action}`,
        subjectId,
        `Sandbox readback ${String(result.status ?? "confirmed")}`,
      );
      return current.subject;
    });
  } catch (error) {
    await withWorkspace(session.workspaceId, (w) => {
      const op = w.paymentOperations.find((p) => p.id === operation.id)!;
      op.status = "uncertain";
      op.error =
        "Provider outcome unknown. Reconcile the existing operation before retrying.";
      // An actor can be revoked while the provider request is in flight.
      // Persist its uncertain result even when that actor can no longer act.
      const target =
        w.orders.find((o) => o.id === subjectId) ??
        w.donations.find((d) => d.id === subjectId);
      if (action === "capture") target!.status = "uncertain";
      if (action === "refund") {
        const recovery = w.recoveries.find((r) => r.id === subjectId);
        if (recovery) recovery.status = "refund_pending";
      }
      record(w, c.actor, "paypal_uncertain", subjectId, op.error);
    });
    throw error;
  }
}
export function settleCapture(
  w: Workspace,
  profile: string,
  subjectId: string,
  data: Record<string, unknown>,
) {
  type Capture = {
    id: string;
    status: string;
    amount: { currency_code: string; value: string };
    seller_receivable_breakdown?: {
      net_amount?: { currency_code: string; value: string };
    };
  };
  type Unit = {
    custom_id: string;
    payee: { merchant_id: string };
    amount: { currency_code: string; value: string };
    payments?: { captures?: Capture[] };
  };
  const units = data.purchase_units as Unit[] | undefined;
  const o = w.orders.find((o) => o.id === subjectId);
  const d = w.donations.find((d) => d.id === subjectId);
  const target = o ?? d;
  ensure(target, "NOT_FOUND", "Payment not found.");
  const expectedProfile = o
    ? w.suppliers.find((s) => s.id === o.supplierId)!.merchantProfile
    : w.organizations.find((x) => x.id === d!.organizationId)!.merchantProfile;
  ensure(
    profile === expectedProfile && data.id === target.providerId,
    "MERCHANT",
    "Provider order ownership does not match.",
    403,
  );
  ensure(
    units?.length === 1,
    "PROVIDER_DATA",
    "Unexpected PayPal purchase units.",
  );
  const unit = units[0];
  ensure(
    unit.custom_id === `${w.id}:${subjectId}` &&
      unit.payee?.merchant_id === merchant(profile).merchantId,
    "MERCHANT",
    "Payee or reference mismatch.",
    403,
  );
  ensure(
    unit.amount?.currency_code === "USD" &&
      unit.amount.value === decimal(o?.total ?? d!.amount),
    "PROVIDER_AMOUNT",
    "Order amount mismatch.",
  );
  const captures = unit.payments?.captures;
  ensure(
    captures?.length === 1 && captures[0].status === "COMPLETED",
    "PAYMENT_PENDING",
    "No completed capture is confirmed.",
    409,
  );
  const capture = captures[0];
  ensure(
    capture.amount.currency_code === "USD" &&
      capture.amount.value === decimal(o?.total ?? d!.amount),
    "PROVIDER_AMOUNT",
    "Capture amount mismatch.",
  );
  target.captureId = capture.id;
  if (o) {
    if (["awaiting_payer", "uncertain"].includes(o.status)) o.status = "paid";
    post(w, {
      organizationId: o.organizationId,
      fundId: o.fundId,
      amount: -o.total,
      kind: "spend",
      subjectId: o.id,
      source: capture.id,
      evidence: "paypal_sandbox",
    });
  } else {
    const net = capture.seller_receivable_breakdown?.net_amount;
    ensure(
      net?.currency_code === "USD",
      "NET_AMOUNT",
      "Net donation amount was not provided.",
    );
    const netCents = providerCents(net.value, "NET_AMOUNT");
    ensure(
      Number.isSafeInteger(netCents) && netCents >= 0 && netCents <= d!.amount,
      "NET_AMOUNT",
      "Invalid net receipt.",
    );
    d!.net = netCents;
    if (["awaiting_payer", "uncertain"].includes(d!.status))
      d!.status = "confirmed";
    post(w, {
      organizationId: d!.organizationId,
      fundId: d!.fundId,
      amount: netCents,
      kind: "donation",
      subjectId: d!.id,
      source: capture.id,
      evidence: "paypal_sandbox",
    });
  }
}
export function settleRefund(
  w: Workspace,
  profile: string,
  subjectId: string,
  data: Record<string, unknown>,
) {
  const r = w.recoveries.find((r) => r.id === subjectId);
  const d = w.donations.find((d) => d.id === subjectId);
  ensure(r || d, "REFUND", "Refund not found.");
  const order = r ? w.orders.find((o) => o.id === r.orderId)! : undefined;
  const expected = order
    ? w.suppliers.find((s) => s.id === order.supplierId)!.merchantProfile
    : w.organizations.find((o) => o.id === d!.organizationId)!.merchantProfile;
  ensure(profile === expected, "MERCHANT", "Refund merchant mismatch.");
  const money = data.amount as { currency_code: string; value: string };
  const legacy = data.amount as { currency: string; total: string };
  const currency = d?.subscriptionId ? legacy?.currency : money?.currency_code;
  const amount = d?.subscriptionId ? legacy?.total : money?.value;
  const status = d?.subscriptionId
    ? String(data.state).toUpperCase()
    : data.status;
  if (d?.subscriptionId)
    ensure(
      data.sale_id === d.captureId,
      "MERCHANT",
      "Refund sale does not match the original billing receipt.",
    );
  ensure(
    currency === "USD" && amount === decimal(r?.amount ?? d!.amount),
    "PROVIDER_AMOUNT",
    "Refund amount mismatch.",
  );
  // A completed refund ledger entry is final even when an older callback arrives.
  if (w.ledger.some(e => e.subjectId === subjectId &&
    e.kind === (r ? "purchase_refund" : "donation_refund"))) return;
  if (r) r.refundId = String(data.id);
  if (d) {
    d.refundId = String(data.id);
    d.refundStatus = status === "COMPLETED" ? "completed" :
      status === "FAILED" ? "failed" : "pending";
  }
  if (status === "COMPLETED") {
    if (r) {
      r.status = "refund_confirmed";
      post(w, {
        organizationId: r.organizationId,
        fundId: order!.fundId,
        amount: r.amount,
        kind: "purchase_refund",
        subjectId: r.id,
        source: String(data.id),
        evidence: "paypal_sandbox",
      });
    } else {
      d!.status = "refunded";
      post(w, {
        organizationId: d!.organizationId,
        fundId: d!.fundId,
        amount: -d!.amount,
        kind: "donation_refund",
        subjectId: d!.id,
        source: String(data.id),
        evidence: "paypal_sandbox",
      });
    }
  } else if (r)
    r.status = status === "FAILED" ? "refund_failed" : "refund_pending";
}
