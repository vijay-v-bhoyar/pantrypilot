# PantryPilot local judge and maintainer handover

This MIT-licensed source candidate includes the root LICENSE, bounded procurement and dashboard assistance, manual operation and regression tests. It is not a published release, provider qualification or independent human acceptance. Original answers, private workspaces, historical trace artifacts and personal account setup documents are deliberately excluded. The manifest binds each included file; the adjacent ZIP SHA-256 binds the archive. Never copy .env.local or private source-workspace data into this directory. Read `docs/handover/submission-packet.md` from the source root for prepared entry text, claim boundaries, judge walkthrough and the external completion checklist.

The included executable subject passed typecheck, lint, 501 unit/route tests, Webpack build and 53 Chromium journeys in a local synthetic simulation profile. `docs/handover/local-verification.json` records its source scope, build ID and log hashes. These counts are local evidence; model routes use mocks/transport fixtures, and none of the 58 external variants was closed. Re-run the gate on the judge's actual environment rather than assuming the original build transfers.

Requires Node >=22.9, npm and Python >=3.10 (available as `python`; for the credential-free packaging regressions). In a fresh extracted directory, run `npm.cmd ci --no-audit --no-fund` to install the exact lockfile dependencies; `npm ci` runs package install scripts. Use `--offline` when the exact versions are already cached. Install the matching Chromium with `npx.cmd --no-install playwright install chromium` if it is not cached. These commands download free dependencies/browser files; they do not invoke PayPal or Gemini. Do not change dependency versions to get a green result. On other platforms omit `.cmd`. Do not infer browser installation from a green build.

PowerShell local profile (set in this fresh directory; no credentials):

```powershell
$env:APP_ENV='local'
$env:APP_URL='http://127.0.0.1:3102'
$env:STORAGE_MODE='local'
$env:PAYMENTS_MODE='simulation'
$env:AI_MODE='manual'
$env:PROVIDER_ACTIONS_ENABLED='false'
$env:FINANCIAL_ACTIONS_ENABLED='true'
$env:PANTRYPILOT_DATA_DIR='.data/maintainer-first-run'
$env:NEXT_TELEMETRY_DISABLED='1'
$env:NEXT_PUBLIC_AG_STUDIO_LICENSE=''
```

Copy `.env.example` to `.env.local` only if needed, leaving all credential/model-budget fields blank and provider actions false. The listed environment profile overrides its port. Keep local simulated financial actions enabled for the full role journeys. The app never supports live money. Use a fresh data directory for every independent run.

Required local gate:

```powershell
npm.cmd run lint
npm.cmd test
npm.cmd run build -- --webpack
npm.cmd run typecheck
npm.cmd run start -- --port 3102
```

In a second terminal with the same profile:

```powershell
$env:PANTRYPILOT_TEST_ORIGIN='http://127.0.0.1:3102'
npm.cmd run test:browser
```

Build and typecheck run sequentially because Next regenerates `.next/types`. The verified local build path is Webpack; default Turbopack previously failed in this Windows environment. Windows isolation can also deny Next prerender filesystem writes or temporary junction tests; record the error and seek authorized host execution rather than weakening assertions. Health must identify PantryPilot local/local/simulation/manual/providers-disabled before tests. The browser suite exercises synthetic app roles, not verified Google identity. The native Studio canvas can be evaluated locally without bundling a license key; hosted rights remain unresolved.

Preserve full logs, command exit codes, source manifest, build ID, target/configuration and actual test counts in a new evidence directory. Do not archive protected responses, cookies, API keys or user data. Source/config drift invalidates prior gate evidence. Root source package has no assumed Git history or remote.

Model controls: all four `AI_MAX_HTTP_REQUESTS`, `AI_MAX_INPUT_BYTES`, `AI_MAX_OUTPUT_TOKENS`, `AI_TIMEOUT_MS` must be explicit before any separately authorized model run. Ceilings are 10 HTTP attempts/run, 32768 serialized UTF-8 bytes/request, 1024 output tokens/request, and 300000 ms. Actual Google generation transports are counted across SDK steps, failed sends count, redirects/changed targets are denied, retries are zero. Counters are run/process bounded, not provider account usage, billing, or proof of $0 access. The legacy daily hosted run quota remains separate. Provider output remains untrusted and deterministically recomputed.

The 12-case live evaluator additionally needs a fresh UUID, exactly `.data/ai-evals/<UUID>`, local simulation, financial actions disabled, `EVAL_MAX_HTTP_REQUESTS` <=120 and `EVAL_APPROVED_CONFIG_SHA256` matching the reviewed model/per-run/session limits. This ceiling is not permission to spend or call providers. Under separate later approval the digest is computed by `evaluationConfigDigest(model, limits, session)`; the session uses the same byte/token/time limits and explicit evaluation HTTP cap. No command in this handover enables it. Append-only receipts go to `output/live-evals/<UUID>/receipt.json`. Missing/invalid/unauthorized profiles deny before creating a workspace or sending a request. The planner evaluator alone never proves analyst, human, hostile-input, hosted or live cancellation qualification.

Read `docs/planning/README.md`, `docs/handover/persona-workflows.json`, `docs/adoption/journey-contracts.json` and staged worksheets in `docs/testing/next-local-01-v1`. All 21 responsibility profiles are hypotheses supported by source, with no actual user acceptance implied. The 58 provider/identity/human/decision/hosted variants remain NOT_RUN. Staged templates preserve their original assertions but contain no actual identity UUIDs, secrets or observations. No Supabase fixture import, Google sign-in, PayPal/Gemini call, user recruitment, retention/deletion, source publication, video or Devpost submission is authorized by this bundle.

Beta remains NO_GO. Keep deployment on hold. Independent maintainer review and a fresh official rules/license/claims review remain required before any later publication. For a short local walkthrough, start a fresh synthetic demo, inspect Giving, use the coordinator's request/proposal flow, finance's approval and simulated checkout, supplier cancellation, owner recovery, receipt/distribution, then Analytics. The in-app role guides supply exact actions. In Analytics, inspect the manual operational explanation and focus selector before opening Studio. An AI control denied in this profile is an expected boundary, not evidence of a successful model run. Judge participation should use synthetic data only.
