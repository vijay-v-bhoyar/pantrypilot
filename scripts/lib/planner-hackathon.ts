import path from "node:path";
import type { Workspace } from "../../src/lib/types";
import { hackathonLifecycle, campaignPaths, type CampaignBinding, type CampaignManifest,
  type BlockCaseResult } from "./planner-campaign";
import { H3, H2Journal, createH3Policy, h2Assert, pacificDay, projectDayUsed, readRecord,
  safetyClock, sha, withProjectLock, type QuotaOrigin, type SafetyClock } from "./planner-quota";
import type { EvaluationTransportPolicy } from "../../src/lib/model-budget";
import { bindModelBudgetSignal, createModelBudget, type ModelLimits } from "../../src/lib/model-budget";

export { H3 } from "./planner-quota";
export const HACKATHON_CUTOFF = Date.parse("2026-11-12T20:00:00Z");
const hash = /^[a-f0-9]{64}$/;
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const grantKeys = ["policy", "scope", "canonicalRoot", "campaignId", "caseId", "sourceDigest", "buildId",
  "configDigest", "manifestHash", "project", "model", "operator", "credentialReference", "quotaHead",
  "day", "quietSince", "usageObservedAt", "windowStart", "windowEnd", "knownPriorHttp",
  "laterExternalReservedHttp", "usageReference", "nonce", "pid", "maxHttpRequests"];
export type HackathonGrant = {
  policy: typeof H3.policy; scope: "H3_SINGLE_CASE"; canonicalRoot: string; campaignId: string; caseId: number;
  sourceDigest: string; buildId: string; configDigest: string; manifestHash: string;
  project: string; model: string; operator: string; credentialReference: string; quotaHead: string;
  day: string; quietSince: number; usageObservedAt: number; windowStart: number; windowEnd: number;
  knownPriorHttp: number; laterExternalReservedHttp: number; usageReference: string;
  nonce: string; pid: number; maxHttpRequests: 12;
};
type Coordination = { approvalHash: string; nonce: string; pid: number; exclusive: true; unaccountedUse: false };
export type HackathonExecutor = (manifest: CampaignManifest, caseId: number, active: () => void,
  signal: AbortSignal, policy: EvaluationTransportPolicy) => Promise<BlockCaseResult>;

// Preserve live attempt accounting while joining the exact approval-window signal.
export function createHackathonBudget(limits: ModelLimits, approvalSignal: AbortSignal) {
  return bindModelBudgetSignal(createModelBudget(limits, "evaluation"), approvalSignal);
}

