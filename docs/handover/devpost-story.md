## Inspiration

A pantry can have money and still lack the right supplies. Stock on hand, restricted funds, pack sizes, shipping and a supplier cancellation all affect whether staff can finish a kit. PantryPilot connects these decisions so people can inspect the evidence and approve the next action.

## What it does

PantryPilot is a sandbox prototype connecting giving, procurement, inventory and recovery. A coordinator requests kits and compares an itemized basket. Finance approves the exact version; suppliers see their own orders. A cancellation opens a recovery case. Pending refunds stay out of spendable funds, and replacement purchases require fresh approval. Payment, pantry receipt and recorded distribution remain separate events.

In the current local scenario, $600 of synthetic opening funds and existing inventory support a request for 50 kits. The deterministic planner splits purchases across approved suppliers and produces a $348.10 basket, including shipping. Cancelling two rice packs opens a $36 recovery case. After simulated refund confirmation, a separately approved $61.50 replacement and recorded distribution, $226.40 remains available. These are synthetic software records, not donor receipts or physical delivery evidence.

Four custom AG Studio widgets and an AG Grid ledger expose the underlying records. A manual explanation panel distinguishes available and reserved funds, pending recovery, usable stock and recorded distributions. It recommends an attention area without requiring an AI request.

## How we built it

Next.js, React, TypeScript and Zod support role and organization checks, integer-cent accounting, source-bound approvals, idempotency and explicit uncertain-payment recovery. Local storage uses atomic files; a Supabase adapter supports authenticated durable storage. PayPal sandbox adapters implement giving, subscriptions, purchasing, refunds and reconciliation. Actual PayPal sandbox qualification is still pending; demonstrated local payments are simulated.

The AI SDK and Google adapter implement a bounded planner over approved synthetic offers and a dashboard analyst. Planner output is recomputed against deterministic constraints. The analyst must read scoped numeric evidence before selecting a validated view; server-verified aggregates supply amounts and next steps. Changed evidence or permissions discard its answer. The model cannot approve, pay or refund. Actual Gemini execution remains unverified. Real merchant-entered catalog data stays manual-only.

## Challenges and what we learned

An apparently affordable kit can fail when suppliers cannot fill it alone. We fixed a silent six-offer cutoff and added integer-pack allocations across suppliers. Independent exhaustive small-basket comparisons check the resulting costs. Shipping is charged once per supplier. Oversized searches return an explicit limit error rather than an unsupported infeasibility decision.

Payment, receipt, refund confirmation and distribution require separate evidence. Our local tests cover restrictions, stale approvals, duplicate actions, uncertain responses, organization isolation and recovery. Passing these tests does not establish provider interoperability or real-world impact.

## Current limits and next steps

Independent pantry use, measured savings or community impact, actual PayPal and Gemini outcomes, authenticated hosted operation and Studio rights through the judging window remain unverified. The updated 2:45 local demo uses manual planning and simulated payments, shows the corrected basket and recovery journey, and discloses the remaining qualification gaps. Public source and YouTube links are pending.

Next steps are to qualify the exact sandbox and free-tier configurations, compare AI proposals with the deterministic baseline, observe pantry staff attempting the workflow, resolve Studio access for judging and publish the licensed source and truthful demonstration. We will update claims only with observed results.

## Credits

Developed with AI coding assistance. The local demo uses Microsoft David Desktop narration and GSAP with HyperFrames. Third-party libraries retain their respective licenses. No user testimonials or real payment outcomes are implied.
