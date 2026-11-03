import { createHash, randomUUID } from "node:crypto";
import { readFile, lstat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { H2Journal, contained, h2Assert, readRecord, safetyClock, sha, writeOnce } from "./lib/planner-quota";
import { INITIAL_PROBE, admitProbeRuntimeSettings, createProbePolicy, probePaths,
  readProbe, runInitialProbe, type ProbeApproval } from "./lib/planner-probe";
import { campaignPaths } from "./lib/planner-campaign";
import { H3, inspectHackathonAdmission, readHackathon, type HackathonGrant } from "./lib/planner-hackathon";

// No env-file loader. The owner supplies a secret only over the private stdin pipe,
// after the exact running PID/nonce and grant pass credential-free inspection.
export type OwnerScope = {
  version: 1; mode: "diagnostic" | "h3"; canonicalRoot: string; id: string;
  project: string; model: string; operator: string; credentialReference: string;
  sourceDigest: string; buildId: string; manifestHash: string;
  maxHttpRequests: 6 | 12; expiresAt: number; stageScriptSha256: string; sourceInventorySha256: string;
};
export const OWNER_REFUSAL = "OWNER_RUNTIME_STOPPED: preserve records and any lock; no automatic retry. Secret content is never reported.";
const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const hash = /^[a-f0-9]{64}$/;
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const keys = ["version", "mode", "canonicalRoot", "id", "project", "model", "operator", "credentialReference",
  "sourceDigest", "buildId", "manifestHash", "maxHttpRequests", "expiresAt", "stageScriptSha256", "sourceInventorySha256"];
export function validateOwnerScope(scope: OwnerScope, root: string, now: number) {
  h2Assert(Object.keys(scope).sort().join() === [...keys].sort().join() && scope.version === 1 &&
    ["diagnostic", "h3"].includes(scope.mode) && path.resolve(scope.canonicalRoot) === path.resolve(root) &&
    uuid.test(scope.id) && scope.project === INITIAL_PROBE.project && scope.model === INITIAL_PROBE.model &&
    /^[a-zA-Z0-9._-]{1,100}$/.test(scope.operator) && /^[a-zA-Z0-9._-]{1,100}$/.test(scope.credentialReference) &&
    [scope.sourceDigest, scope.manifestHash, scope.stageScriptSha256, scope.sourceInventorySha256].every(h => hash.test(h)) &&
    /^[a-zA-Z0-9_-]{1,120}$/.test(scope.buildId) && scope.maxHttpRequests === (scope.mode === "diagnostic" ? 6 : 12) &&
    Number.isSafeInteger(scope.expiresAt) && scope.expiresAt > now);
}
async function noLock(directory: string) {
  try { await lstat(path.join(directory, "block.lock")); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error("Existing lock; reconcile first");
}
export async function inspectOwnerSubject(scope: OwnerScope, root: string) {
  validateOwnerScope(scope, root, Date.now());
  const state = scope.mode === "diagnostic" ? await readProbe(root, scope.id) : await readHackathon(root, scope.id, scope.project);
  const manifest = state.manifest;
  h2Assert(manifest.sourceDigest === scope.sourceDigest && manifest.buildId === scope.buildId && sha(manifest) === scope.manifestHash);
  const binding = "binding" in manifest ? manifest.binding : manifest;
  h2Assert(binding.project === scope.project && binding.model === scope.model &&
    binding.operator === scope.operator && binding.credentialReference === scope.credentialReference);
  const paths = scope.mode === "diagnostic" ? probePaths(root, scope.id) : campaignPaths(root, scope.id, scope.project);
  await noLock(paths.quota);
  return paths;
}
type Activation = { scopeSha256: string; grantSha256: string; pid: number; nonce: string; approved: true };
export function validateOwnerActivation(value: Activation, scopeHash: string, pid: number, nonce: string) {
  h2Assert(Object.keys(value).sort().join() === ["scopeSha256", "grantSha256", "pid", "nonce", "approved"].sort().join() &&
    hash.test(scopeHash) && hash.test(value.grantSha256) && value.scopeSha256 === scopeHash &&
    value.pid === pid && value.nonce === nonce && uuid.test(nonce) && value.approved === true);
}
export async function inspectOwnerInventory(root: string, bytes: Buffer, expectedHash: string) {
  h2Assert(digest(bytes) === expectedHash);
  const entries = JSON.parse(bytes.toString("utf8")) as Record<string, string>;
  h2Assert(entries && typeof entries === "object" && !Array.isArray(entries) &&
    entries["scripts/owner-planner-runtime.ts"] && entries["scripts/owner-planner-stage.ps1"]);
  for (const [name, expected] of Object.entries(entries)) {
    h2Assert(/^(?:(?:src|scripts|tests)\/(?!.*(?:^|\/)\.\.\/).+\.(?:ts|tsx|ps1)|package(?:-lock)?\.json|(?:tsconfig|vitest.config|playwright.config)\.(?:json|ts))$/.test(name) &&
      hash.test(expected));
    const file = contained(root, name), status = await lstat(file);
    h2Assert(status.isFile() && !status.isSymbolicLink() && digest(await readFile(file)) === expected);
  }
}
async function inspectGrant(scope: OwnerScope, root: string, grant: ProbeApproval | HackathonGrant,
  approvedHash: string, pid: number, nonce: string) {
  const paths = await inspectOwnerSubject(scope, root);
  h2Assert(sha(grant) === approvedHash && grant.manifestHash === scope.manifestHash && grant.windowEnd <= scope.expiresAt);
  if (scope.mode === "h3") {
    const value = grant as HackathonGrant;
    h2Assert(value.pid === pid && value.nonce === nonce && value.policy === H3.policy);
    const admission = await inspectHackathonAdmission(root, scope.id, scope.project, value, approvedHash, pid, safetyClock);
    h2Assert(admission.status === "READY");
    const c = await readRecord<Record<string, unknown>>(path.join(paths.evidence, "h3-activation.json"));
    h2Assert(Object.keys(c).sort().join() === ["approvalHash", "nonce", "pid", "exclusive", "unaccountedUse"].sort().join() &&
      c.approvalHash === approvedHash && c.nonce === nonce && c.pid === pid && c.exclusive === true && c.unaccountedUse === false);
  } else {
    const { manifest } = await readProbe(root, scope.id);
    const guard = await createProbePolicy(root, manifest, grant as ProbeApproval, new AbortController().signal);
    await guard.coordinated(); admitProbeRuntimeSettings(root, manifest, grant as ProbeApproval);
  }
  h2Assert((await new H2Journal(paths.quota).read()).at(-1)!.hash === grant.quotaHead);
}
async function setProfile(scope: OwnerScope, root: string, approvedHash: string) {
  const paths = scope.mode === "diagnostic" ? probePaths(root, scope.id) : campaignPaths(root, scope.id, scope.project);
  Object.assign(process.env, { APP_ENV: "local", STORAGE_MODE: "local", PAYMENTS_MODE: "simulation",
    AI_MODE: "gemini", FINANCIAL_ACTIONS_ENABLED: "false", PROVIDER_ACTIONS_ENABLED: "true",
    GEMINI_MODEL: scope.model, PANTRYPILOT_DATA_DIR: paths.data, AI_MAX_HTTP_REQUESTS: "3",
    AI_MAX_INPUT_BYTES: "32768", AI_MAX_OUTPUT_TOKENS: "1024", AI_TIMEOUT_MS: "300000" });
  if (scope.mode === "diagnostic") Object.assign(process.env, { RUN_INITIAL_GEMINI_PROBE: "true",
    PROBE_APPROVED_APPROVAL_SHA256: approvedHash, PROBE_OPERATOR: scope.operator, PROBE_CREDENTIAL_REFERENCE: scope.credentialReference });
  else {
    const { manifest: binding } = await readHackathon(root, scope.id, scope.project);
    Object.assign(process.env, { RUN_H3_EVAL: "true", H3_APPROVED_GRANT_SHA256: approvedHash,
      AI_MAX_HTTP_REQUESTS: String(binding.limits.maxHttpRequests), AI_MAX_INPUT_BYTES: String(binding.limits.maxInputBytes),
      AI_MAX_OUTPUT_TOKENS: String(binding.limits.maxOutputTokens), AI_TIMEOUT_MS: String(binding.limits.timeoutMs),
      EVAL_MAX_HTTP_REQUESTS: String(binding.session.maxHttpRequests),
      EVAL_OPERATOR: scope.operator, EVAL_CREDENTIAL_REFERENCE: scope.credentialReference });
  }
}
async function readPrivatePipe() {
  h2Assert(!process.stdin.isTTY);
  return new Promise<string>((resolve, reject) => {
    let value = "";
    const onData = (chunk: Buffer) => { value += chunk.toString("utf8");
      if (value.length > 258) { clean(); reject(new Error("Private input refused")); }
      else if (value.includes("\n")) { const key = value.replace(/\r?\n$/, ""); clean();
        if (/^[\x21-\x7e]{16,256}$/.test(key)) resolve(key); else reject(new Error("Private input refused")); }
    };
    const onEnd = () => { clean(); reject(new Error("Private input absent")); };
    const clean = () => { value = ""; process.stdin.off("data", onData); process.stdin.off("end", onEnd); process.stdin.pause(); };
    process.stdin.on("data", onData); process.stdin.once("end", onEnd); process.stdin.resume();
  });
}
export async function ownerRuntimeMain(args: string[]) {
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let phase = "PREFLIGHT", releaseDirectory: string | undefined, privateInputRead = false, dispatched = false;
  try {
    const [directory, scopeHash] = args, root = process.cwd();
    h2Assert(args.length === 2 && hash.test(scopeHash) &&
      path.resolve(root) === path.resolve(fileURLToPath(new URL("../", import.meta.url))));
    const release = path.resolve(directory), scopeBytes = await readFile(path.join(release, "scope.json"));
    h2Assert(digest(scopeBytes) === scopeHash);
    const scope = JSON.parse(scopeBytes.toString("utf8")) as OwnerScope;
    const inventoryBytes = await readFile(path.join(release, "source-inventory.json"));
    await inspectOwnerInventory(root, inventoryBytes, scope.sourceInventorySha256);
    const authority = await readRecord<{ scopeSha256: string; approved: boolean }>(path.join(release, "staging-authority.json"));
    h2Assert(Object.keys(authority).sort().join() === ["scopeSha256", "approved"].sort().join() &&
      authority.scopeSha256 === scopeHash && authority.approved === true && !process.env.GEMINI_API_KEY);
    await inspectOwnerSubject(scope, root);
    releaseDirectory = release;
    const nonce = randomUUID(), pid = process.pid, readyUntil = Math.min(Date.now() + 900000, scope.expiresAt);
    await writeOnce(path.join(release, "ready.json"), { scopeSha256: scopeHash, pid, nonce, readyUntil, credentialRead: false });
    phase = "WAITING_ACTIVATION";
    killTimer = setTimeout(() => process.exit(124), Math.max(1, readyUntil - Date.now()));
    for (;;) {
      h2Assert(Date.now() < readyUntil);
      let activation: Activation;
      try { activation = await readRecord<Activation>(path.join(release, "activation.json")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await new Promise(resolve => setTimeout(resolve, 100)); continue; }
      validateOwnerActivation(activation, scopeHash, pid, nonce);
      phase = "GRANT_INSPECTION";
      const grantFile = path.join(release, "runtime-grant.json");
      const grant = await readRecord<ProbeApproval | HackathonGrant>(grantFile);
      await setProfile(scope, root, activation.grantSha256);
      await inspectGrant(scope, root, grant, activation.grantSha256, pid, nonce);
      h2Assert(grant.windowEnd - Date.now() >= 10000);
      clearTimeout(killTimer);
      killTimer = setTimeout(() => process.exit(124), Math.max(1, grant.windowEnd - Date.now()));
      await writeOnce(path.join(release, "key-request.json"), { scopeSha256: scopeHash, grantSha256: activation.grantSha256,
        pid, nonce, windowEnd: grant.windowEnd });
      phase = "PRIVATE_INPUT";
      process.env.GEMINI_API_KEY = await readPrivatePipe();
      privateInputRead = true; phase = "POST_INPUT_INSPECTION";
      // Recheck all source/build/head/freshness identities after private input.
      await inspectGrant(scope, root, grant, activation.grantSha256, pid, nonce);
      await writeOnce(path.join(release, "dispatch-once.json"), { pid, nonce, grantSha256: activation.grantSha256 });
      dispatched = true; phase = "DISPATCH";
      let exit: number;
      if (scope.mode === "h3") {
        const { hackathonMain } = await import("./hackathon-eval");
        exit = await hackathonMain(["run-block", scope.id, scope.project, grantFile]);
      } else {
        const { aiProposal } = await import("../src/lib/ai");
        await runInitialProbe(root, scope.id, grant as ProbeApproval, (workspaceId, requestId, fixtureTime, shared, policy) =>
          aiProposal({ workspaceId, actorId: "owner-a", expiresAt: Date.now() + 100000, nonce: "initial-probe" },
            requestId, shared, { fixtureTime, transportPolicy: policy }));
        exit = 0;
      }
      phase = "RESULT";
      await writeOnce(path.join(release, "runtime-result.json"), { exit, qualification: "Requires saved evidence readback; exit alone is not acceptance" });
      return exit;
    }
  } catch {
    if (releaseDirectory) await writeOnce(path.join(releaseDirectory, "runtime-failed.json"),
      { status: "STOPPED_NO_RETRY", phase, privateInputRead, dispatched }).catch(() => {});
    console.log(OWNER_REFUSAL); return 1;
  }
  finally { if (killTimer) clearTimeout(killTimer); delete process.env.GEMINI_API_KEY; }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void ownerRuntimeMain(process.argv.slice(2)).then(code => { process.exitCode = code; });
}
