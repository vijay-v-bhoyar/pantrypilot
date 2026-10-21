import { z } from "zod";
import { randomUUID } from "node:crypto";
import { paypal, verifyEvent, merchant, decimal } from "@/lib/paypal";
import { providerCents } from "@/lib/money";
import { settleCapture, settleRefund } from "@/lib/payments";
import { body, respond } from "@/lib/http";
import { ensure } from "@/lib/errors";
import { withWorkspace } from "@/lib/storage";
import { post } from "@/lib/commands";
const schema = z.object({
  id: z.string().min(1).max(100),
  event_type: z.string().min(1).max(100),
  resource: z.record(z.string(), z.unknown()),
});
export async function POST(request: Request) {
  return respond(async () => {
    const params = new URL(request.url).searchParams;
    const profile = z
      .string()
      .regex(/^[a-z0-9-]{1,40}$/)
      .parse(params.get("profile"));
    const workspaceId = z.string().uuid().parse(params.get("workspace"));
    const event = schema.parse(await body(request));
    await verifyEvent(profile, request.headers, event);
    const resource = event.resource;
    return withWorkspace(workspaceId, async (w) => {
      if (
        w.providerEvents.some((e) => e.id === event.id && e.profile === profile)
      )
        return { duplicate: true };
      if (
        event.event_type === "PAYMENT.CAPTURE.REFUNDED" ||
        event.event_type === "PAYMENT.SALE.REFUNDED" ||
        event.event_type.startsWith("PAYMENT.REFUND.")
      ) {
        const refundId = String(resource.id);
        const subject =
          w.recoveries.find((r) => r.refundId === refundId) ??
          w.donations.find((d) => d.refundId === refundId);
        ensure(
          subject,
          "EVENT_OWNER",
          "Refund is not associated with this workspace. Operator reconciliation is required for external refunds.",
        );
        const refund = await paypal(
            profile,
            event.event_type === "PAYMENT.SALE.REFUNDED"
              ? `/v1/payments/refund/${refundId}`
              : `/v2/payments/refunds/${refundId}`,
          );
        ensure(refund.id === refundId, "EVENT_OWNER", "Refund resource mismatch.");
        settleRefund(w, profile, subject.id, refund);
      } else if (event.event_type.startsWith("PAYMENT.CAPTURE.")) {
        const supplementary = resource.supplementary_data as {
          related_ids?: { order_id?: string };
        };
        const orderId = supplementary?.related_ids?.order_id;
        ensure(
          typeof orderId === "string",
          "EVENT",
          "Capture event has no related order.",
        );
        const subject =
          w.orders.find((o) => o.providerId === orderId) ??
          w.donations.find((d) => d.providerId === orderId);
        ensure(subject, "EVENT_OWNER", "Unknown payment for this workspace.");
        if (event.event_type === "PAYMENT.CAPTURE.COMPLETED") {
          const read = await paypal(profile, `/v2/checkout/orders/${orderId}`);
          const units = read.purchase_units as { payments?: { captures?: { id?: string }[] } }[] | undefined;
          ensure(typeof resource.id === "string" && resource.id.length > 0 &&
            units?.[0]?.payments?.captures?.[0]?.id === resource.id,
            "EVENT_OWNER", "Capture resource mismatch.");
          settleCapture(w, profile, subject.id, read);
        }
        else if (event.event_type === "PAYMENT.CAPTURE.REVERSED") {
          const order = w.orders.find((o) => o.id === subject.id);
          const donation = w.donations.find((d) => d.id === subject.id);
          const expected = order
            ? w.suppliers.find((s) => s.id === order.supplierId)!
                .merchantProfile
            : w.organizations.find((o) => o.id === subject.organizationId)!
                .merchantProfile;
          ensure(profile === expected, "MERCHANT", "Event merchant mismatch.");
          const capture = await paypal(
            profile,
            `/v2/payments/captures/${subject.captureId}`,
          );
          ensure(typeof subject.captureId === "string" && subject.captureId.length > 0 &&
            resource.id === subject.captureId && capture.id === subject.captureId,
            "EVENT_OWNER", "Reversed capture resource mismatch.");
          const amount = capture.amount as { currency_code?: string; value?: string } | undefined;
          ensure(amount?.currency_code === "USD" && amount.value === decimal(order?.total ?? donation!.amount),
            "AMOUNT", "Reversed capture amount mismatch.");
          ensure(
            capture.status === "REFUNDED" || capture.status === "REVERSED",
            "STATE",
            "Capture reversal is not confirmed.",
          );
          post(w, {
            organizationId: subject.organizationId,
            fundId: subject.fundId,
            amount: order ? order.total : -(donation!.net ?? donation!.amount),
            kind: "reversal",
            subjectId: subject.id,
            source: event.id,
            evidence: "paypal_sandbox",
          });
        }
      } else if (event.event_type.startsWith("BILLING.SUBSCRIPTION.")) {
        const subscription = w.subscriptions.find(
          (s) => s.providerId === resource.id,
        );
        ensure(
          subscription,
          "EVENT_OWNER",
          "Subscription is not associated with this workspace.",
        );
        const expected = w.organizations.find(
          (o) => o.id === subscription.organizationId,
        )!.merchantProfile;
        ensure(
          expected === profile,
          "MERCHANT",
          "Subscription merchant mismatch.",
        );
        const read = await paypal(
          profile,
          `/v1/billing/subscriptions/${subscription.providerId}`,
        );
        ensure(
          read.id === subscription.providerId && read.custom_id === `${w.id}:${subscription.id}`,
          "EVENT_OWNER",
          "Subscription reference mismatch.",
        );
        const status = String(read.status);
        if (["ACTIVE", "CANCELLED", "SUSPENDED"].includes(status))
          subscription.status = status.toLowerCase() as
            | "active"
            | "cancelled"
            | "suspended";
      } else if (event.event_type === "PAYMENT.SALE.COMPLETED") {
        const subscription = w.subscriptions.find(
          (s) => s.providerId === resource.billing_agreement_id,
        );
        ensure(
          subscription,
          "EVENT_OWNER",
          "Billing payment does not belong to this workspace.",
        );
        ensure(
          w.organizations.find((o) => o.id === subscription.organizationId)!
            .merchantProfile === profile,
          "MERCHANT",
          "Billing merchant mismatch.",
        );
        const sale = await paypal(
          profile,
          `/v1/payments/sale/${String(resource.id)}`,
        );
        ensure(
          typeof resource.id === "string" && resource.id.length > 0 && sale.id === resource.id && sale.state === "completed" &&
            sale.billing_agreement_id === subscription.providerId,
          "STATE",
          "Billing payment is not confirmed.",
        );
        const money = sale.amount as { currency: string; total: string };
        ensure(
          money?.currency === "USD" &&
            providerCents(money.total) === subscription.amount,
          "AMOUNT",
          "Subscription billing amount mismatch.",
        );
        const fee = sale.transaction_fee as
          | { currency: string; value: string }
          | undefined;
        ensure(
          fee?.currency === "USD",
          "FEE",
          "Billing fee missing; reconciliation required.",
        );
        const net = subscription.amount - providerCents(fee.value, "FEE");
        ensure(
          Number.isSafeInteger(net) && net >= 0 && net <= subscription.amount,
          "AMOUNT",
          "Invalid net billing amount.",
        );
        const campaign = w.campaigns.find(
          (c) => c.id === subscription.campaignId,
        )!;
        let receipt = w.donations.find((d) => d.captureId === resource.id);
        if (!receipt) {
          receipt = {
            id: randomUUID(),
            organizationId: subscription.organizationId,
            donorId: subscription.donorId,
            campaignId: campaign.id,
            fundId: campaign.fundId,
            amount: subscription.amount,
            net,
            status: "confirmed",
            captureId: String(resource.id),
            evidence: "paypal_sandbox",
            createdAt: new Date().toISOString(),
            subscriptionId: subscription.id,
          };
          w.donations.push(receipt);
        }
        post(w, {
          organizationId: subscription.organizationId,
          fundId: campaign.fundId,
          amount: net,
          kind: "donation",
          subjectId: receipt.id,
          source: event.id,
          evidence: "paypal_sandbox",
        });
      } else return { ignored: true, eventType: event.event_type };
      merchant(profile);
      w.providerEvents.push({
        id: event.id,
        profile,
        receivedAt: new Date().toISOString(),
      });
      return { processed: true };
    });
  });
}
