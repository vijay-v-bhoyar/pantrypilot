# Explicit diagnostic model registry — locally verified

The separate `PP-FEAS-01-GEMINI-36-PROBE-01` policy binds `gemini-3.6-flash`; the original `PP-FEAS-01-INITIAL-PROBE-01` binds `gemini-3.8-flash`. Both retain the same three count/three generation ceiling. Initialization, manifest reads, direct policy creation and owner scope reject crossed model/policy records. No default model, fallback or persistent configuration changes are introduced. All original twelve-case fixtures, financial/request checks, H2 and H3 budgets and verdicts remain unchanged. Local verification is not model access, successful generation or qualification. Failed histories/locks must be preserved and separately reconciled before any later admitted run.

# PF-01 qualification contracts

## H3 separate hackathon gate — implemented, provider qualification pending

The source includes `scripts/hackathon-eval.ts` and `scripts/lib/planner-hackathon.ts`, with shared closed H2/H3 internals in planner-campaign/quota. H3 uses manifest schema3 and policy PP-FEAS-01-HACKATHON-H3. It preserves all twelve cases below, their budgets/targets/frozen request identities, original deterministic comparisons and unchanged >=11/12 verdict. H3permits at most six count/generation pairs per case and144combined requests per campaign, not six required repetitions. Project daily accounting remains20combined per Pacific date. Cases can share a date only after the previous case has a complete durable outcome and a fresh exact single-case approval admits twelve-request headroom. No partial-case continuation, replay, quota reset or cross-campaign result selection is allowed.

Before key access, admission binds the actual source/build/configuration/manifest, project/model/operator/credential reference, next case, journal head, PID/nonce, owner approval hash, fresh usage/quiet evidence and activation. Usage observation must be at most60seconds old at admission after a15minute quiet settle. Window duration is at most5minutes, stays within one Pacific date and ends by November12,2026 at20:00UTC; active approval-window and original60second AI aborts propagate to transport. External known-use deltas are charged once in the same canonical project journal. Failed/ambiguous pairs retain their reservations; no extra charge is inferred from repeated poison rows. Fresh remaining usage is not inferred from another key or a new runtime folder.

Status/finalize operations read no key. Initialization requires a separately approved input hash and existing clean canonical ledger; it does not create/reset a project origin. Runtime uses a new H3_SINGLE_CASE grant with maxHttpRequests12 and matching activation, never an initial six-request probe approval promoted to campaign authority. Ordinary FAILrows are retained; infrastructure uncertainty retains a lock and stops future work. Finalization requires all12ordered outcomes, original verdict/effects checks and generation evidence for passing cases; H3writes `hackathonGateAccepted` and `fullCampaignAccepted:false`, never H2acceptance. Local fake-transport/clock results are not real provider or quota evidence.

## Owner runtime and diagnostic deadline

The maintained owner launcher has separate diagnostic and H3 modes. An exact source inventory, scope hash, initialized manifest, current source/build and ledger head are checked before private input is requested. Activation binds the actual Node PID and a fresh nonce. H3 keeps its existing exact grant validation and fixed budgets; diagnostic scope remains at most three count/generation pairs. The additional approval signal preserves live shared request counters and reaches both count and generation transports. A late start receives only the time remaining before the absolute approval deadline. No extra process-kill grace extends that deadline.

The hidden owner prompt, private pipe and per-release write-once records are separate from ordinary demo setup. The source export includes no live activation records or credentials. A failed/uncertain dispatch preserves its lock and charged reservations; neither a fresh launcher nor an accounting handoff erases that history. Fake-pipe/transport tests establish local control behavior, not real provider success, owner attendance or credential validity.

## H2 original full qualification — preserved, pending later

The following original H2contract remains available, with its original schema2behavior and distinct-date restriction. It is not the current separate H3hackathon gate. Ten pairs and240combined requests are ceilings, not forced usage. Original H2qualification has not passed.

# PantryPilot implementation and evaluation contracts

This public summary describes the exported implementation and its limits. It does not replace or relax approved requirements, original assertions or historical evidence.

## Records, authority and money

PantryPilot supports giving, donor acknowledgments, inventory, kit recipes, procurement proposals, supplier orders, recovery/refunds, receiving, distribution and analytics. Owner, finance, coordinator, supplier and donor access is scoped by actor, organization and resource ownership. Supplier roles are limited to assigned orders; donor roles are limited to their permitted records. Browser-supplied roles and organization identifiers are untrusted. Inspect server authorization and negative route/domain tests rather than inferring entity-level database constraints from aggregate JSON.

