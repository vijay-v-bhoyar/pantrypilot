import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { execute } from "../../src/lib/commands";
import { seedWorkspace } from "../../src/lib/seed";
import { plan } from "../../src/lib/planner";
import { configuration } from "../../src/lib/config";
import { requiredGeminiModel } from "../../src/lib/gemini-model";
import { bindModelBudgetSignal, createModelBudget, requiredModelLimits, type EvaluationTransportPolicy } from "../../src/lib/model-budget";
import type { Proposal, PurchaseRequest, Workspace } from "../../src/lib/types";
import { comparePlannerBaseline, evaluationSourceDigest, financialSnapshot, plannerCases } from "./planner-evaluation";
import { campaignPaths } from "./planner-campaign";
import { H2, H2Journal, auditCampaignQuota, contained, createH2Policy, h2Assert, initializeQuota,
  pacificDay, readRecord, safeDirectory, safetyClock, sha, withProjectLock, writeOnce,
  type QuotaOrigin, type SafetyClock } from "./planner-quota";

// This probe never produces H2 case outcomes or a full-campaign verdict.
export const INITIAL_PROBE = Object.freeze({ id: "PP-FEAS-01-INITIAL-PROBE-01",
  project: "gen-lang-client-0107804522", model: "gemini-3.8-flash", pairs: 3, http: 6,
  quietSettleMs: 900000, observationAgeMs: 60000, windowMs: H2.blockTimeoutMs });
export const probeLimits = Object.freeze({ maxHttpRequests: 3, maxInputBytes: H2.maxInputBytes,
  maxOutputTokens: H2.maxOutputTokens, timeoutMs: H2.blockTimeoutMs });
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const hash = /^[a-f0-9]{64}$/;
const reference = /^[a-zA-Z0-9._-]{1,100}$/;
export type ProbeBinding = { canonicalRoot: string; project: string; model: string;
  credentialReference: string; operator: string };
type FrozenCase = { case: 1 | 2; workspaceId: string; requestId: string;
  initialHash: string; initialFinancial: string; requestDigest: string };
export type ProbeManifest = { version: 1; policy: typeof INITIAL_PROBE; id: string;
  binding: ProbeBinding; fixtureTime: number; allCasesDigest: string;
  sourceDigest: string; buildId: string; cases: FrozenCase[] };
export type ProbeApproval = { manifestHash: string; quotaHead: string; day: string;
  quietSince: number; usageObservedAt: number; windowStart: number; windowEnd: number;
  knownPriorHttp: number; laterExternalReservedHttp: number; usageReference: string };