export async function initializeHackathon(root: string, id: string, binding: CampaignBinding, workspace: Workspace) {
  // No new origin/reset route: initialization requires an existing canonical clean ledger.
  const paths = campaignPaths(root, id, binding.project);
  return withProjectLock(paths.quota, async () => {
    await inspectQuota(root, id, binding.project, pacificDay(Date.now()));
    const { model, project, credentialReference, operator, limits, session } = binding;
    return hackathonLifecycle.initialize(root, id, { model, project, credentialReference, operator, limits, session }, workspace);
  });
}
export const readHackathon = hackathonLifecycle.read;
export const finalizeHackathon = hackathonLifecycle.finalize;
async function inspectQuota(root: string, id: string, project: string, day: string) {
  const paths = campaignPaths(root, id, project);
  const origin = await readRecord<QuotaOrigin>(path.join(paths.quota, "origin.json"));
  const entries = await new H2Journal(paths.quota).read(), values = entries.map(e => e.value);
  h2Assert(origin.project === project && origin.day <= day && entries.length > 0 &&
    sha(values[0]) === sha({ kind: "origin", ...origin }) && !values.some(e => e.kind === "poison"));
  return { paths, entries, used: projectDayUsed(values, origin, day) };
}
export function validateHackathonGrant(root: string, manifest: CampaignManifest, nextCase: number,
  grant: HackathonGrant, approvedHash: string, pid: number, clock: SafetyClock) {
  h2Assert(Object.keys(grant).sort().join() === [...grantKeys].sort().join() &&
    grant.policy === H3.policy && grant.scope === "H3_SINGLE_CASE" && grant.maxHttpRequests === 12 &&
    hash.test(approvedHash) && sha(grant) === approvedHash && hash.test(grant.quotaHead) &&
    path.resolve(grant.canonicalRoot) === path.resolve(root) && grant.campaignId === manifest.id &&
    grant.caseId === nextCase && nextCase >= 1 && nextCase <= 12 &&
    grant.sourceDigest === manifest.sourceDigest && grant.buildId === manifest.buildId &&
    grant.configDigest === manifest.configDigest && grant.manifestHash === sha(manifest) &&
    grant.project === manifest.project && grant.model === manifest.model &&
    grant.operator === manifest.operator && grant.credentialReference === manifest.credentialReference &&
    uuid.test(grant.nonce) && Number.isSafeInteger(pid) && pid > 0 && grant.pid === pid &&
    /^[a-zA-Z0-9._/-]{1,160}$/.test(grant.usageReference));
  const times = [grant.quietSince, grant.usageObservedAt, grant.windowStart, grant.windowEnd];
  h2Assert(times.every(t => Number.isSafeInteger(t) && t > 0) &&
    grant.quietSince + 900000 <= grant.usageObservedAt && grant.usageObservedAt <= grant.windowStart &&
    grant.windowStart <= clock.now() && clock.now() < grant.windowEnd &&
    clock.now() - grant.usageObservedAt <= 60000 &&
    grant.windowEnd - grant.windowStart <= H3.blockTimeoutMs &&
    grant.windowEnd <= HACKATHON_CUTOFF && clock.now() + H3.blockTimeoutMs <= HACKATHON_CUTOFF &&
    grant.day === pacificDay(clock.now()) && grant.day === pacificDay(grant.windowStart) &&
    grant.day === pacificDay(grant.windowEnd) &&
    [grant.knownPriorHttp, grant.laterExternalReservedHttp].every(n => Number.isSafeInteger(n) && n >= 0 && n <= H3.dailyHttp));
}
async function inspect(root: string, id: string, project: string, grant: HackathonGrant,
  approvedHash: string, pid: number, clock: SafetyClock) {
  const state = await readHackathon(root, id, project);
  const { model, credentialReference, operator, limits, session } = state.manifest;
  const binding = { model, project, credentialReference, operator, limits, session };
  await hackathonLifecycle.assertSubject(root, state.manifest, binding);
  validateHackathonGrant(root, state.manifest, state.outcomes.length + 1, grant, approvedHash, pid, clock);
  h2Assert(state.outcomes.every(o => !o.infrastructureFailed && o.row.status !== "BLOCKED"));
  const quota = await checkedQuota(root, id, project, grant, clock);
  return { state, binding, quota };
}
async function checkedQuota(root: string, id: string, project: string, grant: HackathonGrant, clock: SafetyClock) {
  const quota = await inspectQuota(root, id, project, grant.day);
  h2Assert(quota.entries.at(-1)!.hash === grant.quotaHead && grant.knownPriorHttp >= quota.used &&
    !quota.entries.some(e => e.value.kind === "h3-grant" && e.value.nonce === grant.nonce) &&
    quota.entries.every(e => e.value.at === undefined ||
      (typeof e.value.at === "number" && e.value.at <= clock.now())));
  return quota;
}
export async function inspectHackathonAdmission(root: string, id: string, project: string,
  grant: HackathonGrant, approvedHash: string, pid: number, clock: SafetyClock = safetyClock) {
  const inspected = await inspect(root, id, project, grant, approvedHash, pid, clock);
  const remaining = H3.dailyHttp - grant.knownPriorHttp - grant.laterExternalReservedHttp;
  const campaignReserved = inspected.quota.entries.filter(e => e.value.kind === "pair-reserved" && e.value.campaign === id).length * 2;
  h2Assert(campaignReserved <= H3.campaignHttp && campaignReserved + 12 <= H3.campaignHttp);
  return { ...inspected, status: remaining < 12 ? "DEFER" as const : "READY" as const, remaining };
}
async function coordinated(evidence: string, grant: HackathonGrant) {
  const c = await readRecord<Coordination>(path.join(evidence, "h3-activation.json"));
  h2Assert(Object.keys(c).sort().join() === ["approvalHash", "nonce", "pid", "exclusive", "unaccountedUse"].sort().join() &&
    c.approvalHash === sha(grant) && c.nonce === grant.nonce && c.pid === grant.pid &&
    c.exclusive === true && c.unaccountedUse === false);
}
export async function runHackathonBlock(root: string, id: string, project: string, grant: HackathonGrant,
  approvedHash: string, pid: number, executeCase: HackathonExecutor, clock: SafetyClock = safetyClock) {
  const first = await inspectHackathonAdmission(root, id, project, grant, approvedHash, pid, clock);
  if (first.status === "DEFER") return { status: "DEFER" as const, remaining: first.remaining };
  await coordinated(first.state.paths.evidence, grant);
  // Full inspection and head comparison repeat under the project lock before any key callback.
  const beforeStart = async (state: Awaited<ReturnType<typeof readHackathon>>) => {
    // The lifecycle just re-read this state and verified source/build under the lock.
    // Reuse that verified snapshot rather than reading the complete case journal twice.
    validateHackathonGrant(root, state.manifest, state.outcomes.length + 1, grant, approvedHash, pid, clock);
    const quota = await checkedQuota(root, id, project, grant, clock);
    h2Assert(H3.dailyHttp - grant.knownPriorHttp - grant.laterExternalReservedHttp >= 12);
    await coordinated(state.paths.evidence, grant);
    const journal = new H2Journal(state.paths.quota);
    if (grant.knownPriorHttp > quota.used) await journal.append({ kind: "h3-external-accounting",
      http: grant.knownPriorHttp - quota.used, day: grant.day, at: clock.now(), usageReference: grant.usageReference });
    await journal.append({ kind: "h3-grant", nonce: grant.nonce, campaign: id, caseId: grant.caseId,
      approvalHash: approvedHash, day: grant.day, at: clock.now() });
  };
  const result = await hackathonLifecycle.run(root, id, project, first.binding,
    { manifestHash: grant.manifestHash, day: grant.day, quotaReference: grant.usageReference },
    async (manifest, caseId, active, signal) => {
      const remaining = grant.windowEnd - clock.now(); h2Assert(remaining > 0);
      const approvalSignal = AbortSignal.any([signal, AbortSignal.timeout(remaining)]);
      let lastWall = clock.now();
      const checkActive = () => { approvalSignal.throwIfAborted(); active(); const now = clock.now();
        h2Assert(now >= lastWall && now >= grant.windowStart && now < grant.windowEnd); lastWall = now; };
      const underlying = createH3Policy({ root: first.state.paths.quota, project, campaign: id, caseId,
        model: manifest.model, day: grant.day, approvedDay: grant.day,
        knownProjectUseReference: grant.usageReference, laterExternalReservedHttp: grant.laterExternalReservedHttp,
        signal: approvalSignal, assertActive: checkActive, clock, transport: async (input, init) => {
          checkActive(); await coordinated(first.state.paths.evidence, grant);
          init?.signal?.throwIfAborted(); return fetch(input, init);
        } });
      // Coordination is checked before BOTH endpoints; no auxiliary provider requests.
      const policy: EvaluationTransportPolicy = { async dispatch(request) {
        checkActive(); await coordinated(first.state.paths.evidence, grant);
        return underlying.dispatch({ ...request, send: async () => {
          checkActive(); await coordinated(first.state.paths.evidence, grant); return request.send();
        } });
      } };
      return executeCase(manifest, caseId, checkActive, approvalSignal, policy);
    }, beforeStart, clock);
  return { status: "COMPLETED" as const, result };
}

