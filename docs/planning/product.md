# Product requirements

## Outcome

Connect fundraising -> available funds -> approved purchasing -> recovery -> received stock -> recorded distributions. The main demo is a pantry preparing 50 kits with a $600 budget, encountering a partial supplier cancellation, completing the correct merchant-authorized refund, and approving a replacement. Those figures are scenario inputs, never measured community outcomes.

## Roles

Donor: published campaigns, one-time/recurring giving, own receipts/history, subscription cancellation. Organization owner: nonprofit/sites/memberships/campaign publication/finance assignment. Coordinator: stock/kits/requests/receiving/distribution. Finance: approvals, nonprofit donation refunds, fund restrictions/reconciliation. Supplier representative: own catalog, relevant fulfillment/cancellation, supplier refunds. Operator: server merchant configuration, service health, isolated demo lifecycle. Owner may hold finance authority; coordinator alone cannot approve spending. Supplier cannot refund another merchant's payment.

## Mandatory requirements and acceptance

| ID | Behavior | Acceptance |
|---|---|---|
| ORG-01 | Multiple independent organizations/sites/roles | Two nonprofits + two suppliers; cross-tenant and cross-role denial |
| ORG-02 | Membership management | Expiring single-use invitations, role revocation, organization access verified server-side |
| FUND-01 | Publish organization campaigns | Draft/published/closed, goals, kit target, restrictions, human publication |
| FUND-02 | One-time giving | Custom amount, payer approval, confirmed capture, cancellation/decline handling |
| FUND-03 | Monthly giving | $10/$25/$50/$100; activation distinct from billing receipt; own cancellation |
| FUND-04 | Donor operations | Own history, printable/downloadable acknowledgments, no public donor identities |
| MONEY-01 | Operational fund ledger | Integer cents, confirmed net receipts, fees, reservations, deficits, immutable transactions |
| MONEY-02 | Restricted funding | No automatic cross-purpose allocation; pending receipts/refunds never spendable |
| STOCK-01 | Inventory and kits | Lots/expiry/units, adjustments/transfers/reservations/receipts/distributions; safe CSV review |
| BUY-01 | Supplier catalog | Approved suppliers, versioned packs/prices/availability/delivery/shipping |
| BUY-02 | Purchasing proposals | Evidence references, pack rounding, full costs, constraints, alternatives/unresolved shortages |
| BUY-03 | Approved purchases | Exact 15-minute approval, revalidation, separate supplier order and PayPal payer approval |
| REC-01 | Recovery | Partial cancellation -> merchant-approved refund -> confirmed amount -> newly approved replacement |
| PAY-01 | Payment safety | Idempotency, verified events, timeout readback, merchant ownership, no double posting |
| STUDIO-01 | Operational analytics | Custom readiness/funds/recovery/evidence widgets; saved dashboards and agent-controlled views |
| AI-01 | Bounded agent | Synthetic/public inputs, structured output, deterministic validation, human financial handoff |
| UI-01 | Coherent product | Responsive donor/approval flow; keyboard, clear status, errors/loading/empty/permission states |
| OPS-01 | Runnable and recoverable | Local + hosted instructions; resume/reconciliation/backup restore; version-bound evidence |
| SUB-01 | Submission | Public licensed source, functional judge access, public video <3 minutes, evidence-backed write-up |

## Behavior details

Campaigns distinguish restricted purpose from unrestricted giving; restrictions cannot silently change after receipts. Subscription cancellation does not refund past giving. Amount changes require donor-approved replacement subscription. Donation acknowledgments clearly say sandbox and make no tax-deductibility claim. Public pages show aggregates, not donor identities. Missing allergens, expiry, product attributes and suitability remain unknown; no AI food/medical safety inference.

Inventory supports multiple sites, validated import preview, lot-level adjustments, stock transfers, kit component reservations, supplier receipt, and distribution counts. Planned, purchased, received and distributed kits stay separate. Recipient case records are outside this product boundary. Receive supplies before increasing stock. Complete kit counts use actual component quantities.

Staff review itemized cost including shipping, product evidence, exclusions and shortages. Finance approves the exact version; changed price/stock/fund/source invalidates approval. Supplier status includes accepted, partial fulfillment, fulfilled, cancelled and partial cancellation. Buyer cannot unilaterally issue supplier refund. Pending refund remains pending; replacement gets its own approval and checkout. Preserve original history on every recovery.

## Impact validation

Interview a coordinator, finance approver and supplier. Confirm current purchasing pain, PayPal acceptance, restrictions and substitutions. Compare identical tasks with/without product: planning time, corrections, budget compliance and shortages covered. No interview, simulation, planned purchase or sandbox payment establishes physical distribution. Preserve mandatory scope when sequencing changes.

## Persona/adoption scope addendum (2026-10-13)

The [21-group responsibility register](../adoption/personas-and-operations.md) adds buyer and privacy/governance hats as uninvestigated hypotheses. It preserves the five implemented app roles, approved feature scope and existing 19-group manual suite. No new access or real adoption is implied. Role navigation guidance and clear donor pending/failed refund explanations implement UI-01/PAY-01; [the assessment](../adoption/improve-assessment.md) defines AD-R01..04, repeatable evaluation, alternatives, costs and held claims. This is supported local improvement, not validated customer need, production readiness or a winning-probability claim.
