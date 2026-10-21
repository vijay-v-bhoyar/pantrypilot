# PantryPilot working agreement

Use `codex-request-router` for new actionable work and `codex-product-build-loop` as the single delivery owner. Read docs/planning/README.md and the affected contracts before changes. Preserve unrelated changes.

Query the repository code graph before uncertain or cross-module work. `npm run graph` updates the installed Graphify structural index; its coverage is code-only, not semantic documentation or runtime proof. Refresh after coherent changes before reusing it. An empty or failed graph requires an explicit source/test trace.

Sandbox only. Never enable live-money endpoints, deploy, publish, spend money, use provider credentials, send messages, or edit Devpost without explicit authorization for the exact target. Never print secrets. No paid upgrades or paid fallback. Keep simulation, PayPal sandbox, static source, local browser, hosted behavior, and human acceptance evidence separate.

Approve every consequential action. Money uses integer cents. Authorization, restrictions, idempotency, stale approval, merchant ownership, and uncertain provider outcomes require negative tests. Do not weaken assertions. Use one agent by default; delegate only a bounded task when specifically authorized.

Record requirement -> surface -> test -> result -> source digest -> gap in docs/verification. Required local gate: typecheck, lint, tests, build, and browser journeys. Real provider and hosted checks remain separate. Do not call an unconfigured integration proven.
