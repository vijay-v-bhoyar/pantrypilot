# Assurance and acceptance

Required full-product gate: ORG-01..SUB-01 in product.md. Two nonprofits/two supplier merchants; complete fundraising/subscriptions/inventory/procurement/recovery; licensed hosted Studio and local version; provider evidence or explicit uncertainty. No placeholder may count as capability proof.

## Tests

Authorization: cross-tenant and forged role/identity, donor privacy, supplier ownership. Money: concurrent reservations, restrictions, fees, conversion, refunds, reversals/deficits/double posting. Payment: success/decline/cancel/timeout after capture/replay/readback. Events: invalid signature/merchant, duplicate/delay/out-of-order. Recurring: activation vs confirmed billing, failed billing, own cancellation, later billing cycle using explicitly labeled accelerated sandbox plan. Procurement: packs/price/shipping/expiry/stock/version/impossible request. Recovery: partial cancel, unauthorized refund, pending/failed refund, new approval. AI: malicious catalog, invented SKU, invalid structure, quota, stale source, privacy. UI: keyboard/mobile/contrast/error states/console. Operations: restart/resume/restore/migration/config/runtime identity.

30 deterministic agent scenarios; 12 live model cases. All critical authority/privacy/payment-safety cases pass. >=90% live planning cases yield valid proposals or correct infeasibility. Provider-backed cases remain BLOCKED until configured/authorized, never counted using simulation. Production build, local served browser, hosted provider tests and human interview evidence separate.

## Threat controls

HttpOnly signed sessions, no browser-chosen privileged role; origin verification for cookie mutations; secure hosted cookies; tenant authorization; safe schema/HTML/CSV handling; no arbitrary provider endpoints; approved catalog provenance; bounded AI; database serialization; idempotency ownership; exact payee/amount; verified events; readback; stop switch; secrets excluded; no live PayPal; no paid fallback. Unknown provider outcome never releases funds or triggers duplicate action.

## Evidence ledger

Requirement -> changed surface -> command/journey -> result -> source hash/target -> artifact -> remaining gap. Labels PASS/FAIL/BLOCKED/DEGRADED/SKIPPED/NOT RUN. Keep original failure, correction and original-check rerun. Final release NO_GO if mandatory provider/hosted/licensing/approval evidence missing. No real recipient data or impact claims.

## October 13 persona/assurance reassessment

The current twelve-case live runner varies planner quantity and budget; it does not qualify native analyst, hostile inputs, privacy, interruption or live cancellation by itself. Those obligations remain in the expanded persona suite (PP-T13). Full-route webhook and reconciliation testing is also separate from payment-library fixtures (PP-T14/PP-T15). The adapter accepts only USD MONTH/interval-1 plans: the earlier accelerated-cycle proposal remains an unresolved fixture/policy requirement and cannot bypass that guard. Actual later-cycle evidence needs an independently approved procedure. Source findings and the expanded manual variants are recorded in ../testing/personas-workflows-coverage.md. No provider calls, accelerated plan change or deployment were performed for this reassessment.
