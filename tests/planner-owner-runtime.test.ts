import { SESSION_A1 } from "../scripts/lib/gemini-session-admission";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { inspectOwnerInventory, ownerRuntimeMain, validateOwnerActivation, validateOwnerScope, type OwnerScope } from "../scripts/owner-planner-runtime";
import { INITIAL_PROBE, initializeProbe, probePaths } from "../scripts/lib/planner-probe";
import { H2Journal, initializeQuota, pacificDay, sha } from "../scripts/lib/planner-quota";
import { H3, initializeHackathon, readHackathon } from "../scripts/lib/planner-hackathon";
import { campaignPaths } from "../scripts/lib/planner-campaign";
import { seedWorkspace } from "../src/lib/seed";

const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) {
    expect(path.dirname(root)).toBe(path.resolve(".data")); expect(path.basename(root)).toMatch(/^owner-host-offline-/);
    await rm(root, { recursive: true, force: true });
  }
});
function scope(root = process.cwd()): OwnerScope {
  return { version: 1, mode: "diagnostic", canonicalRoot: root, id: randomUUID(), project: INITIAL_PROBE.project,
    model: INITIAL_PROBE.model, operator: "offline-owner", credentialReference: "offline-no-key",
    sourceDigest: "a".repeat(64), buildId: "offline-build", manifestHash: "b".repeat(64),
    maxHttpRequests: 6, expiresAt: Date.now() + 60000, stageScriptSha256: "c".repeat(64), sourceInventorySha256: "d".repeat(64) };
}
it("admits only the fixed diagnostic or H3 request ceilings", () => {
  const s = scope(); expect(() => validateOwnerScope(s, process.cwd(), Date.now())).not.toThrow();
  expect(() => validateOwnerScope({ ...s, mode: "h3", maxHttpRequests: 12 }, process.cwd(), Date.now())).not.toThrow();
});
it.each([{ mode: "other" }, { maxHttpRequests: 20 }, { project: "another-project" }, { model: "another-model" },
  { canonicalRoot: "C:/some-other-root" }, { expiresAt: 1 }, { manifestHash: "missing" },
  { arbitraryExecutable: "cmd.exe" }, { sourceInventorySha256: "unbound" }])("scope refuses drift %j", (change) => {
  expect(() => validateOwnerScope({ ...scope(), ...change } as OwnerScope, process.cwd(), Date.now())).toThrow();
});
it.each(["pid", "nonce", "scopeSha256", "grantSha256", "approved", "unknown"])("activation refuses %s drift", key => {
  const nonce = randomUUID(), s = "a".repeat(64), valid = { scopeSha256: s, grantSha256: "b".repeat(64), pid: 100, nonce, approved: true as const };
  expect(() => validateOwnerActivation(valid, s, 100, nonce)).not.toThrow();
  expect(() => validateOwnerActivation({ ...valid, [key]: key === "pid" ? 101 : "wrong" }, s, 100, nonce)).toThrow();
});
it("invalid owner CLI arguments neither read private files nor request a provider", async () => {
  const fetch = vi.fn(() => { throw new Error("NO_EGRESS"); }); vi.stubGlobal("fetch", fetch);
  expect(await ownerRuntimeMain([])).toBe(1); expect(fetch).not.toHaveBeenCalled();
});

