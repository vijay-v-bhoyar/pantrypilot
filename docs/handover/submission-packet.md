# PantryPilot submission completion packet — October 20, 2026

October 21 update: local planner defects are repaired and the current gate passes 501 unit/route tests and 53 browser journeys. The user authorized editing the existing submission; the current story is in [devpost-story.md](devpost-story.md) and was saved through the Devpost editor. Personal additional-info fields remain incomplete. A new local video revision is in `videos/pantrypilot-update`; the user manually started the approved app and the fresh 165-second film now passes full decode, audio, caption and sampled visual checks. Public upload remains pending. Technology, testing instructions and AI-tools fields were saved and verified. The historical preparation text below predates that authorization. Final submission, public artifacts, provider outcomes and judging-window license coverage remain open.

Status: LOCAL CANDIDATE; final submission NO_GO. This packet is preparation, not approval to publish, deploy, use provider credentials, contact participants or edit Devpost. The prior 58 external/human/decision/hosted variants are not closed by local regression tests. Hosting is optional for a runnable public source entry; the existing deployment hold remains in force.

## Exact entry and proposed text

Target: https://devpost.com/submit-to/31302-paypal-ai-hackathon/manage/submissions/1230299-pantrypilot/project_details/edit . Re-read before writing; the October 20 review found the draft incomplete. The older October 19 text is historical; the following reflects this repair. Do not claim the public URLs exist until actually published and tested signed out.

Name: PantryPilot

Pitch: Turn pantry donations into reviewed purchases and traceable kit records, with inventory-aware planning, supplier recovery and human-controlled AI.

### Inspiration

A pantry can have money and still lack the right supplies. Pack sizes, restricted funds, stock on hand, shipping and a supplier cancellation all affect whether staff can finish a kit. PantryPilot connects those decisions so people can inspect the evidence and approve the next action.

### What it does

Our sandbox prototype links giving, procurement, inventory and recovery. A coordinator requests kits and compares an itemized basket. Finance approves its exact version; suppliers see their own orders. Cancellation opens a recovery case. A pending refund never becomes spendable money, and a replacement requires fresh approval. A paid order is distinct from a received shipment and a recorded kit distribution.

Staff can inspect four custom AG Studio widgets, save layouts and explore records with AG Grid. A manual evidence panel explains available versus reserved funds, pending recovery, usable kits and recorded distributions. It recommends an attention area without an AI request.

### How we built it

Next.js, React, TypeScript and Zod support strict commands, integer-cent accounting, source-bound approvals, role and organization checks, idempotency and explicit uncertain-payment recovery. Local storage uses atomic files; a Supabase adapter supports authenticated durable storage. PayPal sandbox adapters implement giving, subscriptions, purchasing, refunds and reconciliation. These adapters still require fresh real-provider qualification; the demonstrated local payments are simulated.

The AI SDK and Google adapter implement a bounded planner over approved synthetic offers and a dashboard analyst. Planner output is recomputed against deterministic constraints. The analyst must read scoped numeric evidence before selecting a validated view; amounts and next steps are rendered from server-verified aggregates. Changed evidence or permissions discard its answer. The model cannot approve, pay or refund. Actual Gemini execution remains pending; mock route tests establish control behavior only. Real merchant-entered catalog data remains manual-only.

### What we learned and current limits

Payment, receipt, refund confirmation and distribution need separate evidence. Local regressions cover restrictions, stale approvals, duplicate actions, uncertain responses, organization isolation and recovery. Synthetic records do not establish food delivery, savings, community impact or adoption. We have not yet demonstrated independent pantry use, a hosted service or actual provider outcomes. The current 2:45 film shows manual planning and simulated payments; it predates the new analyst explanation. Studio rights through the judging window remain unresolved.

### What's next

Qualify the exact PayPal sandbox and Gemini configurations, compare feasible AI baskets with their deterministic baseline, observe pantry staff attempting the purchase/recovery workflow, resolve Studio access through judging, and publish the licensed source and a truthful public demo. Update this entry only with observed results.

Built with (implemented dependencies, not proof of provider success): Next.js, React, TypeScript, Zod, PayPal sandbox REST adapters, Supabase, Google Gemini adapter, AI SDK, AG Studio, AG Grid Community, Playwright, Vitest. Attribute AI development assistance and the video's local narration/GSAP tooling in the final credits.

## Judge walkthrough and evidence

Read the source-root README; install the locked dependencies; build with Webpack and run locally. Do not import the developer's environment or workspace. Start a fresh synthetic demo and use the in-app role guides. Inspect Giving and the confirmed-versus-pending ledger; coordinator request and itemized proposal; finance approval and simulated checkout; supplier cancellation; owner recovery and a newly approved replacement; pantry receipt and distribution; Analytics evidence and saved Studio layout. A fully blank new owner is a different path from the seeded role demo. Both are intentional.