export type PlanningDay = { day: string; knownPriorHttp: number | null; reservedHttp: number;
  attended: boolean; windowStart: number; windowEnd: number };
export function planHackathonDates(caseCombinedRequests: number[], days: PlanningDay[]) {
  h2Assert(caseCombinedRequests.length === 12 && caseCombinedRequests.every(n => Number.isSafeInteger(n) && n >= 0 && n <= 12));
  const allocations: { day: string; cases: number[]; assumedHttp: number }[] = [];
  let next = 0, previous = "";
  for (const day of days) {
    h2Assert(/^\d{4}-\d{2}-\d{2}$/.test(day.day) && day.day > previous &&
      Number.isSafeInteger(day.reservedHttp) && day.reservedHttp >= 0 && day.reservedHttp <= 20 &&
      (day.knownPriorHttp === null || (Number.isSafeInteger(day.knownPriorHttp) && day.knownPriorHttp >= 0 && day.knownPriorHttp <= 20)) &&
      Number.isSafeInteger(day.windowStart) && Number.isSafeInteger(day.windowEnd) && day.windowEnd > day.windowStart &&
      pacificDay(day.windowStart) === day.day && pacificDay(day.windowEnd - 1) === day.day);
    previous = day.day;
    if (!day.attended || day.knownPriorHttp === null) continue;
    let remaining = 20 - day.knownPriorHttp - day.reservedHttp;
    let slots = Math.floor((Math.min(day.windowEnd, HACKATHON_CUTOFF) - day.windowStart) / H3.blockTimeoutMs);
    const cases: number[] = []; let assumedHttp = 0;
    while (next < 12 && remaining >= 12 && slots-- > 0) {
      const http = caseCombinedRequests[next]; remaining -= http; assumedHttp += http; cases.push(++next);
    }
    if (cases.length) allocations.push({ day: day.day, cases, assumedHttp });
  }
  return { feasibleUnderAssumptions: next === 12, unplacedCases: 12 - next, allocations,
    evidenceClass: "conditional arithmetic only; actual model usage, attendance and provider qualification unproven" };
}
