# Data, money and interface contracts

October 15 approved implementation addendum: [stock correction command schemas, exact owner approval, provenance/compensation and blank owner setup](approved-local-repairs-2026-10-15.md). These are the current contracts for the new workflows; historical proposal/default descriptions are superseded within this local scope.

## Records and identity

Organizations/sites/memberships/invitations/donors/supplier memberships; campaigns/fund restrictions/donation intents/donations/subscriptions/acknowledgments; ledger transactions/entries/reservations/payment operations/merchant connections; items/lots/movements/kits/components/distributions; suppliers/approved links/catalog versions/requests/proposals/approvals/orders/lines; fulfillment/recovery/refund/replacement links; provider events/reconciliation jobs/agent runs/tool results/audit/dashboard definitions.

Logical ownership requires an organization reference. Current JSON aggregate records use organizationId; SQL membership/workspace foreign keys do not constrain references inside JSON. Current server-scoped checks enforce these references; inspect actual source/negative tests rather than assuming installed entity-table foreign keys. Donor access follows identity; supplier follows membership and assigned order. RLS on client data; server authorization precedes privileged credential use. Never trust organization_id or role supplied by a browser.

Logout revokes the current app nonce in private workspace state until its expiry and signs out the current Supabase session, preserving other app sessions. Protected requests check nonce revocation; AppView omits tombstones. Failed durable/provider revocation clears browser credentials but returns LOGOUT_UNCONFIRMED 503. The optional revokedSessionNonces field shares the existing leased aggregate; old records without the field remain valid. Exact project token/verifier cookies are cleared; other-project cookies are preserved.

## Logical type requirements

The following conventions describe the planned logical contract, not the current TypeScript/wire declaration. The implementation profile below is authoritative for writing current fixtures.

- Money: `{currency:'USD', amountMinor:string}`; decimal integer cents string on wire; integer cents internally, no floating arithmetic.
- PurchaseProposal: version/digest/source versions/fund/items/packs/costs/shipping/exclusions/shortages/expiry.
- Approval: actor/org/action/digest/amount/payee/fund/source versions/expiresAt/consumed.
- PaymentOperation: owning merchant/idempotency key/provider IDs/status/verified amounts/timestamps.
- AgentRun: permitted data classification/inputs/tool evidence/proposal/validation/handoff.

## Rules

Campaign progress is the server-computed aggregate of confirmed donation ledger credits minus completed donation refunds and donation-linked reversals, scoped by organization and campaign fund. Opening balances, purchase spending, supplier refunds, purchase reversals, pending refunds and promised subscription payments are not campaign giving. The AppView `campaignReceived` map contains only visible campaign IDs and integer cents; donors receive this aggregate without gaining private ledger/fund access. Staff, donor and public progress use the same calculation and label it net confirmed giving.

Available funds = confirmed net donation/opening receipts + completed purchase refunds - expenditures - current commitments - completed donation refunds. Do not double-count converted reservations. Unknown fees/receipts await reconciliation. Pending captures, future subscription payments, pending refunds and simulated promises are not provider-confirmed funds. Deficits remain visible and block new spending. Opening balance requires finance/source evidence (synthetic seeds labeled). Reserve and release atomically. Ledger never rewritten to conceal history.

Approval lasts 15 minutes and binds exact action/amount/merchant/fund/digest/source versions. Revalidate and consume once. Any material change requires new approval. One supplier order per checkout; every payer authorizes PayPal checkout. Refund issued only by original receiving merchant with correct human authority. Request timeout -> uncertain -> readback; never blind repeat or false success. Use stable provider request IDs and event-ID deduplication. Event mapper resolves known operations and verifies webhook/account; never trusts webhook metadata to create ownership.

## Interfaces

Campaign/member management; donation create/order/capture/status; subscription create/status/cancel; import review/stock movement/reserve/receive; request/propose/approve/checkout; cancellation/refund request/merchant approval/replacement; scoped analytics/save/query; verified PayPal webhook; authenticated bounded reconciliation; isolated demo-session create/expiry/reset. Mutations validate schemas, actor, tenant, intent and idempotency. Errors: validation 422, unauthenticated 401, unauthorized 403, missing 404, stale/conflict 409, quota 429, provider unavailable 503, uncertain payment explicit state.

