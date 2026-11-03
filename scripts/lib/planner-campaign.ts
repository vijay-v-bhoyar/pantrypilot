import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Workspace } from "../../src/lib/types";
import type { PurchaseRequest } from "../../src/lib/types";
import { execute } from "../../src/lib/commands";
import { randomUUID } from "node:crypto";
import type { ModelLimits } from "../../src/lib/model-budget";
import { evaluationSourceDigest, plannerCases, plannerVerdict, financialSnapshot,
  type EvaluationRow } from "./planner-evaluation";
import { H2, H3, H2Journal, auditCampaignQuota, auditH3Quota, contained, h2Assert, pacificDay, readRecord, safeDirectory, sha,
  withProjectLock, writeOnce, type SafetyClock, safetyClock } from "./planner-quota";

export type CampaignBinding = { model: string; project: string; credentialReference: string;
  operator: string; limits: ModelLimits; session: ModelLimits };
export type CampaignManifest = CampaignBinding & { schemaVersion: 2 | 3; policy: typeof H2 | typeof H3;
  id: string; sourceDigest: string; buildId: string; fixtureTime: number;
  initialWorkspaceHash: string; initialFinancial: string; workspaceId: string;
  cases: (ReturnType<typeof plannerCases>[number] & { requestId: string; requestDigest: string })[]; configDigest: string };