For an honest demonstration, show state before and after the action, not only a held success screen. Keep the simulation badge visible. Show that pending refunds do not increase available funds, a cancelled approval cannot purchase, and a simulated paid order does not increase usable stock before receipt. The analyst's provider denial in the manual profile is expected. A mocked analyst response is suitable for a labeled regression, never for provider qualification footage.

| Claim | Current support | Still needed |
|---|---|---|
| Human-reviewed procurement/recovery | Local source and regression journeys | Actual sandbox capture/refund/reconciliation readbacks |
| Safe bounded AI assistance | Scoped tools, budgets, deterministic rendering and negative tests | Qualified model execution, actual tool/HTTP receipts and useful answers |
| AI adds value | Paired baseline receipt instrumentation | Actual paired results; cost delta alone is not usefulness or causality |
| Useful pantry workflow | Defined responsibility profiles and synthetic journeys | Independent staff completion and feedback |
| Community impact | No evidence | Actual consented operational use/outcomes; never extrapolate fixture counts |
| AG Studio integration | Custom local widgets, layouts and native assistant adapter | Valid access and permission through December 1–15 judging |
| Public functional entry | Credential-free source archive including MIT LICENSE | Public repository, clean signed-out retrieval and public YouTube link |

## Remaining exact approval targets

1. **Provider qualification, held.** Prepare a fresh isolated synthetic workspace, explicit free-account Gemini model and all per-run/session budgets. Review `evaluationConfigDigest` for that exact model/limits before approving the 12-case evaluator (maximum 120 HTTP attempts, zero retries). Its receipt now includes deterministic feasibility and integer-cent basket deltas. This is a transport cap, not a cost guarantee. Review current account free access first; no paid fallback. Separately qualify analyst read/select behavior and safe cancellation. Do not turn on global flags until this exact profile is approved.
2. **PayPal sandbox, held.** Use only the previously established PantryPilot Hope/River/Harvest/Supply sandbox merchant profiles and synthetic sandbox payer. Review exact merchant, payer, basket and integer-cent limits before each capture/refund sequence. Capture success requires merchant/amount/currency/status readback; refund requested is not completed. Monthly billing and webhook ordering remain separate tests. An available local simulation is not a substitute. No live money, new subscription charges or public callback provisioning is authorized by this packet.
3. **User validation, unrun.** Owner arranges willing pantry coordinator and finance/supplier participants; aliases only. Give the same purchase/cancellation scenario for their current approach and PantryPilot, counterbalance order, record start/end, unaided completion, errors, help needed, perceived usefulness and reasons to decline. Observe recovery rather than coach success. Use synthetic data, permit withdrawal, record failures and retain original responses. A small convenience sample is directional evidence, not impact measurement. No participant contact is authorized here.
4. **Studio license, unresolved.** The supplied trial states November 25 expiry, before judging December 1–15. Obtain written permission/extension for the actual demo/judge use or narrow the award claim. Keep the operational grid fallback. Do not bypass license checks, publish the supplied key or assume a local evaluation proves hosted/public distribution rights. Any request to the vendor must be explicitly authorized.
5. **Public artifacts, held.** Choose the exact GitHub owner/repository and authorize publication of the sanitized candidate after secret/license review. No remote is assumed. Choose the exact YouTube channel and authorize upload of an approved truthful film as public, under three minutes. The previous MP4 is preserved. Record public URLs and signed-out access. The formal rules' publicly-visible requirement takes precedence over assuming unlisted is sufficient.
6. **Devpost write, held.** Re-read the linked draft, approve the exact text/media/URLs to save, then separately confirm final submission and selected eligible award categories. Do not paste a placeholder URL to satisfy a required field. Preserve a receipt of the actual saved/submitted revision. Freshly recheck official rules before this action.

Official criteria reviewed October 20: equal technology, design, potential impact, innovation and presentation; meaningful PayPal free-sandbox and AI use required. Deadline November 12, 3pm America/New_York; judging December 1–15. One grand or honorable-mention award plus one sponsor maximum, not three stackable prizes. Sources: https://paypalaihackathon.devpost.com/ , https://paypalaihackathon.devpost.com/rules , https://paypalaihackathon.devpost.com/details/aggrid . Reconfirm these dates/terms at final submission.

## Video revision plan, not rendered proof

Preserve `videos/pantrypilot/renders/video.mp4` and its original manifest. Record a new revision only against a named tested build. Target 165s: 0–15 need and scope; 15–35 donor funds evidence; 35–70 request, bounded AI and exact approval; 70–115 cancellation, refund confirmation and fresh replacement approval; 115–145 receipt/distribution and evidence-first Studio; 145–165 observed user results and clear limits. Actual provider scenes require their own approved qualification; if unavailable retain the simulation labels and disclose the eligibility gap. No invented testimonials, metrics or provider screen overlays.