async function fixture() {
  await mkdir(path.resolve(".data"), { recursive: true });
  const root = await mkdtemp(path.resolve(".data/owner-host-offline-")); roots.push(root);
  for (const dir of ["src", "scripts"]) await cp(path.resolve(dir), path.join(root, dir), { recursive: true });
  for (const dir of ["tests", ".next", "release"]) await mkdir(path.join(root, dir));
  for (const file of ["package.json", "package-lock.json", "tsconfig.json", "vitest.config.ts", "playwright.config.ts"])
    await cp(path.resolve(file), path.join(root, file));
  await writeFile(path.join(root, ".next/BUILD_ID"), "offline-owner-host-build");
  const s = scope(root), paths = probePaths(root, s.id);
  await initializeQuota(paths.quota, { project: s.project, day: pacificDay(Date.now()), knownUsed: 0, evidenceReference: "offline-only" });
  const manifest = await initializeProbe(root, s.id, { canonicalRoot: root, project: s.project, model: s.model,
    operator: s.operator, credentialReference: s.credentialReference });
  s.sourceDigest = manifest.sourceDigest; s.buildId = manifest.buildId; s.manifestHash = sha(manifest);
  const inventory: Record<string, string> = {};
  async function visit(dir: string) {
    for (const entry of await readdir(path.join(root, dir), { withFileTypes: true })) {
      const name = dir + "/" + entry.name;
      if (entry.isDirectory()) await visit(name);
      else if (/\.(ts|tsx|ps1)$/.test(name)) inventory[name] = hash(await readFile(path.join(root, name)));
    }
  }
  await visit("src"); await visit("scripts");
  const inventoryBytes = Buffer.from(JSON.stringify(inventory)); s.sourceInventorySha256 = hash(inventoryBytes);
  s.stageScriptSha256 = inventory["scripts/owner-planner-stage.ps1"];
  const release = path.join(root, "release"), scopeBytes = JSON.stringify(s), scopeHash = hash(scopeBytes);
  await writeFile(path.join(release, "scope.json"), scopeBytes);
  await writeFile(path.join(release, "source-inventory.json"), inventoryBytes);
  await writeFile(path.join(release, "staging-authority.json"), JSON.stringify({ scopeSha256: scopeHash, approved: true }));
  return { root, release, s, scopeHash, paths, inventory, inventoryBytes, manifest };
}
it("inventory rejects private env paths, source mutation and an unbound inventory", async () => {
  const f = await fixture(); await expect(inspectOwnerInventory(f.root, f.inventoryBytes, f.s.sourceInventorySha256)).resolves.toBeUndefined();
  await expect(inspectOwnerInventory(f.root, f.inventoryBytes, "0".repeat(64))).rejects.toThrow();
  const privatePath = Buffer.from(JSON.stringify({ ...f.inventory, ".env.local": "0".repeat(64) }));
  await expect(inspectOwnerInventory(f.root, privatePath, hash(privatePath))).rejects.toThrow();
  await writeFile(path.join(f.root, "scripts/owner-planner-runtime.ts"), "// mutation\n");
  await expect(inspectOwnerInventory(f.root, f.inventoryBytes, f.s.sourceInventorySha256)).rejects.toThrow();
});
it("real no-key child binds its PID/nonce, refuses stale activation before input, and cannot replay readiness", async () => {
  const f = await fixture();
  const env: NodeJS.ProcessEnv = { NODE_ENV: "test" };
  for (const name of ["SystemRoot", "WINDIR", "COMSPEC", "PATH", "PATHEXT", "TEMP", "TMP", "NODE_OPTIONS", "PP_H2_EGRESS_LOG", "PP_H2_ALLOW_LOOPBACK"])
    if (process.env[name]) env[name] = process.env[name];
  const loader = pathToFileURL(path.resolve("node_modules/tsx/dist/loader.mjs")).href;
  async function run(release: () => Promise<void>) {
    const child = spawn(process.execPath, ["--import", loader, "scripts/owner-planner-runtime.ts", f.release, f.scopeHash],
      { cwd: f.root, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let output = ""; child.stdout.on("data", b => { output += b; }); child.stderr.on("data", b => { output += b; });
    const exited = new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
    const timeout = setTimeout(() => child.kill(), 10000);
    try { await release(); const code = await exited; return { code, output, pid: child.pid }; }
    finally { clearTimeout(timeout); child.kill(); }
  }
  let ready: { pid: number; nonce: string; credentialRead: boolean };
  const first = await run(async () => {
    for (let i = 0; i < 80; i++) {
      try { ready = JSON.parse(await readFile(path.join(f.release, "ready.json"), "utf8")); break; }
      catch { await new Promise(r => setTimeout(r, 50)); }
    }
    expect(ready!.credentialRead).toBe(false);
    const now = Date.now(), grant = { manifestHash: f.s.manifestHash,
      quotaHead: (await new H2Journal(f.paths.quota).read()).at(-1)!.hash, day: pacificDay(now),
      quietSince: now - 901000, usageObservedAt: now - 1000, windowStart: now - 1000, windowEnd: now - 1,
      knownPriorHttp: 0, laterExternalReservedHttp: 0, usageReference: "offline-stale" };
    await writeFile(path.join(f.release, "runtime-grant.json"), JSON.stringify(grant));
    await writeFile(path.join(f.paths.evidence, "coordination.json"), JSON.stringify({ approvalHash: sha(grant), exclusive: true, unaccountedUse: false }));
    await writeFile(path.join(f.release, "activation.json"), JSON.stringify({ scopeSha256: f.scopeHash, grantSha256: sha(grant),
      pid: ready!.pid, nonce: ready!.nonce, approved: true }));
  });
  expect(first.pid).toBe(ready!.pid); expect(first.code).toBe(1); expect(first.output).toContain("OWNER_RUNTIME_STOPPED");
  await expect(readFile(path.join(f.release, "key-request.json"))).rejects.toThrow();
  await expect(readFile(path.join(f.release, "dispatch-once.json"))).rejects.toThrow();
  expect((await new H2Journal(f.paths.quota).read())).toHaveLength(1);
  const second = await run(async () => {}); expect(second.code).toBe(1);
  expect(JSON.parse(await readFile(path.join(f.release, "ready.json"), "utf8"))).toEqual(ready!);
}, 15000);

it("owner PowerShell inspection validates pinned files without a prompt or process", async () => {
  const f = await fixture();
  const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", path.join(f.root, "scripts/owner-planner-stage.ps1"),
      "-ReleaseDirectory", f.release, "-ExpectedScopeSha256", f.scopeHash, "-InspectOnly"],
    { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let output = ""; child.stdin.end(); child.stdout.on("data", b => { output += b; }); child.stderr.on("data", b => { output += b; });
    const timer = setTimeout(() => child.kill(), 10000);
    child.on("error", reject); child.on("close", code => { clearTimeout(timer); resolve({ code, output }); });
  });
  expect(result.code, result.output).toBe(0); expect(result.output.trim()).toBe("INSPECT_PASS_NO_KEY_NO_PROCESS");
  await expect(readFile(path.join(f.release, "staging-attempt.json"))).rejects.toThrow();
  await expect(readFile(path.join(f.release, "ready.json"))).rejects.toThrow();
});