type Coordination = { approvalHash: string; exclusive: boolean; unaccountedUse: boolean };
export function probePaths(root: string, id: string) {
  h2Assert(uuid.test(id));
  return { evidence: contained(root, "output", "planner-probes", id),
    data: contained(root, ".data", "planner-probes", id),
    quota: campaignPaths(root, id, INITIAL_PROBE.project).quota };
}
function validateBinding(root: string, binding: ProbeBinding) {
  h2Assert(path.resolve(binding.canonicalRoot) === path.resolve(root) &&
    binding.project === INITIAL_PROBE.project && binding.model === INITIAL_PROBE.model &&
    reference.test(binding.credentialReference) && reference.test(binding.operator));
}
export async function initializeProbe(root: string, id: string, binding: ProbeBinding, quotaOrigin?: QuotaOrigin) {
  validateBinding(root, binding); const paths = probePaths(root, id);
  const sourceDigest = await evaluationSourceDigest(root);
  const buildId = (await readFile(contained(root, ".next", "BUILD_ID"), "utf8")).trim();
  h2Assert(/^[a-zA-Z0-9_-]{1,120}$/.test(buildId));
  // A supplied origin is a separately approved initialization, never a reset of an existing root.
  if (quotaOrigin) {
    h2Assert(quotaOrigin.project === binding.project && quotaOrigin.day === pacificDay(Date.now()));
    await initializeQuota(paths.quota, quotaOrigin);
  }
  return withProjectLock(paths.quota, async () => {
    const origin = await readRecord<QuotaOrigin>(path.join(paths.quota, "origin.json"));
    const quota = await new H2Journal(paths.quota).read();
    h2Assert(origin.project === binding.project && quota.length > 0 &&
      quota[0].value.kind === "origin" && sha(quota[0].value) === sha({ kind: "origin", ...origin }) &&
      !quota.some((event) => event.value.kind === "poison"));
    await safeDirectory(path.dirname(paths.evidence), true); await mkdir(paths.evidence);
    await safeDirectory(path.dirname(paths.data), true); await mkdir(paths.data);
    const workspaces = [seedWorkspace(randomUUID()), seedWorkspace(randomUUID())];
    const fixtureTime = Date.parse(workspaces[0].createdAt), fixtures = plannerCases(fixtureTime);
    const cases = workspaces.map((workspace, index): FrozenCase => {
      const fixture = fixtures[index], initialFinancial = financialSnapshot(workspace);
      h2Assert(workspace.demo && workspace.requests.length === 0);
      const request = execute(workspace, "owner-a", "request", { siteId: fixture.siteId, kitId: fixture.kitId,
        fundId: fixture.fundId, target: fixture.target, budget: fixture.budget,
        deadline: fixture.deadline, notes: fixture.notes }, randomUUID()) as PurchaseRequest;
      h2Assert(financialSnapshot(workspace) === initialFinancial);
      return { case: (index + 1) as 1 | 2, workspaceId: workspace.id, requestId: request.id,
        initialHash: sha(workspace), initialFinancial, requestDigest: sha(request) };
    });
    for (const [index, workspace] of workspaces.entries()) {
      await writeOnce(path.join(paths.data, `${workspace.id}.json`), workspace);
      await writeOnce(path.join(paths.evidence, `initial-${index + 1}.json`), workspace);
    }
    const manifest: ProbeManifest = { version: 1, policy: INITIAL_PROBE, id, binding, fixtureTime,
      allCasesDigest: sha(fixtures), sourceDigest, buildId, cases };
    await writeOnce(path.join(paths.evidence, "manifest.json"), manifest);
    return manifest;
  });
}
export async function readProbe(root: string, id: string) {
  const paths = probePaths(root, id);
  const manifest = await readRecord<ProbeManifest>(path.join(paths.evidence, "manifest.json"));
  validateBinding(root, manifest.binding);
  h2Assert(manifest.version === 1 && manifest.id === id && sha(manifest.policy) === sha(INITIAL_PROBE) &&
    manifest.allCasesDigest === sha(plannerCases(manifest.fixtureTime)) &&
    await evaluationSourceDigest(root) === manifest.sourceDigest &&
    (await readFile(contained(root, ".next", "BUILD_ID"), "utf8")).trim() === manifest.buildId &&
    manifest.cases.length === 2 && manifest.cases.every((entry, index) => entry.case === index + 1));
  const workspaces: Workspace[] = [];
  for (const entry of manifest.cases) {
    h2Assert(uuid.test(entry.workspaceId) && uuid.test(entry.requestId));
    const initial = await readRecord<Workspace>(path.join(paths.evidence, `initial-${entry.case}.json`));
    const workspace = await readRecord<Workspace>(path.join(paths.data, `${entry.workspaceId}.json`));
    const request = workspace.requests.find((item) => item.id === entry.requestId);
    const fixture = plannerCases(manifest.fixtureTime)[entry.case - 1];
    h2Assert(initial.id === entry.workspaceId && initial.demo && sha(initial) === entry.initialHash &&
      sha(workspace) === entry.initialHash && financialSnapshot(initial) === entry.initialFinancial &&
      request && sha(request) === entry.requestDigest && request.siteId === fixture.siteId &&
      request.kitId === fixture.kitId && request.fundId === fixture.fundId &&
      request.target === fixture.target && request.budget === fixture.budget && request.deadline === fixture.deadline);
    workspaces.push(workspace);
  }
  return { paths, manifest, workspaces };
}
export function validateProbeApproval(manifest: ProbeManifest, approval: ProbeApproval, clock: SafetyClock) {
  const times = [approval.quietSince, approval.usageObservedAt, approval.windowStart, approval.windowEnd];
  h2Assert(approval.manifestHash === sha(manifest) && hash.test(approval.quotaHead) &&
    times.every((time) => Number.isSafeInteger(time) && time > 0) &&
    approval.quietSince + INITIAL_PROBE.quietSettleMs <= approval.usageObservedAt &&
    approval.usageObservedAt <= approval.windowStart &&
    approval.windowStart - approval.usageObservedAt <= INITIAL_PROBE.observationAgeMs &&
    approval.windowEnd > approval.windowStart &&
    approval.windowEnd - approval.windowStart <= INITIAL_PROBE.windowMs &&
    approval.day === pacificDay(approval.windowStart) && approval.day === pacificDay(approval.windowEnd) &&
    clock.now() >= approval.windowStart && clock.now() < approval.windowEnd &&
    clock.now() - approval.usageObservedAt <= INITIAL_PROBE.observationAgeMs &&
    [approval.knownPriorHttp, approval.laterExternalReservedHttp].every((value) =>
      Number.isSafeInteger(value) && value >= 0) &&
    approval.knownPriorHttp + approval.laterExternalReservedHttp + INITIAL_PROBE.http <= H2.dailyHttp &&
    /^[a-zA-Z0-9._/-]{1,160}$/.test(approval.usageReference));
}
export async function createProbePolicy(root: string, manifest: ProbeManifest, approval: ProbeApproval,
  signal: AbortSignal, clock: SafetyClock = safetyClock, transport: typeof fetch = fetch) {
  validateProbeApproval(manifest, approval, clock); const paths = probePaths(root, manifest.id);
  const journal = new H2Journal(paths.quota), baseline = await journal.read();
  const origin = await readRecord<QuotaOrigin>(path.join(paths.quota, "origin.json"));
  const reservations = baseline.filter((event) => event.value.kind === "pair-reserved" && event.value.day === approval.day);
  const accounted = reservations.length * 2 + (origin.day === approval.day ? origin.knownUsed : 0);
  h2Assert(origin.project === manifest.binding.project && baseline.length > 0 &&
    sha(baseline[0].value) === sha({ kind: "origin", ...origin }) &&
    baseline.at(-1)!.hash === approval.quotaHead && Number.isSafeInteger(accounted) &&
    accounted >= 0 && approval.knownPriorHttp >= accounted &&
    !baseline.some((event) => event.value.kind === "poison" || event.value.campaign === manifest.id));
  const started = clock.monotonic(); let lastWall = clock.now(), stopped = false, busy = false;
  const active = () => {
    signal.throwIfAborted(); const now = clock.now(), elapsed = clock.monotonic() - started;
    h2Assert(!stopped && now >= lastWall && now >= approval.windowStart && now < approval.windowEnd &&
      pacificDay(now) === approval.day && elapsed >= 0 && elapsed < INITIAL_PROBE.windowMs);
    lastWall = now;
  };
  const coordinated = async () => {
    active(); const value = await readRecord<Coordination>(path.join(paths.evidence, "coordination.json"));
    h2Assert(value.approvalHash === sha(approval) && value.exclusive === true && value.unaccountedUse === false);
    active();
  };
  const attempt = async (kind: "count" | "generation") => {
    await coordinated(); const events = await journal.read();
    const attempts = events.filter((event) => event.value.kind === "probe-http-attempt" && event.value.campaign === manifest.id);
    h2Assert(!events.some((event) => event.value.kind === "poison") && attempts.length < INITIAL_PROBE.http &&
      attempts.filter((event) => event.value.method === kind).length < INITIAL_PROBE.pairs);
    await journal.append({ kind: "probe-http-attempt", campaign: manifest.id, method: kind,
      day: approval.day, at: clock.now(), approvalHash: sha(approval) });
    active();
  };
  const countedTransport: typeof fetch = async (input, init) => {
    h2Assert(String(input) === `https://generativelanguage.googleapis.com/v1beta/models/${manifest.binding.model}:countTokens` &&
      init?.method === "POST" && init.redirect === "error");
    await attempt("count"); init.signal?.throwIfAborted(); active(); return transport(input, init);
  };
  const h2 = createH2Policy({ root: paths.quota, project: manifest.binding.project, campaign: manifest.id,
    caseId: 2, model: manifest.binding.model, day: approval.day, approvedDay: approval.day,
    knownProjectUseReference: approval.usageReference, signal, assertActive: active, clock, transport: countedTransport });
  const policy: EvaluationTransportPolicy = { async dispatch(request) {
    if (busy) {
      stopped = true;
      await journal.append({ kind: "poison", campaign: manifest.id, day: approval.day, at: clock.now() }).catch(() => {});
      throw new Error("Concurrent initial-probe dispatch refused; preserve accounting.");
    }
    busy = true;
    try {
      await coordinated(); const events = await journal.read();
      h2Assert(events.filter((event) => event.value.kind === "pair-reserved" &&
        event.value.campaign === manifest.id).length < INITIAL_PROBE.pairs);
      return await h2.dispatch({ ...request, send: async () => { await attempt("generation"); return request.send(); } });
    } catch {
      stopped = true;
      await journal.append({ kind: "poison", campaign: manifest.id, day: approval.day, at: clock.now() }).catch(() => {});
      throw new Error("Initial probe stopped. Preserve evidence and accounting; no automatic retry.");
    } finally { busy = false; }
  } };
  // This is owner-coordinated. It cannot detect an unreported request from another client.
  return { policy, active, coordinated };
}
type ProbeExecution = (workspaceId: string, requestId: string, fixtureTime: number,
  shared: ReturnType<typeof createModelBudget>, policy: EvaluationTransportPolicy) => Promise<Proposal>;
