# PantryPilot Community-only source and local demo

PantryPilot links nonprofit giving, inventory, reviewed supplier purchasing, recovery and distribution. This source export includes the MIT license, application, scripts, migrations, maintained tests and synthetic evaluation assets. The default local demo uses manual planning and simulated payments. It does not send money or invoke an AI provider.

## Owner-attended planner evaluations

`scripts/owner-planner-stage.ps1` and `scripts/owner-planner-runtime.ts` provide a separate, fail-closed diagnostic/H3 launcher. They are not part of the credential-free demo setup. A run requires an exact approved scope and source inventory, an initialized preserved project journal, current usage/quiet evidence and a fresh process-bound grant. The exported source includes no usable scope, approval, activation or credentials. Missing or expired records refuse execution.

The owner enters the selected key in a hidden local PowerShell prompt before activation. It remains in that process's memory for at most the approved fifteen-minute staging wait, then passes through a private stdin pipe only after credential-free checks of the actual Node PID, nonce and grant. The launcher never reads an environment file, saves the key or fingerprints it. Disposal reduces retention; it does not guarantee memory erasure. Staging and dispatch records prevent automatic replay. Counting and generation obey the absolute approval deadline as well as their existing request and time limits. Safe failure phases and preserved journals require readback; a zero exit code alone is not qualification.

## Prerequisites and setup

Use Node.js >=22.9, npm and Python >=3.10 available as `python` for packaging tests. Windows commands below use `npm.cmd`; on other systems omit `.cmd`. Dependency installation executes package lifecycle scripts. Install only the exact lockfile versions in a fresh directory; use an existing exact-version cache for offline installation.

```powershell
npm.cmd ci --no-audit --no-fund
```