export type CampaignEvent = { kind: "initialized" | "started" | "outcome";
  [key: string]: unknown };
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const reference = /^[a-zA-Z0-9._-]{1,100}$/;
export function campaignPaths(root: string, id: string, project: string) {
  h2Assert(uuid.test(id) && /^[a-z][a-z0-9-]{5,62}$/.test(project));
  return { evidence: contained(root, "output", "live-evals", id),
    data: contained(root, ".data", "ai-evals", id),
    quota: contained(root, ".data", "eval-quotas", project) };
}
export function validateBinding(binding: CampaignBinding) { validateFixedBinding(binding, H2); }
function validateFixedBinding(binding: CampaignBinding, policy: typeof H2 | typeof H3) {
  h2Assert(/^[a-z0-9][a-z0-9.-]{0,99}$/.test(binding.model) &&
    /^[a-z][a-z0-9-]{5,62}$/.test(binding.project) && reference.test(binding.credentialReference) && reference.test(binding.operator));
  h2Assert(JSON.stringify(binding.limits) === JSON.stringify({ maxHttpRequests: policy.caseGenerations,
    maxInputBytes: H2.maxInputBytes, maxOutputTokens: H2.maxOutputTokens, timeoutMs: H2.blockTimeoutMs }) &&
    JSON.stringify(binding.session) === JSON.stringify({ ...binding.limits, maxHttpRequests: 20 }));
}
export async function initializeCampaign(root: string, id: string, binding: CampaignBinding, workspace: Workspace) {
  return initializeFixedCampaign(root, id, binding, workspace, H2);
}
async function initializeFixedCampaign(root: string, id: string, binding: CampaignBinding, workspace: Workspace, policy: typeof H2 | typeof H3) {
  validateFixedBinding(binding, policy); const paths = campaignPaths(root, id, binding.project);
  h2Assert(workspace.demo && workspace.requests.length === 0 && uuid.test(workspace.id));
  const fixtureTime = Date.parse(workspace.createdAt); h2Assert(Number.isFinite(fixtureTime));
  const initialFinancial = financialSnapshot(workspace);
  // Freeze all request records during offline initialization. execute() rightly refuses past
  // real-world deadlines; creating the same seven-day request on day 8 would change the oracle.
  const cases = plannerCases(fixtureTime).map((fixture) => {
    const request = execute(workspace, "owner-a", "request", { siteId: fixture.siteId, kitId: fixture.kitId,
      fundId: fixture.fundId, target: fixture.target, budget: fixture.budget, deadline: fixture.deadline,
      notes: fixture.notes }, randomUUID()) as PurchaseRequest;
    return { ...fixture, requestId: request.id, requestDigest: sha(request) };
  });
  h2Assert(financialSnapshot(workspace) === initialFinancial);
  const sourceDigest = await evaluationSourceDigest(root);
  const buildId = (await readFile(contained(root, ".next", "BUILD_ID"), "utf8")).trim();
  h2Assert(/^[a-zA-Z0-9_-]{1,120}$/.test(buildId));
  const configDigest = sha({ binding, policy, api: "v1beta", fixtureTime,
    cases, sourceDigest, buildId, initialWorkspaceHash: sha(workspace) });
  const manifest: CampaignManifest = { ...binding, schemaVersion: policy === H2 ? 2 : 3, policy, id,
    sourceDigest, buildId, fixtureTime, initialWorkspaceHash: sha(workspace),
    initialFinancial, workspaceId: workspace.id, cases, configDigest };
  await safeDirectory(path.dirname(paths.evidence), true); await mkdir(paths.evidence);
  await safeDirectory(path.dirname(paths.data), true); await mkdir(paths.data);
  await mkdir(path.join(paths.evidence, "blocks"));
  const journal = new H2Journal(paths.evidence); await journal.initialize();
  await writeOnce(path.join(paths.evidence, "manifest.json"), manifest);
  await writeOnce(path.join(paths.evidence, "initial-workspace.json"), workspace);
  await writeOnce(path.join(paths.data, `${workspace.id}.json`), workspace);
  await journal.append({ kind: "initialized", manifestHash: sha(manifest), workspaceHash: sha(workspace) });
  return manifest;
}
export async function readCampaign(root: string, id: string, project: string) {
  return readFixedCampaign(root, id, project, H2);
}
async function readFixedCampaign(root: string, id: string, project: string, policy: typeof H2 | typeof H3) {
  const paths = campaignPaths(root, id, project);
  const manifest = await readRecord<CampaignManifest>(path.join(paths.evidence, "manifest.json"));
  validateFixedBinding(manifest, policy);
  if (policy === H3) h2Assert(Object.keys(manifest).sort().join() ===
    ["model", "project", "credentialReference", "operator", "limits", "session", "schemaVersion", "policy", "id", "sourceDigest", "buildId", "fixtureTime", "initialWorkspaceHash", "initialFinancial", "workspaceId", "cases", "configDigest"].sort().join());
  h2Assert(manifest.schemaVersion === (policy === H2 ? 2 : 3) && manifest.id === id && manifest.project === project &&
    sha(manifest.policy) === sha(policy) && Array.isArray(manifest.cases) && manifest.cases.length === 12 &&
    sha(manifest.cases.map(({ requestId, requestDigest, ...fixture }) => {
      h2Assert(uuid.test(requestId) && /^[a-f0-9]{64}$/.test(requestDigest)); return fixture;
    })) === sha(plannerCases(manifest.fixtureTime)));
  const binding: CampaignBinding = { model: manifest.model, project: manifest.project,
    credentialReference: manifest.credentialReference, operator: manifest.operator,
    limits: manifest.limits, session: manifest.session };
  h2Assert(manifest.configDigest === sha({ binding, policy, api: "v1beta", fixtureTime: manifest.fixtureTime,
    cases: manifest.cases, sourceDigest: manifest.sourceDigest, buildId: manifest.buildId,
    initialWorkspaceHash: manifest.initialWorkspaceHash }));
  const initial = await readRecord<Workspace>(path.join(paths.evidence, "initial-workspace.json"));
  h2Assert(sha(initial) === manifest.initialWorkspaceHash && initial.id === manifest.workspaceId &&
    financialSnapshot(initial) === manifest.initialFinancial);
  const journal = new H2Journal(paths.evidence), events = await journal.read();
  h2Assert(events.length > 0 && events[0].value.kind === "initialized" &&
    events[0].value.manifestHash === sha(manifest) && events[0].value.workspaceHash === manifest.initialWorkspaceHash);
  const outcomes: { row: EvaluationRow; day: string; workspaceHash: string; infrastructureFailed: boolean }[] = [];
  for (let i = 1; i < events.length; i += 2) {
    const start = events[i].value, finish = events[i + 1]?.value;
    h2Assert(start.kind === "started" && start.caseId === outcomes.length + 1 &&
      typeof start.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(start.day));
    // An incomplete started case is uncertainty, never a resumable case.
    h2Assert(finish?.kind === "outcome" && finish.caseId === start.caseId && finish.day === start.day &&
      typeof finish.workspaceHash === "string" && /^[a-f0-9]{64}$/.test(finish.workspaceHash) &&
      typeof finish.infrastructureFailed === "boolean");
    const row = finish.row as EvaluationRow;
    h2Assert(row?.case === start.caseId && ["PASS", "FAIL", "BLOCKED"].includes(row.status));
    if (outcomes.length) h2Assert(policy === H2 ? outcomes.at(-1)!.day < start.day : outcomes.at(-1)!.day <= start.day);
    const block = await readRecord<Record<string, unknown>>(path.join(paths.evidence, "blocks", `${outcomes.length}.json`));
    h2Assert(sha(block) === sha(finish));
    outcomes.push({ row, day: start.day, workspaceHash: finish.workspaceHash as string,
      infrastructureFailed: finish.infrastructureFailed as boolean });
  }
  h2Assert(outcomes.length <= 12);
  const workspace = await readRecord<Workspace>(path.join(paths.data, `${manifest.workspaceId}.json`));
  h2Assert(sha(workspace) === (outcomes.at(-1)?.workspaceHash || manifest.initialWorkspaceHash) &&
    financialSnapshot(workspace) === manifest.initialFinancial);
  h2Assert(manifest.cases.every((fixture) => {
    const request = workspace.requests.find((r) => r.id === fixture.requestId);
    return request && sha(request) === fixture.requestDigest;
  }));
  return { paths, manifest, workspace, journal, outcomes };
}
export async function assertCurrentSubject(root: string, manifest: CampaignManifest, binding: CampaignBinding) {
  return assertFixedSubject(root, manifest, binding, H2);
}
async function assertFixedSubject(root: string, manifest: CampaignManifest, binding: CampaignBinding, policy: typeof H2 | typeof H3) {
  validateFixedBinding(binding, policy);
  h2Assert(sha(binding) === sha({ model: manifest.model, project: manifest.project,
    credentialReference: manifest.credentialReference, operator: manifest.operator,
    limits: manifest.limits, session: manifest.session }) &&
    await evaluationSourceDigest(root) === manifest.sourceDigest &&
    (await readFile(contained(root, ".next", "BUILD_ID"), "utf8")).trim() === manifest.buildId);
}
export type BlockApproval = { manifestHash: string; day: string; quotaReference: string };
export type BlockCaseResult = { row: EvaluationRow; infrastructureFailed: boolean };
export async function runCampaignBlock(root: string, id: string, project: string, binding: CampaignBinding,
  approval: BlockApproval, executeCase: (manifest: CampaignManifest, caseId: number,
    assertActive: () => void, signal: AbortSignal) => Promise<BlockCaseResult>, clock: SafetyClock = safetyClock) {
  return runFixedBlock(root, id, project, binding, approval, executeCase, clock, H2);
}
type CaseExecutor = Parameters<typeof runCampaignBlock>[5];
type CampaignState = Awaited<ReturnType<typeof readFixedCampaign>>;
async function runFixedBlock(root: string, id: string, project: string, binding: CampaignBinding,
  approval: BlockApproval, executeCase: CaseExecutor, clock: SafetyClock, policy: typeof H2 | typeof H3,
  beforeStart?: (state: CampaignState) => Promise<void>) {
  const { quota } = campaignPaths(root, id, project);
  return withProjectLock(quota, async () => {
    const state = await readFixedCampaign(root, id, project, policy);
    await assertFixedSubject(root, state.manifest, binding, policy);
    const day = pacificDay(clock.now()), caseId = state.outcomes.length + 1;
    h2Assert(caseId <= 12 && approval.manifestHash === sha(state.manifest) && approval.day === day &&
      /^[a-zA-Z0-9._/-]{1,160}$/.test(approval.quotaReference) &&
      state.outcomes.every((outcome) => !outcome.infrastructureFailed && outcome.row.status !== "BLOCKED") &&
      (!state.outcomes.length || (policy === H2 ? state.outcomes.at(-1)!.day < day : state.outcomes.at(-1)!.day <= day)));
    // Reserve enough same-day time for the entire active block; no near-midnight start.
    h2Assert(pacificDay(clock.now() + H2.blockTimeoutMs) === day);
    await beforeStart?.(state);
    const started = clock.monotonic(); const signal = AbortSignal.timeout(H2.blockTimeoutMs);
    const assertActive = () => { signal.throwIfAborted(); h2Assert(clock.monotonic() - started < H2.blockTimeoutMs &&
      (policy === H2 || clock.monotonic() >= started) &&
      pacificDay(clock.now()) === day); };
    await state.journal.append({ kind: "started", caseId, day, manifestHash: sha(state.manifest),
      quotaReference: approval.quotaReference });
    // Callback failures deliberately leave a started marker and lock; no replay after uncertain mutation.
    const result = await executeCase(state.manifest, caseId, assertActive, signal);
    const workspace = await readRecord<Workspace>(path.join(state.paths.data, `${state.manifest.workspaceId}.json`));
    const unchanged = financialSnapshot(workspace) === state.manifest.initialFinancial;
    h2Assert(unchanged && result.row.case === caseId);
    const finish = { kind: "outcome", caseId, day, row: result.row, workspaceHash: sha(workspace),
      infrastructureFailed: result.infrastructureFailed };
    // Receipt first; crash at either side of journal commit remains a fail-closed incomplete case.
    await writeOnce(path.join(state.paths.evidence, "blocks", `${caseId - 1}.json`), finish);
    await state.journal.append(finish);
    if (policy === H3) h2Assert(!result.infrastructureFailed && result.row.status !== "BLOCKED");
    return finish;
  });
}
export async function finalizeCampaign(root: string, id: string, project: string) {
  const result = await finalizeFixedCampaign(root, id, project, H2);
  h2Assert("accepted" in result); return result;
}
async function finalizeFixedCampaign(root: string, id: string, project: string, policy: typeof H2 | typeof H3) {
  const { quota } = campaignPaths(root, id, project);
  return withProjectLock(quota, async () => {
    const state = await readFixedCampaign(root, id, project, policy);
    const binding: CampaignBinding = { model: state.manifest.model, project,
      credentialReference: state.manifest.credentialReference, operator: state.manifest.operator,
      limits: state.manifest.limits, session: state.manifest.session };
    await assertFixedSubject(root, state.manifest, binding, policy);
    h2Assert(state.outcomes.length === 12);
    const rows = state.outcomes.map((o) => o.row), infrastructureFailed = state.outcomes.some((o) => o.infrastructureFailed);
    const sideEffectsUnchanged = financialSnapshot(state.workspace) === state.manifest.initialFinancial;
    const quota = await (policy === H2 ? auditCampaignQuota : auditH3Quota)(state.paths.quota, project, id);
    h2Assert(rows.every((row, index) => row.status !== "PASS" || quota.cases[index].generationCalls > 0));
    const result = { schemaVersion: policy === H2 ? 2 : 3, policy: policy.policy, manifestHash: sha(state.manifest),
      sourceDigest: state.manifest.sourceDigest, configDigest: state.manifest.configDigest,
      rows, infrastructureFailed, sideEffectsUnchanged, quota,
      ...(policy === H2 ? { accepted: plannerVerdict(rows, sideEffectsUnchanged, infrastructureFailed) } :
        { hackathonGateAccepted: plannerVerdict(rows, sideEffectsUnchanged, infrastructureFailed), fullCampaignAccepted: false as const }),
      evidenceClass: "provider campaign; hosted, human and other integrations remain separate" };
    await writeOnce(path.join(state.paths.evidence, "final.json"), result); return result;
  });
}

// Fixed H3 entrypoints; the existing exports above remain H2-only defaults.
export const hackathonLifecycle = Object.freeze({
  validateBinding: (binding: CampaignBinding) => validateFixedBinding(binding, H3),
  initialize: (root: string, id: string, binding: CampaignBinding, workspace: Workspace) =>
    initializeFixedCampaign(root, id, binding, workspace, H3),
  read: (root: string, id: string, project: string) => readFixedCampaign(root, id, project, H3),
  assertSubject: (root: string, manifest: CampaignManifest, binding: CampaignBinding) => assertFixedSubject(root, manifest, binding, H3),
  run: (root: string, id: string, project: string, binding: CampaignBinding, approval: BlockApproval,
    executeCase: CaseExecutor, beforeStart: (state: CampaignState) => Promise<void>, clock: SafetyClock = safetyClock) =>
    runFixedBlock(root, id, project, binding, approval, executeCase, clock, H3, beforeStart),
  finalize: async (root: string, id: string, project: string) => {
    const result = await finalizeFixedCampaign(root, id, project, H3);
    h2Assert("hackathonGateAccepted" in result); return result;
  },
});
