import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { seedWorkspace } from "../src/lib/seed";
import { validateModelLimits } from "../src/lib/model-budget";
import { hackathonLifecycle, campaignPaths, type CampaignBinding } from "./lib/planner-campaign";
import { comparePlannerBaseline, evaluatePlannerCase } from "./lib/planner-evaluation";
import { H2Journal, h2Assert, readRecord, sha, safetyClock, type SafetyClock } from "./lib/planner-quota";
import { H3, initializeHackathon, readHackathon, finalizeHackathon, inspectHackathonAdmission,
  runHackathonBlock, createHackathonBudget, type HackathonGrant } from "./lib/planner-hackathon";

export const H3_REFUSAL = "BLOCKED: H3 admission refused. No successful qualification is claimed; preserve existing evidence and any lock. No automatic retry.";
type Context = { root: string; env: NodeJS.ProcessEnv; pid: number; clock: SafetyClock; output(value: string): void };
export async function hackathonMain(args: string[], overrides: Partial<Context> = {}) {
  const context: Context = { root: process.cwd(), env: process.env, pid: process.pid,
    clock: safetyClock, output: console.log, ...overrides };
  const { root, env, pid, clock, output } = context;
  try {
    const [operation, id, project, grantFile] = args;
    if (operation === "init") {
      h2Assert(args.length === 2 && id.endsWith(".json") && env.RUN_H3_INIT === "true");
      const input = await readRecord<{ canonicalRoot: string; id: string; binding: CampaignBinding }>(path.resolve(root, id));
      h2Assert(Object.keys(input).sort().join() === ["canonicalRoot", "id", "binding"].sort().join() &&
        Object.keys(input.binding).sort().join() === ["model", "project", "credentialReference", "operator", "limits", "session"].sort().join() &&
        path.resolve(input.canonicalRoot) === path.resolve(root) && env.H3_INIT_APPROVED_SHA256 === sha(input));
      hackathonLifecycle.validateBinding(input.binding);
      const manifest = await initializeHackathon(root, input.id, input.binding, seedWorkspace(randomUUID()));
      output(JSON.stringify({ policy: H3.policy, id: manifest.id, manifestHash: sha(manifest), status: "INITIALIZED_NOT_EXECUTED" }));
      return 0;
    }
    h2Assert(["status", "finalize", "run-block"].includes(operation) && args.length === (operation === "run-block" ? 4 : 3));
    if (operation === "status") {
      const state = await readHackathon(root, id, project);
      output(JSON.stringify({ policy: H3.policy, completed: state.outcomes.length, total: 12,
        status: state.outcomes.some(o => o.infrastructureFailed || o.row.status === "BLOCKED") ? "INFRASTRUCTURE_STOP" :
          state.outcomes.length === 12 ? "READY_FOR_FINALIZE" : "AWAITING_FRESH_SINGLE_CASE_APPROVAL",
        fullCampaignAccepted: false })); return 0;
    }
    if (operation === "finalize") {
      const result = await finalizeHackathon(root, id, project);
      h2Assert("hackathonGateAccepted" in result);
      output(JSON.stringify({ policy: H3.policy, hackathonGateAccepted: result.hackathonGateAccepted,
        fullCampaignAccepted: false, cases: result.rows.length })); return result.hackathonGateAccepted ? 0 : 1;
    }
    h2Assert(path.resolve(root) === path.resolve(fileURLToPath(new URL("../", import.meta.url))) &&
      env.RUN_H3_EVAL === "true" && env.APP_ENV === "local" && !env.VERCEL &&
      env.STORAGE_MODE === "local" && env.PAYMENTS_MODE === "simulation" &&
      env.PROVIDER_ACTIONS_ENABLED === "true" && env.FINANCIAL_ACTIONS_ENABLED === "false" && env.AI_MODE === "gemini");
    const grant = await readRecord<HackathonGrant>(path.resolve(root, grantFile));
    const approvedHash = env.H3_APPROVED_GRANT_SHA256 || "";
    const admitted = await inspectHackathonAdmission(root, id, project, grant, approvedHash, pid, clock);
    if (admitted.status === "DEFER") { output(JSON.stringify({ status: "DEFER", remaining: admitted.remaining, keyRead: false })); return 2; }
    const { binding } = admitted;
    // Budget parsing sees only this process environment, never a private env file.
    const limits = validateModelLimits({ maxHttpRequests: Number(env.AI_MAX_HTTP_REQUESTS),
      maxInputBytes: Number(env.AI_MAX_INPUT_BYTES), maxOutputTokens: Number(env.AI_MAX_OUTPUT_TOKENS),
      timeoutMs: Number(env.AI_TIMEOUT_MS) });
    const session = validateModelLimits({ ...limits, maxHttpRequests: Number(env.EVAL_MAX_HTTP_REQUESTS) }, "evaluation");
    h2Assert(sha(limits) === sha(binding.limits) && sha(session) === sha(binding.session) &&
      env.GEMINI_MODEL === binding.model && env.EVAL_OPERATOR === binding.operator &&
      env.EVAL_CREDENTIAL_REFERENCE === binding.credentialReference && env.PANTRYPILOT_DATA_DIR &&
      path.resolve(env.PANTRYPILOT_DATA_DIR) === campaignPaths(root, id, project).data);
    const result = await runHackathonBlock(root, id, project, grant, approvedHash, pid,
      async (manifest, caseId, active, signal, policy) => {
        // Called only after locked revalidation, activation and durable nonce consumption.
        active(); h2Assert(env === process.env && env.GEMINI_API_KEY);
        const [{ aiProposal }, { withWorkspace }, { plan }] = await Promise.all([
          import("../src/lib/ai"), import("../src/lib/storage"), import("../src/lib/planner")]);
        const shared = createHackathonBudget(binding.session, signal);
        let comparison: ReturnType<typeof comparePlannerBaseline> | undefined;
        const row = await evaluatePlannerCase(caseId - 1, async () => {
          active(); signal.throwIfAborted(); const fixture = manifest.cases[caseId - 1];
          const { request, baseline } = await withWorkspace(manifest.workspaceId, w => {
            const request = w.requests.find(r => r.id === fixture.requestId);
            h2Assert(request && sha(request) === fixture.requestDigest);
            return { request, baseline: plan(w, request, undefined, manifest.fixtureTime) };
          });
          const candidate = await aiProposal({ workspaceId: manifest.workspaceId, actorId: "owner-a",
            expiresAt: Date.now() + 100000, nonce: "local-h3-eval" }, request.id, shared,
          { fixtureTime: manifest.fixtureTime, transportPolicy: policy });
          active(); comparison = comparePlannerBaseline(baseline, candidate); return candidate;
        });
        const events = await new H2Journal(campaignPaths(root, id, project).quota).read();
        return { row: { ...row, ...(comparison && { comparison }) },
          infrastructureFailed: events.some(e => e.value.kind === "poison") };
      }, clock);
    output(JSON.stringify(result));
    return result.status === "DEFER" ? 2 : result.result.row.status === "PASS" ? 0 : 1;
  } catch { output(H3_REFUSAL); return 1; }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void hackathonMain(process.argv.slice(2)).then(code => { process.exitCode = code; });
}
