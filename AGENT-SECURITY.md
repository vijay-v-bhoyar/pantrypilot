# Agent Security Profile: PantryPilot planning and analytics agents

**Verdict: BLOCKED for external qualification** — hosted credential isolation, provider behavior, global quota and distributed in-flight cancellation are unqualified. Local simulation and contract fixtures do not grant external clearance. Provider actions default disabled.

## 1. Identity & purpose

The application server owns provider credentials. Each run has an actor-checked nonprofit, run ID, source and evidence. The model sees bounded projected synthetic operational data; it drafts baskets or selects a dashboard focus. It has no payment, refund, member-management, shell, filesystem, HTTP or control-plane tool. Operated by the project owner.

## 2. Threat-model deltas

Catalog evidence and model reasoning remain untrusted even inside the demo. A synthetic-workspace flag alone does not sanitize arbitrary text, so AI projects component SKUs, quantities and attributes, safe catalog offers and stock quantities. Custom kit/lot names, coordinator notes, donor names, receipts, merchant credentials and audit details are excluded. Analytics accepts four canned operational prompts rather than arbitrary free-text egress.

## 3. Inventory

| # | Item | Kind | Scope | TTL | Notes |
|---|---|---|---|---|---|
| 1 | Signed application session | identity | One workspace and current actor membership | 24h | Rechecked on output save |
| 2 | Gemini server key | credential | One explicitly configured provider project | Owner-managed | Dedicated restricted key and broker qualification pending |
| 3 | catalog / inventory / compare | tool | Projected approved synthetic nonprofit records | One run | Six calls total |
| 4 | selectDashboard | tool | Four fixed view types | One run | No record mutation |
| 5 | Model request | egress | Google adapter, server only | 60s planner / 30s analyst | No model-selected endpoint; infrastructure egress qualification pending |
| 6 | Model reasoning | egress | Escaped React plain text | Stored run/proposal | No Markdown/image/HTML execution |
| 7 | Proposal/run evidence | persistence | Authorized workspace | Workspace lifecycle | No policy/config writes |
| 8 | Stop control | control plane | Organization owner only | Until resumed | Same-process AbortController; other instances reject output on save |

## 4. Trifecta analysis

Local rule planner: no model/network egress. Synthetic model planner: untrusted catalog/model content + provider/output egress; private-data leg removed by server projection and approved SKU checks. Analytics: canned prompt only; model sees no ledger/private records. Non-demo workspaces fail the AI admission check. Provider credentials stay outside model/tool data.

## 5. Authority matrix

| Action | Class | Disposition | Enforcement |
|---|---|---|---|
| Read projected catalog/stock | Read | Staff, synthetic only | Session actor + AI admission |
| Draft proposal | Reversible write | Deterministically recomputed | Catalog identity/version, stock digest, constraints |
| Arrange Studio | Reversible view | Four validated focus layouts | Tool schema + fixed client layout builder |
| Purchase/refund | Financial | Model denied | Absent from agent toolset; human role/digest/merchant controls elsewhere |
| Change permissions/config | Privileged | Model denied | Absent from toolset |
| Pause AI | Control | Owner only | Server role and organization check |

## 6. Surface hardening

Strict schemas, escaped outputs, fixed provider adapter, no arbitrary model fetch, no recipient records, secrets excluded from logs/source, persisted failed runs, daily quota, one active run per workspace, ten-second admission gap, six model steps/tools and timeout. Owner pause aborts active same-process calls and discards subsequent output. Security fixtures exercise privacy projection, injection/invented SKU containment, role change, quota and in-flight abort. No model can rewrite these server controls.

## 7. Blast-radius statement

A fully adversarial model can produce untrusted text or choose among approved synthetic catalog IDs and four analytics layouts. Deterministic validation can reject the basket, and humans must separately authorize all money. A single run is bounded to six model steps and six reads; failed attempts consume the quota. Worst-case free-service quota consumption remains possible across many isolated workspaces; no paid fallback exists. This does not establish production-level provider isolation.

## 8. Residual risks

High: cross-instance/model cancellation and app-to-database quota enforcement remain unqualified; provider actions disabled, accepted-by **none** for external activation. Shared database admission passed direct SQL/concurrency probes, while local counters are explicitly local-only. The native Studio runner passes only approved canned questions to the authenticated server, ignores Studio history/context/tools/state and validates the returned focus before applying a layout. Browser cancellation and late-response rejection are locally tested; real Gemini cancellation remains open. High: dedicated credential broker/egress infrastructure not established; no live-key use in this build. Aggregate storage/reconciliation are bounded and not qualified for public scale. Revalidate on model, SDK, tools, auth, storage or hosting changes.

## 9. Validation plan

Local fixtures: private-data projection, invented catalog, unauthorized actor, quota/rate, active abort and output-time reauthorization. Provider gates: 12 real model cases, sandbox merchant captures/refunds/signatures/recurrence, real Supabase leases/auth, multi-instance stop, licensing and hosted role journey. Run the AI red-team suite before external clearance; no claim of completed live red teaming.