it.each([["diagnostic", false], ["h3", false], ["diagnostic", true], ["h3", true]] as const)(
  "owner runtime completes the actual%s planner with A1=%s and a fake private pipe", async (mode, useSession) => {
  const f = await fixture();
  if (mode === "h3") {
    const id = randomUUID(), limits = { maxHttpRequests: 6, maxInputBytes: 32768, maxOutputTokens: 1024, timeoutMs: 300000 };
    const manifest = await initializeHackathon(f.root, id, { model: f.s.model, project: f.s.project,
      credentialReference: f.s.credentialReference, operator: f.s.operator, limits, session: { ...limits, maxHttpRequests: 20 } }, seedWorkspace(randomUUID()));
    Object.assign(f.s, { id, mode, maxHttpRequests: 12, sourceDigest: manifest.sourceDigest, buildId: manifest.buildId, manifestHash: sha(manifest) });
    const bytes = JSON.stringify(f.s); f.scopeHash = hash(bytes);
    await writeFile(path.join(f.release, "scope.json"), bytes);
    await writeFile(path.join(f.release, "staging-authority.json"), JSON.stringify({ scopeSha256: f.scopeHash, approved: true }));
  }
  const runtimePaths = mode === "diagnostic" ? f.paths : campaignPaths(f.root, f.s.id, f.s.project);
  if (useSession) {
    const now = Date.now(), plan = { policy: SESSION_A1.id, day: pacificDay(now), knownPriorHttp: 1,
      laterExternalReservedHttp: 0, usageObservedAt: now - 120000, usageReference: "offline-partial-ui",
      evidenceBasis: "OWNER_ATTESTED_PARTIAL_UI", quotaHead: (await new H2Journal(runtimePaths.quota).read()).at(-1)!.hash,
      manifestHash: f.s.manifestHash, sourceDigest: f.s.sourceDigest, buildId: f.s.buildId,
      maxHttpRequests: f.s.maxHttpRequests, expiresAt: f.s.expiresAt };
    const bytes = JSON.stringify(plan); f.s.session = { policy: SESSION_A1.id, planSha256: hash(bytes) };
    await writeFile(path.join(f.release, "session-plan.json"), bytes);
    const scopeBytes = JSON.stringify(f.s); f.scopeHash = hash(scopeBytes);
    await writeFile(path.join(f.release, "scope.json"), scopeBytes);
    await writeFile(path.join(f.release, "staging-authority.json"), JSON.stringify({ scopeSha256: f.scopeHash, approved: true }));
    await writeFile(path.join(f.release, "owner-ready.json"), JSON.stringify({ scopeSha256: f.scopeHash,
      planSha256: f.s.session.planSha256, atMs: now, day: plan.day, knownPriorHttp: 1,
      exclusive: true, completeHistoryConfirmed: true }));
    await expect(readFile(path.join(f.release, "activation.json"))).rejects.toThrow();
  }
  const workspace = JSON.parse(await readFile(path.join(f.paths.data, f.manifest.cases[1].workspaceId + ".json"), "utf8"));
  const selection = { catalogIds: mode === "h3" ? [] : workspace.catalog.map((item: { id: string }) => item.id),
    reasoning: "offline-synthetic", infeasible: mode === "h3" };
  const intercept = path.join(f.release, "offline-fetch.cjs");
  // No sockets: this intercept replaces fetch before the app or SDK loads.
  await writeFile(intercept, `global.fetch=async(input)=>String(input).endsWith(':countTokens')?Response.json({totalTokens:2}):Response.json({candidates:[{content:{role:'model',parts:[{text:${JSON.stringify(JSON.stringify(selection))}}]},finishReason:'STOP'}],usageMetadata:{promptTokenCount:3,candidatesTokenCount:1,totalTokenCount:4}});`);
  const env: NodeJS.ProcessEnv = { NODE_ENV: "test" };
  for (const name of ["SystemRoot", "WINDIR", "COMSPEC", "PATH", "PATHEXT", "TEMP", "TMP", "PP_H2_EGRESS_LOG", "PP_H2_ALLOW_LOOPBACK"])
    if (process.env[name]) env[name] = process.env[name];
  env.NODE_OPTIONS = process.env.NODE_OPTIONS;
  // The outer egress guard deliberately overwrites child NODE_OPTIONS. Install
  // the local fetch fixture via a CLI preload; socket/DNS/TLS denials stay active.
  const child = spawn(process.execPath, ["--require", intercept, "--import", pathToFileURL(path.resolve("node_modules/tsx/dist/loader.mjs")).href,
    "scripts/owner-planner-runtime.ts", f.release, f.scopeHash], { cwd: f.root, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let output = ""; child.stdout.on("data", b => { output += b; }); child.stderr.on("data", b => { output += b; });
  const exited = new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
  const timeout = setTimeout(() => child.kill(), 10000);
  async function waitJson(name: string) {
    for (let i = 0; i < 100; i++) {
      try { return JSON.parse(await readFile(path.join(f.release, name), "utf8")); }
      catch { await new Promise(r => setTimeout(r, 50)); }
    }
    throw new Error("Offline child missing " + name + ": " + output);
  }
  try {
    const ready = await waitJson("ready.json"), now = Date.now();
    if (!useSession) {
    const common = { manifestHash: f.s.manifestHash, quotaHead: (await new H2Journal(runtimePaths.quota).read()).at(-1)!.hash,
      day: pacificDay(now), quietSince: now - 901000, usageObservedAt: now - 1000,
      windowStart: now, windowEnd: Math.min(now + 30000, f.s.expiresAt), knownPriorHttp: 0,
      laterExternalReservedHttp: 0, usageReference: "offline-observation" };
    const grant = mode === "diagnostic" ? common : { policy: H3.policy, scope: "H3_SINGLE_CASE", canonicalRoot: f.root,
      campaignId: f.s.id, caseId: 1, sourceDigest: f.s.sourceDigest, buildId: f.s.buildId,
      configDigest: (await readHackathon(f.root, f.s.id, f.s.project)).manifest.configDigest,
      project: f.s.project, model: f.s.model, operator: f.s.operator, credentialReference: f.s.credentialReference,
      ...common, nonce: ready.nonce, pid: ready.pid, maxHttpRequests: 12 };
    await writeFile(path.join(f.release, "runtime-grant.json"), JSON.stringify(grant));
    await writeFile(path.join(runtimePaths.evidence, mode === "diagnostic" ? "coordination.json" : "h3-activation.json"),
      JSON.stringify({ approvalHash: sha(grant), ...(mode === "h3" ? { nonce: ready.nonce, pid: ready.pid } : {}), exclusive: true, unaccountedUse: false }));
    await writeFile(path.join(f.release, "activation.json"), JSON.stringify({ scopeSha256: f.scopeHash, grantSha256: sha(grant),
      pid: ready.pid, nonce: ready.nonce, approved: true }));
    }
    const request = await waitJson("key-request.json"); expect(request.pid).toBe(child.pid);
    if (useSession) {
      const grant = JSON.parse(await readFile(path.join(f.release, "runtime-grant.json"), "utf8"));
      expect(grant.sessionPolicy).toBe(SESSION_A1.id); expect(grant.usageObservedAt).toBeLessThan(now - 60000);
      expect(grant.ownerAttestedAt).toBeGreaterThan(grant.usageObservedAt);
    }
    child.stdin.end("OFFLINE_ONLY_FAKE_PRIVATE_SENTINEL\n");
    const exit = await exited;
    const diagnostics = await Promise.all([path.join(f.release, "runtime-failed.json"), path.join(runtimePaths.evidence, "failed.json")]
      .map(file => readFile(file, "utf8").catch(() => "absent")));
    expect(exit, output + JSON.stringify(diagnostics)).toBe(0); expect(output).not.toContain("OFFLINE_ONLY_FAKE_PRIVATE_SENTINEL");
    if (mode === "diagnostic") {
      const receipt = JSON.parse(await readFile(path.join(runtimePaths.evidence, "receipt.json"), "utf8"));
      expect(receipt.status).toBe("INITIAL_FEASIBILITY_OBSERVED"); expect(receipt.fullCampaignAccepted).toBe(false);
      expect(receipt.countCalls).toBe(1); expect(receipt.generationCalls).toBe(1);
    } else {
      const state = await readHackathon(f.root, f.s.id, f.s.project);
      expect(state.outcomes).toHaveLength(1); expect(state.outcomes[0].row.status).toBe("PASS");
      expect(state.outcomes[0].row.source).toBe("gemini"); expect(output).toContain('"COMPLETED"');
    }
    const records = JSON.stringify(await new H2Journal(runtimePaths.quota).read());
    if (useSession) {
      const external = (await new H2Journal(runtimePaths.quota).read()).filter(e => e.value.kind === "h3-external-accounting");
      expect(external).toHaveLength(1); expect(external[0].value.http).toBe(1);
    }
    expect(records).not.toContain("OFFLINE_ONLY_FAKE_PRIVATE_SENTINEL");
    await expect(readFile(path.join(runtimePaths.quota, "block.lock"))).rejects.toThrow();
    expect(JSON.parse(await readFile(path.join(f.release, "runtime-result.json"), "utf8")).exit).toBe(0);
  } finally { clearTimeout(timeout); child.kill(); await exited; }
}, 15000);

it("A1 adds one hash-bound plan to an otherwise exact owner scope", () => {
  const s = scope(); s.session = { policy: SESSION_A1.id, planSha256: "e".repeat(64) };
  expect(() => validateOwnerScope(s, process.cwd(), Date.now())).not.toThrow();
  expect(() => validateOwnerScope({ ...s, session: { policy: "UNKNOWN", planSha256: "e".repeat(64) } } as unknown as OwnerScope,
    process.cwd(), Date.now())).toThrow();
  expect(() => validateOwnerScope({ ...s, session: { ...s.session!, planSha256: "" } }, process.cwd(), Date.now())).toThrow();
});

it.each(["source", "head"])("A1 post-input%s drift refuses dispatch and cannot replay", async drift => {
  const f = await fixture(), now = Date.now();
  const plan = { policy: SESSION_A1.id, day: pacificDay(now), knownPriorHttp: 0, laterExternalReservedHttp: 0,
    usageObservedAt: now - 120000, usageReference: "offline-partial-ui", evidenceBasis: "OWNER_ATTESTED_PARTIAL_UI",
    quotaHead: (await new H2Journal(f.paths.quota).read()).at(-1)!.hash, manifestHash: f.s.manifestHash,
    sourceDigest: f.s.sourceDigest, buildId: f.s.buildId, maxHttpRequests: 6, expiresAt: f.s.expiresAt };
  const bytes = JSON.stringify(plan); f.s.session = { policy: SESSION_A1.id, planSha256: hash(bytes) };
  await writeFile(path.join(f.release, "session-plan.json"), bytes);
  const scopeBytes = JSON.stringify(f.s); f.scopeHash = hash(scopeBytes);
  await writeFile(path.join(f.release, "scope.json"), scopeBytes);
  await writeFile(path.join(f.release, "staging-authority.json"), JSON.stringify({ scopeSha256: f.scopeHash, approved: true }));
  await writeFile(path.join(f.release, "owner-ready.json"), JSON.stringify({ scopeSha256: f.scopeHash,
    planSha256: f.s.session.planSha256, atMs: now, day: plan.day, knownPriorHttp: 0,
    exclusive: true, completeHistoryConfirmed: true }));
  const marker = path.join(f.release, "unexpected-egress.jsonl"), intercept = path.join(f.release, "offline-fetch.cjs");
  await writeFile(intercept, `global.fetch=async()=>{require('node:fs').appendFileSync(${JSON.stringify(marker)},'unexpected');throw new Error('UNEXPECTED_OFFLINE_TRANSPORT')}`);
  const env: NodeJS.ProcessEnv = { NODE_ENV: "test" };
  for (const name of ["SystemRoot", "WINDIR", "COMSPEC", "PATH", "PATHEXT", "TEMP", "TMP", "NODE_OPTIONS", "PP_H2_EGRESS_LOG", "PP_H2_ALLOW_LOOPBACK"])
    if (process.env[name]) env[name] = process.env[name];
  const child = spawn(process.execPath, ["--require", intercept, "--import", pathToFileURL(path.resolve("node_modules/tsx/dist/loader.mjs")).href,
    "scripts/owner-planner-runtime.ts", f.release, f.scopeHash], { cwd: f.root, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let output = ""; child.stdout.on("data", b => { output += b; }); child.stderr.on("data", b => { output += b; });
  const exited = new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
  const timer = setTimeout(() => child.kill(), 10000);
  try {
    let requested = false;
    for (let i = 0; i < 100; i++) {
      try { await readFile(path.join(f.release, "key-request.json")); requested = true; break; }
      catch { await new Promise(r => setTimeout(r, 50)); }
    }
    expect(requested, output).toBe(true);
    if (drift === "source") await writeFile(path.join(f.root, "scripts/lib/gemini-session-admission.ts"), "// offline source drift\n");
    else await new H2Journal(f.paths.quota).append({ kind: "h3-external-accounting", http: 1,
      day: plan.day, at: Date.now(), usageReference: "offline-head-drift" });
    child.stdin.end("OFFLINE_ONLY_FAKE_PRIVATE_SENTINEL\n");
    expect(await exited, output).toBe(1);
    const failedBytes = await readFile(path.join(f.release, "runtime-failed.json"));
    const failed = JSON.parse(failedBytes.toString("utf8"));
    expect(failed.phase).toBe("POST_INPUT_INSPECTION"); expect(failed.privateInputRead).toBe(true); expect(failed.dispatched).toBe(false);
    await expect(readFile(path.join(f.release, "dispatch-once.json"))).rejects.toThrow();
    await expect(readFile(marker)).rejects.toThrow();
    const status = JSON.parse(await readFile(path.join(f.release, "session-status.json"), "utf8"));
    expect(status.status).toBe("STOPPED"); expect(status.chargedGenerationAttempts).toBe(0);
    expect(output).not.toContain("OFFLINE_ONLY_FAKE_PRIVATE_SENTINEL");
    const replay = spawn(process.execPath, ["--require", intercept, "--import", pathToFileURL(path.resolve("node_modules/tsx/dist/loader.mjs")).href,
      "scripts/owner-planner-runtime.ts", f.release, f.scopeHash], { cwd: f.root, env, windowsHide: true, stdio: ["ignore", "ignore", "ignore"] });
    const replayExit = new Promise<number | null>((resolve, reject) => { replay.on("error", reject); replay.on("close", resolve); });
    const replayTimer = setTimeout(() => replay.kill(), 10000);
    try { expect(await replayExit).toBe(1); } finally { clearTimeout(replayTimer); replay.kill(); }
    expect(await readFile(path.join(f.release, "runtime-failed.json"))).toEqual(failedBytes);
    await expect(readFile(marker)).rejects.toThrow();
  } finally { clearTimeout(timer); child.kill(); }
});

it("A1 PowerShell preflight validates the plan without staging, private input or provider process", async () => {
  const f = await fixture(), now = Date.now();
  const plan = { policy: SESSION_A1.id, day: pacificDay(now), knownPriorHttp: 0, laterExternalReservedHttp: 0,
    usageObservedAt: now - 120000, usageReference: "offline-partial-ui", evidenceBasis: "OWNER_ATTESTED_PARTIAL_UI",
    quotaHead: (await new H2Journal(f.paths.quota).read()).at(-1)!.hash, manifestHash: f.s.manifestHash,
    sourceDigest: f.s.sourceDigest, buildId: f.s.buildId, maxHttpRequests: 6, expiresAt: f.s.expiresAt };
  const bytes = JSON.stringify(plan); f.s.session = { policy: SESSION_A1.id, planSha256: hash(bytes) };
  await writeFile(path.join(f.release, "session-plan.json"), bytes);
  const scopeBytes = JSON.stringify(f.s); f.scopeHash = hash(scopeBytes);
  await writeFile(path.join(f.release, "scope.json"), scopeBytes);
  await writeFile(path.join(f.release, "staging-authority.json"), JSON.stringify({ scopeSha256: f.scopeHash, approved: true }));
  const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", path.join(f.root, "scripts/owner-planner-stage.ps1"),
      "-ReleaseDirectory", f.release, "-ExpectedScopeSha256", f.scopeHash, "-InspectOnly"],
    { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let output = ""; child.stdin.end(); child.stdout.on("data", b => { output += b; }); child.stderr.on("data", b => { output += b; });
    const timer = setTimeout(() => child.kill(), 10000);
    child.on("error", e => { clearTimeout(timer); reject(e); });
    child.on("close", code => { clearTimeout(timer); resolve({ code, output }); });
  });
  expect(result.code, result.output).toBe(0); expect(result.output).toContain("INSPECT_PASS_NO_KEY_NO_PROVIDER_PROCESS");
  for (const name of ["owner-ready.json", "staging-attempt.json", "ready.json", "key-request.json", "dispatch-once.json"])
    await expect(readFile(path.join(f.release, name))).rejects.toThrow();
  expect(await new H2Journal(f.paths.quota).read()).toHaveLength(1);
});