Money uses integer cents. Model output cannot purchase, refund, manage members or change permissions. Finance approves the exact purchase version; stale approvals, changed sources, restrictions, duplicate delivery and merchant ownership are checked. A pending refund is not spendable money. Paid orders, received stock and distributed kits remain separate facts. Physical corrections preserve provenance and require the implemented owner approval, distinct from the proposer. Original records and uncertain outcomes must remain available for reconciliation.

Local persistence uses atomic files and one process. Hosted identity, database isolation, concurrency, scheduler/provider ordering and distributed cancellation require their own evidence. The model sees bounded projected synthetic inputs, uses constrained tools and must pass deterministic validation. Provider output remains untrusted. Credentials are server-side and excluded from model inputs and logs.

## PF-01 H2 synthetic campaign

The canonical cases remain in `scripts/lib/planner-evaluation.ts`. H2 definitions are in `scripts/lib/planner-quota.ts`; frozen requests, source/build binding, journal verification and finalization are in `scripts/lib/planner-campaign.ts`. Maintained tests include `tests/planner-campaign.test.ts`, `tests/planner-campaign-cli.test.ts`, `tests/planner-clock.test.ts`, `tests/planner-quota.test.ts`, `tests/planner-evaluation.test.ts`, `tests/live-eval-model-config.test.ts` and `tests/model-budget.test.ts`.

| Pacific quota day | Case | Target kits | Budget, cents |
|---|---|---|---|
| D0 | 1 | 20 | 1 |
| D1 | 2 | 23 | 60000 |
| D2 | 3 | 26 | 60000 |
| D3 | 4 | 29 | 60000 |
| D4 | 5 | 32 | 1 |
| D5 | 6 | 35 | 60000 |
| D6 | 7 | 38 | 60000 |
| D7 | 8 | 41 | 60000 |
| D8 | 9 | 44 | 1 |
| D9 | 10 | 47 | 60000 |
| D10 | 11 | 50 | 60000 |
| D11 | 12 | 53 | 60000 |

Use twelve distinct Pacific quota dates, one case per day. The owner policy allows at most 20 total HTTP requests/day: at most ten countTokens and ten generateContent calls, not twenty of each. Campaign ceilings are 120 of each class, 240 combined. Reserve a pair before counting; failures and uncertain outcomes retain reservations. No warmup, model-list call, count retry, borrowed daily capacity or fresh-root accounting reset is permitted.

Per-run generation limits are ten attempts, 32768 serialized UTF-8 bytes/request, 1024 output tokens and 300000 ms. The session generation ceiling is twenty; H2's paired daily accounting additionally limits a case to ten generations. Counts have a ten-second ceiling; planner case time is sixty seconds and active block time five minutes. Six model steps and zero SDK retries remain. Pacing allows at most four starts per endpoint class per rolling minute and at least sixteen seconds between starts. Real waiting and I/O consume the budgets.

Preflight counts must be positive safe integers <=50000. Each generation reserves 62500 input tokens, with actual usage required and reconciled. The 12500-token margin is an engineering policy, not an official tokenizer bound or absolute TPM guarantee. Missing/malformed usage, overruns, poisoned accounting or uncertain provider state stop future egress. Preserve evidence; do not erase, retry or relabel an interrupted case as a success.

Final acceptance requires exactly cases 1-12 once in order, at least eleven PASS rows, zero BLOCKED rows, no infrastructure failure and unchanged protected arrays: ledger, orders, donations, recoveries, inventory, distributions and approvals. A PASS row requires recorded generation evidence. Mock transports, a partial campaign, a single response or rows selected across campaigns cannot establish provider acceptance.

Initialization, status, one run-block and finalization are separate operations. Initialization writes local synthetic records; it is not implicitly authorized by reading this guide. A future provider run requires matching source/build, frozen manifest/configuration hashes, actual project/model/credential references, operator, Pacific date and known project usage, with a dedicated restricted key handled privately. Replacement/revocation completion and real entitlement/quota are separate facts from configuration. The current implementation pins an intended model ID; source inspection does not establish provider availability or entitlement. Quota accounting is local-root/project scoped and cannot prove that other clients are idle.

Never load `.env.local` merely to inspect a campaign. Provider calls, all later days and recovery actions require their own exact authorization. PF-01 does not qualify analyst behavior, combined PayPal/AI workflows, real captures/refunds, hosted operation, native Studio rights or human value.
