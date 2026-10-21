# Agent specification

Model configuration is explicit: `GEMINI_MODEL` must be nonblank before reserving run quota, saving a run or starting the live-evaluation workspace. Planner, analyst and evaluation metadata use that exact selected model; no implicit default or fallback exists. Presence is not proof of current model availability, free-account access or key safety. The operator must qualify the rotated key and account-accessible free model before enabling provider actions. Manual mode continues to deny provider calls.

Bounded planner/executor: interpret -> retrieve approved evidence -> propose alternatives -> deterministic validate -> human approval -> exact financial executor -> reconcile/recover. The planner allows six SDK steps and six tool reads, with a 60s route deadline; the analyst allows three SDK steps, at most two aggregate evidence reads and one view selection, with a 30s deadline. Both also enforce the separately configured HTTP/input/output/time limits, whichever is stricter. Retries are zero; there is no output-schema repair or paid fallback. SDK steps, tool reads and actual HTTP attempts are separate counters. Manual operations work when AI is unavailable.

The analyst accepts six suggested questions, reads only actor-scoped synthetic numeric aggregates before choosing a view, and returns a typed evidence snapshot. Amounts and next steps are rendered deterministically, never copied from model prose. Completion rechecks role, organization, demo classification, pause and the current aggregate digest. A changed snapshot is rejected. This is bounded dashboard assistance, not an unrestricted conversational analyst or an autonomous payment agent. A manual evidence panel and deterministic attention selector work without Gemini. Real pantry/merchant AI input remains excluded; this submission scope must be disclosed.

The separately authorized 12-case live evaluator records a paired deterministic baseline for the same request and snapshot, both proposal digests, exact integer-cent totals and feasibility. Cost delta is null when either basket is infeasible. Model access, actual comparison results and human usefulness remain unproven until executed; the baseline is also available to the planner through its compare tool, so it is an assisted comparison, not a blind benchmark.

Tools: scoped inventory/catalog/fund reads; structured draft proposal; deterministic validation; approval-bound checkout; merchant-owned refund; replacement draft; authorized Studio view manipulation. Financial tools accept operation IDs, not model-written merchant/amount. No arbitrary URLs, shell/tools, SQL, credentials or unrestricted fetch. Catalog text treated as untrusted data. Synthetic/public classification enforced before model call. Donor/private fields/raw payment payloads excluded.

Persist working state, reference policies and reviewed failure cases. No automatic policy changes from conversation memory. Log safe operation IDs, model ID, validation outcomes, usage/latency and tool evidence. Keep data and output hashes for reproducibility.

## Cognitive demands (hypotheses until interview)

| Step | Cue | Hidden assumption | Judgment | Strategy | Failure | Verification | Agent implication | Source |
|---|---|---|---|---|---|---|---|---|
| Need | Requested kits | Template reflects need | Clarify omissions | Structured questions | Wrong count | Coordinator confirms | Block ambiguity | Product requirements |
| Supply | Pack/price/deadline | Catalog is current | Compare feasible supply | Candidate comparison | Unsuitable bargain | Attributes/stock check | Preserve unknowns | Catalog |
| Funds | Receipt/restriction | Giving is unrestricted | Choose permitted fund | Policy check | Restricted spend | Ledger/restriction | Deterministic reserve | Finance interview pending |
| Pay | Approved version | Approval is current | Execute exact action | Controlled execution | Duplicate/stale pay | Digest/readback | No AI payment authority | PayPal contract |
| Recover | Cancellation | Refund completed | Restore capacity | Observe/replan | Spend pending refund | Provider status | Explicit recovery state | Supplier scenario |
| Impact | Received/distributed | Purchase means delivery | Publish supported count | Evidence review | Inflated claim | Inventory/human review | Separate outcome stages | Pantry interview pending |