A fresh terminal must have no inherited provider credentials or hosted configuration. Select this local synthetic process profile; it requires no credential file:

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
```

Financial actions in this profile are synthetic operations needed by the demo journeys. Never add live-money credentials. Keep `.env.local`, workspace data, cookies and logs outside source publication. The example environment file is a template, not provider admission; its older evaluation-cap comment does not describe the H2 campaign policy in `docs/planning/contracts.md`.

## Local checks and startup

```powershell
npm.cmd run lint
npm.cmd test
npm.cmd run build -- --webpack
npm.cmd run typecheck
npm.cmd run start -- --port 3102
```

Build and typecheck run sequentially because Next regenerates types. Webpack is the documented local build path; default Turbopack previously failed in the Windows environment. From a second terminal with the same profile, run:

```powershell
$env:PANTRYPILOT_TEST_ORIGIN='http://127.0.0.1:3102'
npm.cmd run test:browser
```

The matching Chromium must already be installed for offline browser verification. If downloading it is separately permitted, use `npx.cmd --no-install playwright install chromium`. A green build does not establish browser availability. Health must report local storage, simulated payments, manual AI and disabled providers before the tour. Use one Node process and a fresh synthetic workspace. The local role tour is not Google identity qualification.

## Demo journey

Request kits and compare approved offers; have finance approve the exact proposal and simulate checkout. Have the supplier cancel an item, review the resulting recovery, simulate the merchant-authorized refund, receive remaining supplies and approve a fresh replacement. Record receipts before distributing kits. Analytics distinguishes planned, purchased, received and distributed quantities. Giving also supports synthetic one-time gifts and recurring-gift workflows.

## Maintenance and limitations

Read `docs/planning/README.md` and `docs/planning/contracts.md` for exported contracts and source/test entry points. The 21 responsibility profiles and journey specifications are hypotheses, not observed customer acceptance. Staged evaluation worksheets retain their assertions and start unexecuted.

`HANDOVER-MANIFEST.json` binds included bytes; the adjacent checksum binds the archive. Neither is a test receipt. Run the local gate on the exact extracted candidate and retain source/configuration/build identity and complete results outside publication. Do not transfer earlier test counts to changed candidates.

Actual Gemini and PayPal behavior, hosted identity/storage, independent human acceptance and measured impact remain unqualified by the local demo. This submission/judging milestone uses AG Grid Community and includes no native Studio runtime or dependency. Native Studio UI/layout/chat remains deferred until rights are confirmed and is not a delivered feature of this candidate. No license key is bundled. Local file storage and process-local controls do not establish distributed hosted reliability. There is no qualified production or live-money release.

Model evaluation and provider-readiness scripts can consume quota or use credentials; they are outside the local setup commands above. Do not run `eval:live`, `check:providers` or `scripts/planner-probe.ts` initialization/execution as a setup check. The separate initial Gemini probe has a three-pair/six-request ceiling and does not replace the full twelve-case campaign. Its project quota, quiet-window coordination and runtime admission must be reviewed before any authorized run. All provider tests require separate exact authorization, non-secret admission records and private credential handling. Publishing this source grants no provider, hosted, payment or participant-contact authority.


## Community milestone verification

Run `npx --no-install tsx scripts/verify-community-build.ts` after the production build. It must find an actual build and verify dependency, source-import and emitted-artifact boundaries. Keep the normal type/lint/unit/build/browser gate. The five explicitly named native Studio browser cases remain unchanged in the source but are excluded from this milestone and reported as deferred NOT_RUN. Community browser cases retain saved focus, numeric/financial invariants, filtering/reset, accessibility, analyst denial, safe output, cancellation and legacy-view preservation checks. Native deferral is not a native test pass or provider proof.

## Separate PF-01 hackathon qualification gate

`scripts/hackathon-eval.ts` implements H3 independently from the H2 CLI. It does not load an environment file. H3 uses all twelve original synthetic cases and the original verdict (at least eleven PASS, unchanged protected financial arrays, no infrastructure failure). A passing case needs durable generation evidence. Limits are six count/generation pairs per case,144combined campaign requests and20project-wide requests per Pacific date. These are ceilings, not mandatory calls or sample repetitions. Same-day completed cases require a fresh exact per-case grant and twelve-request headroom; insufficient headroom returns read-only DEFER. A started/poisoned/uncertain case is never replayed or resumed.

Initialization requires separate approval and an already existing clean canonical project journal; H3 exposes no new-origin/reset route. A runtime grant binds the actual source/build/manifest/configuration, project/model/operator/credential reference, next case, quota head, PID/nonce, fresh usage and quiet evidence, single-case12-request scope and exact window. A matching activation record and process-only runtime profile are required before any key read. Both the original60-second AI timeout and the approval-window cancellation apply. Counts, generation attempts, external-use deltas and uncertainty are accounted conservatively. Qualification must end before November12,2026 at20:00UTC under this event-specific policy.

H3 is locally tested, not provider-qualified. Its final receipt separates `hackathonGateAccepted` from `fullCampaignAccepted:false`. The unchanged H2 schema2/ten-pair/240-ceiling/twelve-distinct-date mechanism remains pending for later qualification. An initial diagnostic probe is neither H3 acceptance nor H2 full qualification. See `docs/planning/contracts.md` for both contracts. No provider call, real campaign initialization, paid fallback or credential use is authorized by these instructions.

## Verified local candidate — November 3, 2026

The explicit Gemini 3.6 diagnostic binding, H3 and owner-launcher source passed an offline exact-lockfile install, **800 unit/route tests across 42 files**, **173 focused checks**, **55 selected Chromium journeys**, lint, post-build typecheck, a production Webpack build and the Community artifact boundary check. Evaluation source digest: `487f5bd845f1d96757cdb79cadb16f9c92437e54a88ceb3fcfbf8d8365ea60a8`; build `ONkysz9LN0vG_XipQ6LYv`. Five native Studio cases remain deferred NOT_RUN. No dependency junction was used. These results were produced on November 3; refreshing documentation does not rerun or refresh their timestamps.

The first full unit run had four campaign timeouts and one Windows EBUSY cleanup failure. That result is preserved; the identical suite passed once using a fresh owned temporary directory, with no test, assertion or timeout changes. The exact environmental cause is not established solely by the passing rerun. Installation used the existing exact-version npm cache; uncached installation and other operating systems were not tested. Existing dependency and SDK fixture warnings remain disclosed.

These checks prove the local synthetic profile only. Source publication does not establish PayPal/Gemini qualification, hosted behavior or independent human acceptance. The export excludes private evidence, failed ledgers, credentials and operational data. No successful provider campaign or deployed application is claimed.

## Explicit diagnostic model binding

The diagnostic registry supports separate fixed `gemini-3.8-flash` and `gemini-3.6-flash` policies with the same three-count/three-generation ceiling. Model, policy, manifest and owner scope must match exactly; there is no alias, default switch or automatic fallback. This source change does not select an active model or authorize a provider run. Both earlier failed runs remain closed; new accounting, initialization and owner-runtime releases require separate exact admission. Gemini 3.6 has not been provider-qualified by these local tests.