## Logical state progression

These conceptual progressions are not current enum declarations. Use the implementation profile/current types for fixtures; planned intermediate states are not implemented features.

Donation: created -> awaiting_payer -> processing -> confirmed; cancelled/failed/reversed/refund pending/refunded separate. Subscription status != billing transaction. Purchase: draft -> proposed -> approved -> awaiting_payer -> paid -> fulfillment -> received. Recovery: opened -> refund_requested -> merchant_approved -> refund_pending -> refund_confirmed -> replacement_proposed -> resolved. Exception state attaches history rather than deletes it.

CSV exports neutralize spreadsheet formula prefixes; imports reject ambiguous units, invalid/negative quantities and invalid money before commit. All financial writes are serialized transactionally. Idempotency keys bind operation kind/subject/body/actor and cannot replay another actor's result.

## Reconciliation response and progress (2026-10-13)

POST `/api/reconcile` requires `Bearer` plus a configured minimum-32-character job token. The server ignores client tenant/action/cursor requests. Select one workspace by null-first `payload->>reconcileScannedAt`, then ID; under the existing lease, persist scan time and `reconcileCursor` for each dispatch. Maximum four eligible candidates per run and a 25-second dispatch cutoff. A completed readback returns actual domainStatus and status: confirmed, pending, failed, active, cancelled, suspended or needs_review. `readback` is completed, unresolved or not_started. Active subscriptions never imply collected funds. Donation `refundStatus` records pending/failed/completed without treating a failed refund as completed money. Provider resource IDs and subscription custom ownership must match before settlement.

`candidateCount` is initial eligible subjects in the selected workspace; `examined` includes actor-unavailable review results; `remaining` is initial candidates not examined, explicitly scoped by `remainingScope: selected_workspace`. It does not count all pending outcomes or the global backlog. Metadata persistence failure prevents provider dispatch. No schema migration is required for the optional aggregate fields. Real DB/provider/scheduler qualification remains open; see [remediation evidence](../verification/reconciliation-remediation-2026-10-13.md).

## Current implementation profile (strict review, 2026-10-13)

Money is a safe integer JavaScript number of USD cents in domain records/commands (for example amount=2500), not a persisted amountMinor string object. PayPal decimal-string conversion/validation is a separate boundary. Workspace records use camelCase IDs such as organizationId. Supabase stores the workspace as leased revision-checked JSON; memberships reference auth user/workspace rows, runtime quotas have a separate table, and JSON entity references rely on server checks. No normalization/migration was performed by this review.

Actual donation states: awaiting_payer, uncertain, confirmed, cancelled, refund_pending, refunded; optional refundStatus is pending/failed/completed. Reversal is an immutable ledger kind, not a donation enum. Subscription: awaiting_payer, active, cancelled, suspended; activation is not a receipt. Order: awaiting_payer, uncertain, paid, accepted, partial, fulfilled, received, cancelled. Recovery: opened, refund_requested, refund_pending, refund_confirmed, replacement_proposed, resolved, refund_failed; merchant_approved is not an enum. Payment-operation completed describes an operation, not confirmed money. See src/lib/types.ts and source-bound negative tests.

Webhook local validation contract (October 14): returned refund/subscription/sale IDs match requested resources; capture callbacks and reversed captures bind original IDs; reversal currency/gross/status are checked. Provider amounts and capture net use exact nonnegative whole-cent parsing, reject fractional cents/exponents/whitespace/unsafe values and negative fees, and keep net at or below gross. Confirmed refund postings retain final metadata across older pending/failed readbacks. 77 full-handler transport-fixture cases pass; actual provider event shapes/timing and hosted callbacks remain unqualified. [Current implementation](../verification/workflow-build-2026-10-14.md).

Local atomic persistence retries only the same staged rename for EPERM/EACCES/EBUSY, at most three attempts with 50/100ms waits; never rerun the mutation or provider operation. Other errors and exhausted locks fail while retaining the old record. Seven controlled file-I/O cases and original browser workflows pass; no hosted-storage behavior changes.
