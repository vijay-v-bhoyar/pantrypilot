"use client";
import type { Role } from "@/lib/types";
type GuideSection = "overview" | "settings" | "campaigns" | "inventory" |
  "procurement" | "recovery" | "supplier" | "donor" | "audit";
const workflows: Record<Role, { limit: string; steps: { title: string; detail: string; section: GuideSection }[] }> = {
  owner: {
    limit: "Manage only your organization. Supplier refunds require the original supplier merchant.",
    steps: [
      { title: "Set up your pantry", detail: "Check your organization and sites, then invite people with the access they need.", section: "settings" },
      { title: "Publish a clear campaign", detail: "Review the purpose and restrictions before publishing. Draft campaigns are not public giving pages.", section: "campaigns" },
      { title: "Coordinate a purchase", detail: "Review stock and the itemized basket. Finance approval binds to the current version; changed inputs need a fresh approval.", section: "procurement" },
      { title: "Review the activity trail", detail: "Check receipts, unresolved work and access changes. Sign out when finished; keep pending financial records.", section: "audit" },
    ],
  },
  coordinator: {
    limit: "Finance approves the exact basket and handles buyer payments. You record actual stock, receipt and distribution.",
    steps: [
      { title: "Review stock and kits", detail: "Check usable units, expiry, reservations and kit components. Preview CSV changes before importing.", section: "inventory" },
      { title: "Prepare a purchase request", detail: "Specify kits, site, purpose, budget and deadline. Review pack sizes, shipping and unresolved shortages, then hand the basket to finance.", section: "procurement" },
      { title: "Receive delivered supplies", detail: "Supplier fulfillment is not pantry receipt. Confirm only supplies that actually arrived before increasing stock.", section: "procurement" },
      { title: "Record kit distributions", detail: "Use received, usable stock. Keep planned, purchased and distributed quantities separate.", section: "inventory" },
      { title: "Recover a short delivery", detail: "Keep the original case. Finance and the supplier handle the refund; a replacement needs its own proposal and approval.", section: "recovery" },
    ],
  },
  finance: {
    limit: "Use confirmed net funds for the permitted purpose. Pending payments and refunds are not available money.",
    steps: [
      { title: "Inspect funds and commitments", detail: "Check receipts, fees, restrictions and existing commitments before approving new spending.", section: "overview" },
      { title: "Review a purchase basket", detail: "Inspect every item, pack, shipping cost and supplier. Approve the current version, then complete the separate payer step.", section: "procurement" },
      { title: "Resolve uncertain payments", detail: "Read the existing payment status before another attempt. Do not repeat a financial action to clear an uncertain result.", section: "procurement" },
      { title: "Review recovery and replacement", detail: "Request the original merchant refund. Wait for confirmation before using returned funds; approve a replacement separately.", section: "recovery" },
      { title: "Inspect the recorded outcome", detail: "Review the ledger and activity after each task. Retain pending obligations when pausing or signing out.", section: "audit" },
    ],
  },
  supplier: {
    limit: "Act only on your supplier's offers and orders. You cannot approve buyer spending or another merchant's refund.",
    steps: [
      { title: "Review your offers", detail: "Keep pack sizes, stock, price, shipping and delivery evidence current. Unknown product facts stay unknown.", section: "supplier" },
      { title: "Fulfill your orders", detail: "Check the paid order, accept it and record actual fulfillment quantities. The pantry confirms physical receipt separately.", section: "supplier" },
      { title: "Handle a cancellation or refund", detail: "Preserve fulfilled quantities. Issue a refund only after the buyer request and merchant authorization; pending or failed results require status review.", section: "supplier" },
    ],
  },
  donor: {
    limit: "Your history is private. Cancelling monthly support stops future billing; it does not refund past gifts. Closing the browser or signing out does not cancel it.",
    steps: [
      { title: "Choose a campaign", detail: "Read its purpose and confirmed progress before choosing whether to give.", section: "campaigns" },
      { title: "Review and approve your gift", detail: "Check the amount and frequency, then complete the separate payer approval. A pending payment is not a confirmed gift.", section: "donor" },
      { title: "Inspect your gift history", detail: "Check the confirmed result and acknowledgment. If a payment or refund is uncertain, read its existing status or contact the pantry.", section: "donor" },
      { title: "Manage monthly support", detail: "Activation alone is not a billing receipt. Review confirmed payments and explicitly cancel future support when you choose.", section: "donor" },
    ],
  },
};
export default function WorkflowGuide({ role, simulated, busy, navigate }: {
  role: Role; simulated: boolean; busy: boolean; navigate: (section: GuideSection) => void;
}) {
  const guide = workflows[role];
  return (
    <details className="workflow-guide" key={role}>
      <summary>Your {role} workflow</summary>
      <p>{simulated ? "No real money moves in this simulation." : "Payments use PayPal sandbox. A completed request is not itself a confirmed payment."} This guide helps you choose a next task; it does not mark work complete.</p>
      <ol>
        {guide.steps.map(step => (
          <li key={step.title}>
            <button type="button" className="text-link" disabled={busy} onClick={() => navigate(step.section)}>{step.title}</button>
            <p>{step.detail}</p>
          </li>
        ))}
      </ol>
      <p><strong>Your boundary:</strong> {guide.limit}</p>
    </details>
  );
}