export async function runInitialProbe(root: string, id: string, approval: ProbeApproval, executePositive: ProbeExecution,
  clock: SafetyClock = safetyClock, transport: typeof fetch = fetch) {
  const paths = probePaths(root, id);
  return withProjectLock(paths.quota, async () => {
    const { manifest, workspaces } = await readProbe(root, id);
    const remaining = approval.windowEnd - clock.now();
    h2Assert(Number.isSafeInteger(remaining) && remaining > 0 && remaining <= INITIAL_PROBE.windowMs);
    const signal = AbortSignal.timeout(remaining);
    const guarded = await createProbePolicy(root, manifest, approval, signal, clock, transport);
    await guarded.coordinated();
    const baselines = manifest.cases.map((entry, index) => {
      const request = workspaces[index].requests.find((item) => item.id === entry.requestId)!;
      return plan(workspaces[index], request, undefined, manifest.fixtureTime);
    });
    h2Assert(baselines[0].shortages.length > 0 && baselines[1].shortages.length === 0);
    await writeOnce(path.join(paths.evidence, "started.json"), { manifestHash: sha(manifest), approvalHash: sha(approval) });
    let phase: "PLANNER_EXECUTION" | "COMPARISON" | "PERSISTED_STATE" | "QUOTA_AUDIT" |
      "FINAL_COORDINATION" | "RECEIPT_RECORD" = "PLANNER_EXECUTION";
    try {
      const shared = bindModelBudgetSignal(createModelBudget(probeLimits, "evaluation"), signal), positive = manifest.cases[1];
      const candidate = await executePositive(positive.workspaceId, positive.requestId, manifest.fixtureTime, shared, guarded.policy);
      guarded.active(); phase = "COMPARISON"; const comparison = comparePlannerBaseline(baselines[1], candidate);
      h2Assert(comparison.baselineFeasible && comparison.candidateFeasible && comparison.feasibilityMatches);
      phase = "PERSISTED_STATE";
      for (const entry of manifest.cases) {
        const workspace = await readRecord<Workspace>(path.join(paths.data, `${entry.workspaceId}.json`));
        const request = workspace.requests.find((item) => item.id === entry.requestId);
        h2Assert(financialSnapshot(workspace) === entry.initialFinancial && request && sha(request) === entry.requestDigest);
        if (entry.case === 1) h2Assert(sha(workspace) === entry.initialHash);
        else h2Assert(workspace.proposals.some((proposal) => proposal.id === candidate.id && sha(proposal) === sha(candidate)) &&
          workspace.agentRuns.some((run) => run.source === "gemini" && run.status === "completed" && run.evidence.includes(candidate.digest)));
      }
      phase = "QUOTA_AUDIT";
      const audit = await auditCampaignQuota(paths.quota, manifest.binding.project, id);
      h2Assert(audit.countCalls >= 1 && audit.countCalls <= 3 && audit.generationCalls === audit.countCalls &&
        shared.attempts === audit.generationCalls);
      const entries = await new H2Journal(paths.quota).read();
      const attempts = entries.filter((entry) => entry.value.kind === "probe-http-attempt" && entry.value.campaign === id);
      h2Assert(attempts.length === audit.countCalls * 2 && attempts.length <= INITIAL_PROBE.http);
      phase = "FINAL_COORDINATION"; await guarded.coordinated();
      const receipt = { status: "INITIAL_FEASIBILITY_OBSERVED", fullCampaignAccepted: false,
        manifestHash: sha(manifest), approvalHash: sha(approval), sourceDigest: manifest.sourceDigest,
        buildId: manifest.buildId, negativeCase: { case: 1, deterministicInfeasible: true, providerHttp: 0 },
        positiveCase: { case: 2, comparison }, financialArraysUnchanged: true,
        countCalls: audit.countCalls, generationCalls: audit.generationCalls, httpReserved: audit.httpReserved,
        quotaHead: entries.at(-1)!.hash };
      phase = "RECEIPT_RECORD"; await writeOnce(path.join(paths.evidence, "receipt.json"), receipt); return receipt;
    } catch {
      await new H2Journal(paths.quota).append({ kind: "poison", campaign: id, day: approval.day, at: clock.now() }).catch(() => {});
      await writeOnce(path.join(paths.evidence, "failed.json"), { status: "STOPPED_NOT_ACCEPTED",
        manifestHash: sha(manifest), approvalHash: sha(approval), fullCampaignAccepted: false,
        diagnostic: { version: 1, phase } }).catch(() => {});
      throw new Error("Initial probe stopped. Preserve the project lock and evidence; reconcile before any new run.");
    }
  });
}
export function admitProbeRuntimeSettings(root: string, manifest: ProbeManifest, approval: ProbeApproval) {
  const config = configuration(), paths = probePaths(root, manifest.id);
  h2Assert(process.env.RUN_INITIAL_GEMINI_PROBE === "true" && process.env.APP_ENV === "local" &&
    !config.hosted && config.storage === "local" && config.payments === "simulation" &&
    !config.financialActions && config.providerActions && config.ai === "gemini" &&
    process.env.PROBE_APPROVED_APPROVAL_SHA256 === sha(approval) &&
    process.env.PROBE_CREDENTIAL_REFERENCE === manifest.binding.credentialReference &&
    process.env.PROBE_OPERATOR === manifest.binding.operator && requiredGeminiModel() === manifest.binding.model &&
    sha(requiredModelLimits()) === sha(probeLimits) && process.env.PANTRYPILOT_DATA_DIR &&
    path.resolve(process.env.PANTRYPILOT_DATA_DIR) === paths.data);
}
export function admitProbeRuntime(root: string, manifest: ProbeManifest, approval: ProbeApproval) {
  admitProbeRuntimeSettings(root, manifest, approval);
  // This presence check is after all non-secret runtime checks. No dotenv/private-file loader exists.
  h2Assert(Boolean(process.env.GEMINI_API_KEY));
}
