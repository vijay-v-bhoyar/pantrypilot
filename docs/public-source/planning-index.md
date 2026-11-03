# PantryPilot exported source contracts

Start with the root README for credential-free setup and the local gate. `docs/planning/contracts.md` summarizes the supported architecture, authority boundaries and H2 synthetic campaign contract. Source and negative tests define observable behavior; this summary does not amend separately approved product requirements.

## Source and checks

- `src/lib/commands.ts`, domain schemas and route handlers enforce operation inputs, permissions and state transitions.
- `src/lib/planner.ts` implements deterministic allocation. `src/lib/ai.ts` adds bounded provider-assisted proposals; `src/lib/model-budget.ts` enforces request, byte, output and time budgets.
- `scripts/lib/planner-evaluation.ts`, `scripts/lib/planner-campaign.ts` and `scripts/lib/planner-quota.ts` implement synthetic cases, frozen campaign identity and durable project accounting. `scripts/live-eval.ts` exposes separate campaign operations.
- `tests/` retains maintained unit, route, security, packaging, planner and browser checks. H2 tests include all twelve original cases and negative admission/accounting checks.
- `supabase/migrations/` retains the database migration chain. An included migration is not proof it ran against a hosted database.
- `AGENT-SECURITY.md` records model/tool permissions and residual risks.

## Evaluation assets

`docs/handover/persona-workflows.json` and `docs/adoption/journey-contracts.json` preserve 21 responsibility and journey specifications. They do not establish recruitment, interviews, validated needs or human acceptance. `docs/testing/next-local-01-v1/` contains unchanged staged assertion overlays, blank import/observation/decision templates and their scope guide. Do not substitute local simulations for their original identity, provider, human or hosted targets.

Private original answers, submission drafts, operator account setup, approval packets, historical verification receipts and recovery copies are not part of the export. They remain preserved by the maintainer. Their exclusion does not waive requirements or close unresolved findings. The source export is deliberately separate from Git history, build artifacts, deployment and public media.
