import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { configuration } from "../src/lib/config";
import { seedWorkspace } from "../src/lib/seed";
import { withWorkspace } from "../src/lib/storage";
import { aiProposal } from "../src/lib/ai";
import { plan } from "../src/lib/planner";
import { requiredGeminiModel } from "../src/lib/gemini-model";
import { createModelBudget, requiredModelLimits, validateModelLimits } from "../src/lib/model-budget";
import { comparePlannerBaseline, evaluatePlannerCase } from "./lib/planner-evaluation";
import { assertCurrentSubject, campaignPaths, finalizeCampaign, initializeCampaign, readCampaign,
  runCampaignBlock, validateBinding, type CampaignBinding } from "./lib/planner-campaign";
import { H2Journal, createH2Policy, h2Assert, initializeQuota, pacificDay, readRecord,
  sha, type QuotaOrigin } from "./lib/planner-quota";

const refusal = "BLOCKED: live model evaluation requires explicit authorization, an isolated local synthetic profile, key, explicit qualified model and matching approved budgets. No provider request was sent by this refused admission.";
let executionBegan = false;
async function main(args: string[]) {
  const root = process.cwd(), [operation, id, project] = args;
  if (operation === "init") {
    h2Assert(args.length === 2 && id.endsWith(".json"));
    const input = await readRecord<CampaignBinding & { id: string; quotaOrigin?: QuotaOrigin }>(path.resolve(id));
    h2Assert(Object.keys(input).every((key) => ["id", "model", "project", "credentialReference", "operator",
      "limits", "session", "quotaOrigin"].includes(key)));
    const binding: CampaignBinding = { model: input.model, project: input.project,
      credentialReference: input.credentialReference, operator: input.operator, limits: input.limits, session: input.session };
    validateBinding(binding); const paths = campaignPaths(root, input.id, input.project);
    if (input.quotaOrigin) {
      h2Assert(input.quotaOrigin.project === input.project && input.quotaOrigin.day === pacificDay(Date.now()));
      await initializeQuota(paths.quota, input.quotaOrigin);
    } else { h2Assert((await new H2Journal(paths.quota).read()).length > 0); }
    const manifest = await initializeCampaign(root, input.id, binding, seedWorkspace(randomUUID()));
    console.log(JSON.stringify({ id: manifest.id, manifestHash: sha(manifest), configDigest: manifest.configDigest,
      status: "INITIALIZED_NOT_EXECUTED" })); return;
  }
  h2Assert(args.length === 3 && ["status", "finalize", "run-block"].includes(operation));
  if (operation === "status") {
    const state = await readCampaign(root, id, project);
    console.log(JSON.stringify({ completed: state.outcomes.length, total: 12,
      status: state.outcomes.some((o) => o.infrastructureFailed) ? "INFRASTRUCTURE_STOP" :
        state.outcomes.length === 12 ? "READY_FOR_FINALIZE" : "PAUSED_UNTIL_NEXT_APPROVED_QUOTA_DAY" })); return;
  }
  if (operation === "finalize") {
    const result = await finalizeCampaign(root, id, project);
    console.log(JSON.stringify({ accepted: result.accepted, cases: result.rows.length }));
    process.exitCode = result.accepted ? 0 : 1; return;
  }
  // No key/provider configuration is read for init/status/finalize or invalid/legacy CLI.
  let admitted: Awaited<ReturnType<typeof admission>>;
  try { admitted = await admission(root, id, project); } catch { console.log(refusal); process.exitCode = 1; return; }
  const { state, binding, approval } = admitted;
  const shared = createModelBudget(binding.session, "evaluation");
  executionBegan = true;
  const finish = await runCampaignBlock(root, id, project, binding, approval, async (manifest, caseId, active, signal) => {
    const paths = campaignPaths(root, id, project);
    const policy = createH2Policy({ root: paths.quota, project, campaign: id, caseId, model: binding.model,
      day: approval.day, approvedDay: approval.day, knownProjectUseReference: approval.quotaReference,
      signal, assertActive: () => { active(); shared.assertActive(); } });
    let comparison: ReturnType<typeof comparePlannerBaseline> | undefined;
    const row = await evaluatePlannerCase(caseId - 1, async () => {
      active(); const fixture = manifest.cases[caseId - 1];
      const { request, baseline } = await withWorkspace(manifest.workspaceId, (w) => {
        const request = w.requests.find((r) => r.id === fixture.requestId);
        h2Assert(request && sha(request) === fixture.requestDigest);
        return { request, baseline: plan(w, request, undefined, manifest.fixtureTime) };
      });
      const candidate = await aiProposal({ workspaceId: manifest.workspaceId, actorId: "owner-a",
        expiresAt: Date.now() + 100000, nonce: "local-eval" }, request.id, shared,
      { fixtureTime: manifest.fixtureTime, transportPolicy: policy });
      active(); comparison = comparePlannerBaseline(baseline, candidate); return candidate;
    });
    const quotaEvents = await new H2Journal(paths.quota).read();
    const infrastructureFailed = quotaEvents.some((event) => event.value.kind === "poison");
    return { row: { ...row, ...(comparison && { comparison }) }, infrastructureFailed };
  });
  console.log(JSON.stringify({ case: finish.caseId, status: finish.row.status,
    infrastructureFailed: finish.infrastructureFailed, campaignAccepted: false,
    manifestHash: sha(state.manifest) }));
  process.exitCode = finish.row.status === "PASS" && !finish.infrastructureFailed ? 0 : 1;
}
async function admission(root: string, id: string, project: string) {
  h2Assert(path.resolve(root) === path.resolve(fileURLToPath(new URL("../", import.meta.url))));
  const config = configuration();
  h2Assert(process.env.RUN_LIVE_EVAL === "true" && process.env.APP_ENV === "local" && !config.hosted &&
    config.storage === "local" && config.payments === "simulation" && !config.financialActions &&
    config.providerActions && config.ai === "gemini" && process.env.GEMINI_API_KEY);
  const model = requiredGeminiModel();
  const limits = requiredModelLimits(); const raw = process.env.EVAL_MAX_HTTP_REQUESTS || "";
  const session = validateModelLimits({ ...limits, maxHttpRequests: /^[1-9][0-9]*$/.test(raw) ? Number(raw) : NaN }, "evaluation");
  const state = await readCampaign(root, id, project);
  const binding: CampaignBinding = { model, project, limits, session,
    credentialReference: process.env.EVAL_CREDENTIAL_REFERENCE || "", operator: process.env.EVAL_OPERATOR || "" };
  await assertCurrentSubject(root, state.manifest, binding);
  const paths = campaignPaths(root, id, project);
  h2Assert(process.env.EVAL_RUN_ID === id && process.env.EVAL_APPROVED_CONFIG_SHA256 === state.manifest.configDigest &&
    process.env.PANTRYPILOT_DATA_DIR && path.resolve(process.env.PANTRYPILOT_DATA_DIR) === paths.data &&
    model === "gemini-3.8-flash");
  const approval = { manifestHash: process.env.EVAL_APPROVED_MANIFEST_SHA256 || "",
    day: process.env.EVAL_APPROVED_PACIFIC_DAY || "", quotaReference: process.env.EVAL_KNOWN_USAGE_REFERENCE || "" };
  h2Assert(approval.manifestHash === sha(state.manifest) && approval.day === pacificDay(Date.now()));
  return { state, binding, approval };
}
main(process.argv.slice(2)).catch(() => {
  console.log(executionBegan ? "Campaign stopped. Preserve the existing journal, lock and outcomes; no successful result is claimed." : refusal);
  process.exitCode = 1;
});
