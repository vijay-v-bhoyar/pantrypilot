import { randomUUID } from "node:crypto";
import path from "node:path";
import { configuration } from "../src/lib/config";
import { seedWorkspace } from "../src/lib/seed";
import { createWorkspace, loadWorkspace, withWorkspace } from "../src/lib/storage";
import { execute } from "../src/lib/commands";
import { aiProposal } from "../src/lib/ai";
import { plan } from "../src/lib/planner";
import { requiredGeminiModel } from "../src/lib/gemini-model";
import { createModelBudget, requiredModelLimits, validateModelLimits } from "../src/lib/model-budget";
import { ensure } from "../src/lib/errors";
import { comparePlannerBaseline, evaluatePlannerCase, evaluationConfigDigest, evaluationSourceDigest,
  reserveEvaluationDirectories, writeEvaluationReceipt, type EvaluationRow } from "./lib/planner-evaluation";
import type { PurchaseRequest, Workspace } from "../src/lib/types";

async function main() {
  let admitted: Awaited<ReturnType<typeof admission>>;
  try { admitted = await admission(); } catch {
    console.log("BLOCKED: live model evaluation requires explicit authorization, an isolated local synthetic profile, key, explicit qualified model and matching approved budgets. No provider request was sent.");
    process.exitCode = 1; return;
  }
  const { model, limits, session, runId, configDigest, sourceDigest, evidence } = admitted;
  const budget = createModelBudget(session, "evaluation");
  const rows: EvaluationRow[] = [];
  const w = seedWorkspace(randomUUID());
  const financial = (state: Workspace) => JSON.stringify([state.ledger, state.orders, state.donations,
    state.recoveries, state.inventory, state.distributions, state.approvals]);
  const before = financial(w);
  let sideEffectsUnchanged = false;
  let infrastructureFailed = false;
  try {
    await createWorkspace(w);
    for (let index = 0; index < 12; index++) {
      if (index > 0) await new Promise((resolve) => setTimeout(resolve, 10000));
      try { budget.assertCapacity(); } catch {
        rows.push(...Array.from({ length: 12 - index }, (_, offset): EvaluationRow => ({ case: index + offset + 1, status: "BLOCKED" })));
        break;
      }
      let comparison: EvaluationRow["comparison"];
      const row = await evaluatePlannerCase(index, async () => {
        const { r, baseline } = await withWorkspace(w.id, (state) => {
          const r = execute(state, "owner-a", "request", {
          siteId: "hope-main", kitId: "kit-hope", fundId: "hope-kits", target: 20 + index * 3,
          budget: index % 4 === 0 ? 1 : 60000,
          deadline: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10), notes: "",
          }, randomUUID()) as PurchaseRequest;
          return { r, baseline: plan(state, r) };
        });
        const candidate = await aiProposal({ workspaceId: w.id, actorId: "owner-a", expiresAt: Date.now() + 100000,
          nonce: "local-eval" }, r.id, budget);
        comparison = comparePlannerBaseline(baseline, candidate);
        return candidate;
      });
      rows.push({ ...row, ...(comparison && { comparison }) });
    }
    sideEffectsUnchanged = financial(await loadWorkspace(w.id)) === before;
  } catch { infrastructureFailed = true; }
  while (rows.length < 12) rows.push({ case: rows.length + 1, status: "BLOCKED" });
  const passed = rows.filter((row) => row.status === "PASS").length;
  const accepted = passed >= 11 && sideEffectsUnchanged && !infrastructureFailed && !rows.some((row) => row.status === "BLOCKED");
  await writeEvaluationReceipt(evidence, { schemaVersion: 1, runId, timestamp: new Date().toISOString(),
    model, configDigest, sourceDigest, limits, session, httpAttempts: budget.attempts,
    counterScope: "this evaluation in this process; not account-wide usage or billing",
    rows, passed, accepted, sideEffectsUnchanged, infrastructureFailed,
    evidenceClass: "provider evaluation; human, analyst and hosted qualification remain separate" });
  console.log(`${passed}/12 live planning cases passed; evaluation ${accepted ? "accepted" : "not accepted"}. No payment was executed.`);
  process.exitCode = accepted ? 0 : 1;
}
async function admission() {
  const config = configuration();
  ensure(process.env.RUN_LIVE_EVAL === "true" && process.env.APP_ENV === "local" && !config.hosted &&
    config.storage === "local" && config.payments === "simulation" && !config.financialActions &&
    config.providerActions && config.ai === "gemini" && process.env.GEMINI_API_KEY,
    "EVAL_CONFIG", "Evaluation is not authorized/configured.");
  const model = requiredGeminiModel();
  const limits = requiredModelLimits();
  const raw = process.env.EVAL_MAX_HTTP_REQUESTS || "";
  const session = validateModelLimits({ ...limits, maxHttpRequests: /^[1-9][0-9]*$/.test(raw) ? Number(raw) : NaN }, "evaluation");
  const configDigest = evaluationConfigDigest(model, limits, session);
  ensure(process.env.EVAL_APPROVED_CONFIG_SHA256 === configDigest, "EVAL_CONFIG", "Approved evaluation budgets do not match.");
  const runId = process.env.EVAL_RUN_ID || "";
  ensure(process.env.PANTRYPILOT_DATA_DIR && path.resolve(process.env.PANTRYPILOT_DATA_DIR) ===
    path.resolve(".data", "ai-evals", runId), "EVAL_CONFIG", "Use the dedicated fresh evaluation data directory.");
  const sourceDigest = await evaluationSourceDigest(process.cwd());
  const { evidence } = await reserveEvaluationDirectories(process.cwd(), runId);
  return { model, limits, session, runId, configDigest, sourceDigest, evidence };
}
main().catch(() => {
  console.log("Evaluation could not complete. No successful result is claimed. Inspect the isolated receipt if available.");
  process.exitCode = 1;
});
