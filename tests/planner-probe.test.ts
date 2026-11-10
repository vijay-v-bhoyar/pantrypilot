import { SESSION_A1 } from "../scripts/lib/gemini-session-admission";
import { auditSessionProbeQuota, auditH3Quota } from "../scripts/lib/planner-quota";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { generateText, stepCountIs, tool } from "ai";
import { z } from "zod";
import { aiProposal } from "../src/lib/ai";
import type { Workspace } from "../src/lib/types";
import { budgetedModelFetch, createModelBudget } from "../src/lib/model-budget";
import { H2Journal, initializeQuota, pacificDay, sha, withProjectLock, type SafetyClock } from "../scripts/lib/planner-quota";
import { financialSnapshot, plannerCases, plannerVerdict } from "../scripts/lib/planner-evaluation";
import { INITIAL_PROBE, admitProbeRuntime, createProbePolicy, initializeProbe, probeLimits, probePaths,
  readProbe, runInitialProbe, validateProbeApproval, type ProbeApproval, type ProbeManifest } from "../scripts/lib/planner-probe";

const roots: string[] = [];
beforeEach(() => { vi.stubGlobal("fetch", vi.fn(() => { throw new Error("UNEXPECTED_EGRESS"); })); });
afterEach(async () => {
  vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers();
  for (const root of roots.splice(0)) {
    expect(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)).toBe(true);
    expect(path.basename(root).startsWith("pantrypilot-initial-probe-")).toBe(true);
    await rm(root, { recursive: true, force: true });
  }
});
async function fixture(knownPriorHttp = 0) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pantrypilot-initial-probe-")); roots.push(root);
  const id = randomUUID(), paths = probePaths(root, id);
  let now = Date.UTC(2026, 9, 30, 16), elapsed = 0;
  const clock: SafetyClock = { now: () => now, monotonic: () => elapsed,
    sleep: async (ms, signal) => { signal.throwIfAborted(); now += ms; elapsed += ms; } };
  const advance = (ms: number) => { now += ms; elapsed += Math.max(0, ms); };
  await initializeQuota(paths.quota, { project: INITIAL_PROBE.project, day: pacificDay(now),
    knownUsed: knownPriorHttp, evidenceReference: "offline-synthetic" });
  await mkdir(paths.evidence, { recursive: true });
  const manifest: ProbeManifest = { version: 1, id, policy: INITIAL_PROBE,
    binding: { canonicalRoot: root, project: INITIAL_PROBE.project, model: INITIAL_PROBE.model,
      credentialReference: "offline-reference", operator: "offline-operator" },
    fixtureTime: now, allCasesDigest: sha(plannerCases(now)), sourceDigest: "0".repeat(64), buildId: "offline-build", cases: [] };
  const approval: ProbeApproval = { manifestHash: sha(manifest), day: pacificDay(now),
    quotaHead: (await new H2Journal(paths.quota).read()).at(-1)!.hash,
    quietSince: now - 901000, usageObservedAt: now - 1000, windowStart: now, windowEnd: now + 300000,
    knownPriorHttp, laterExternalReservedHttp: 0, usageReference: "offline-usage" };
  const coordination = (exclusive = true, unaccountedUse = false, approvalHash = sha(approval)) =>
    writeFile(path.join(paths.evidence, "coordination.json"), JSON.stringify({ approvalHash, exclusive, unaccountedUse }));
  await coordination();
  const control = new AbortController();
  const transport = vi.fn<typeof fetch>().mockImplementation(async (input) => {
    const url = String(input), base = `https://generativelanguage.googleapis.com/v1beta/models/${INITIAL_PROBE.model}`;
    if (url === base + ":countTokens") return Response.json({ totalTokens: 2 });
    if (url === base + ":generateContent") return Response.json({ usageMetadata: { promptTokenCount: 3 } });
    throw new Error("UNEXPECTED_EGRESS");
  });
  const make = () => createProbePolicy(root, manifest, approval, control.signal, clock, transport);
  const request = (policy: Awaited<ReturnType<typeof make>>["policy"]) => {
    const budget = createModelBudget({ ...probeLimits, maxHttpRequests: 10 });
    const fetcher = budgetedModelFetch(INITIAL_PROBE.model, budget, control.signal, undefined, transport, policy);
    return fetcher(`https://generativelanguage.googleapis.com/v1beta/models/${INITIAL_PROBE.model}:generateContent`,
      { method: "POST", headers: { "x-goog-api-key": "FAKE_PRIVATE_SENTINEL" },
        body: JSON.stringify({ contents: [{ parts: [{ text: "private-synthetic-prompt" }] }],
          generationConfig: { maxOutputTokens: 1024 } }) });
  };
  return { root, id, paths, manifest, approval, clock, advance, coordination, control, transport, make, request };
}
it("P01 stops at three paired calls and cannot gain allowance under a new policy instance", async () => {
  const f = await fixture();
  await withProjectLock(f.paths.quota, async () => {
    const guard = await f.make(); for (let i = 0; i < 3; i++) await f.request(guard.policy);
    await expect(f.request(guard.policy)).rejects.toThrow();
    await expect(f.make()).rejects.toThrow();
  });
  expect(f.transport).toHaveBeenCalledTimes(6);
  expect(globalThis.fetch).not.toHaveBeenCalled();
});
it.each([15, 19, 20])("P02 refuses insufficient combined capacity with %s prior requests", async (used) => {
  const f = await fixture(used); await expect(f.make()).rejects.toThrow(); expect(f.transport).not.toHaveBeenCalled();
});
it("P02 accounts for later external reservations and accepts the exact 20-request boundary", async () => {
  const f = await fixture(12); f.approval.laterExternalReservedHttp = 2; await f.coordination();
  expect(() => validateProbeApproval(f.manifest, f.approval, f.clock)).not.toThrow();
  f.approval.laterExternalReservedHttp = 3;
  expect(() => validateProbeApproval(f.manifest, f.approval, f.clock)).toThrow();
});
it.each([
  { knownPriorHttp: -1 }, { knownPriorHttp: 0.5 }, { knownPriorHttp: NaN },
  { laterExternalReservedHttp: -1 }, { manifestHash: "0".repeat(64) }, { quotaHead: "unknown" },
  { quietSince: Date.UTC(2026, 9, 30, 16) - 300000 },
  { usageObservedAt: Date.UTC(2026, 9, 30, 16) - 60001 },
  { windowStart: Date.UTC(2026, 9, 30, 16) + 1 },
  { windowEnd: Date.UTC(2026, 9, 30, 16) }, { day: "2026-10-31" },
])("P03 refuses stale/unknown/invalid approval %j", async (change) => {
  const f = await fixture(); Object.assign(f.approval, change);
  await expect(f.make()).rejects.toThrow(); expect(f.transport).not.toHaveBeenCalled();
});
it("P04 binds the current ledger head and refuses understated prior use", async () => {
  const f = await fixture(4); f.approval.knownPriorHttp = 3; await expect(f.make()).rejects.toThrow();
  f.approval.knownPriorHttp = 4;
  await new H2Journal(f.paths.quota).append({ kind: "outside-review-marker" });
  await expect(f.make()).rejects.toThrow(); expect(f.transport).not.toHaveBeenCalled();
});
it("P04 refuses a late start after the usage reading exceeds one minute", async () => {
  const f = await fixture(); f.advance(60001);
  await expect(f.make()).rejects.toThrow(); expect(f.transport).not.toHaveBeenCalled();
});
it.each(["lost-exclusivity", "unaccounted-use", "approval-drift"])("P05 checks coordination before generation: %s", async (reason) => {
  const f = await fixture();
  f.transport.mockImplementationOnce(async () => {
    await f.coordination(reason !== "lost-exclusivity", reason === "unaccounted-use",
      reason === "approval-drift" ? "0".repeat(64) : sha(f.approval));
    return Response.json({ totalTokens: 2 });
  });
  await withProjectLock(f.paths.quota, async () => {
    const guard = await f.make(); await expect(f.request(guard.policy)).rejects.toThrow();
  });
  expect(f.transport).toHaveBeenCalledTimes(1);
  expect((await new H2Journal(f.paths.quota).read()).some((entry) => entry.value.kind === "poison")).toBe(true);
});
it.each(["expiry", "clock-rollback", "abort"])("P06 refuses dispatch after %s", async (reason) => {
  const f = await fixture(), guard = await f.make();
  if (reason === "abort") f.control.abort(); else f.advance(reason === "expiry" ? 300000 : -1);
  await expect(f.request(guard.policy)).rejects.toThrow(); expect(f.transport).not.toHaveBeenCalled();
});
it("P07 rejects a window crossing Pacific midnight", async () => {
  const f = await fixture(), start = Date.UTC(2026, 9, 31, 6, 59);
  Object.assign(f.approval, { windowStart: start, windowEnd: start + 120000,
    usageObservedAt: start - 1000, quietSince: start - 901000, day: pacificDay(start) });
  expect(() => validateProbeApproval(f.manifest, f.approval, { ...f.clock, now: () => start })).toThrow();
});
it("P08 installed SDK continuation exhausts the three-generation cap without retries", async () => {
  const f = await fixture(); f.transport.mockImplementation(async (input) => String(input).endsWith(":countTokens") ?
    Response.json({ totalTokens: 2 }) : Response.json({ candidates: [{ content: { role: "model", parts: [
      { functionCall: { name: "read", args: {} } } ] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1, totalTokenCount: 4 } }));
  await withProjectLock(f.paths.quota, async () => {
    const guard = await f.make(), budget = createModelBudget(probeLimits);
    const model = createGoogleGenerativeAI({ apiKey: "FAKE_PRIVATE_SENTINEL",
      fetch: budgetedModelFetch(INITIAL_PROBE.model, budget, f.control.signal, undefined, f.transport, guard.policy) })(INITIAL_PROBE.model);
    await expect(generateText({ model, prompt: "synthetic", maxOutputTokens: 1024, maxRetries: 0,
      tools: { read: tool({ inputSchema: z.object({}), execute: async () => ({ synthetic: true }) }) },
      stopWhen: stepCountIs(6) })).rejects.toThrow();
    expect(budget.attempts).toBe(3);
  });
  expect(f.transport).toHaveBeenCalledTimes(6);
});
it.each(["timeout", "over-count", "missing-usage", "redirect"])("P09 preserves poison/lock on %s without replay", async (reason) => {
  const f = await fixture();
  if (reason === "timeout") f.transport.mockRejectedValue(new Error("FAKE_PRIVATE_SENTINEL"));
  if (reason === "over-count") f.transport.mockResolvedValue(Response.json({ totalTokens: 50001 }));
  if (reason === "missing-usage") f.transport.mockImplementation(async (input) => String(input).endsWith(":countTokens") ?
    Response.json({ totalTokens: 2 }) : Response.json({}));
  if (reason === "redirect") f.transport.mockResolvedValue(new Response(null, { status: 302, headers: { location: "https://example.invalid" } }));
  await expect(withProjectLock(f.paths.quota, async () => { const guard = await f.make(); await f.request(guard.policy); })).rejects.toThrow();
  await expect(readFile(path.join(f.paths.quota, "block.lock"))).resolves.toBeDefined();
  const attempted = f.transport.mock.calls.length;
  await expect(f.make()).rejects.toThrow(); expect(f.transport).toHaveBeenCalledTimes(attempted);
  const text = JSON.stringify(await new H2Journal(f.paths.quota).read());
  expect(text).toContain('"kind":"poison"'); expect(text).not.toContain("FAKE_PRIVATE_SENTINEL");
});
it("P10 rejects a second owner of the canonical project lock", async () => {
  const f = await fixture();
  await withProjectLock(f.paths.quota, async () => {
    await expect(withProjectLock(f.paths.quota, async () => { throw new Error("must not enter"); })).rejects.toThrow();
  });
  expect(f.transport).not.toHaveBeenCalled();
});
it("P11 refuses concurrent dispatch and the in-flight continuation", async () => {
  const f = await fixture(), guard = await f.make();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let reached!: () => void;
  const started = new Promise<void>((resolve) => { reached = resolve; });
  f.transport.mockImplementationOnce(async () => { reached(); await gate; return Response.json({ totalTokens: 2 }); });
  const first = f.request(guard.policy).catch(() => "STOPPED"); await started;
  await expect(f.request(guard.policy)).rejects.toThrow(); release(); expect(await first).toBe("STOPPED");
  expect(f.transport).toHaveBeenCalledTimes(1);
});
it("P12 keeps sanitized journal metadata separate from private bodies and headers", async () => {
  const f = await fixture(), guard = await f.make(); await f.request(guard.policy);
  const text = JSON.stringify(await new H2Journal(f.paths.quota).read());
  expect(text).not.toContain("FAKE_PRIVATE_SENTINEL"); expect(text).not.toContain("private-synthetic-prompt");
  expect(text).not.toContain("x-goog-api-key");
});
async function initializedFixture() {
  const f = await fixture();
  // Replace the policy-only evidence directory with a new id; preserve its shared quota journal.
  const id = randomUUID();
  for (const directory of ["src", "scripts", "tests", ".next"]) await mkdir(path.join(f.root, directory), { recursive: true });
  for (const filename of ["package.json", "package-lock.json", "tsconfig.json", "vitest.config.ts", "playwright.config.ts"])
    await writeFile(path.join(f.root, filename), "offline synthetic source identity\n");
  await writeFile(path.join(f.root, ".next", "BUILD_ID"), "offline-build");
  const manifest = await initializeProbe(f.root, id, f.manifest.binding);
  const paths = probePaths(f.root, id), now = Date.now();
  const clock: SafetyClock = { now: () => now, monotonic: () => 0, sleep: async () => {} };
  const approval = { ...f.approval, manifestHash: sha(manifest), day: pacificDay(now),
    quietSince: now - 901000, usageObservedAt: now - 1000, windowStart: now, windowEnd: now + 300000 };
  await writeFile(path.join(paths.evidence, "coordination.json"), JSON.stringify({ approvalHash: sha(approval), exclusive: true, unaccountedUse: false }));
  return { ...f, id, manifest, paths, approval, clock };
}
async function fakePlannerRuntime(f: Awaited<ReturnType<typeof initializedFixture>>, catalogIds?: string[]) {
  const initial = await readProbe(f.root, f.id);
  for (const [name, value] of Object.entries({ APP_ENV: "local", STORAGE_MODE: "local", PAYMENTS_MODE: "simulation",
    FINANCIAL_ACTIONS_ENABLED: "false", PROVIDER_ACTIONS_ENABLED: "true", AI_MODE: "gemini", VERCEL: "",
    GEMINI_API_KEY: "FAKE_PRIVATE_SENTINEL", GEMINI_MODEL: INITIAL_PROBE.model,
    AI_MAX_HTTP_REQUESTS: "3", AI_MAX_INPUT_BYTES: "32768", AI_MAX_OUTPUT_TOKENS: "1024", AI_TIMEOUT_MS: "300000",
    PANTRYPILOT_DATA_DIR: f.paths.data, RUN_INITIAL_GEMINI_PROBE: "true",
    PROBE_APPROVED_APPROVAL_SHA256: sha(f.approval), PROBE_CREDENTIAL_REFERENCE: f.manifest.binding.credentialReference,
    PROBE_OPERATOR: f.manifest.binding.operator })) vi.stubEnv(name, value);
  const selection = { catalogIds: catalogIds || initial.workspaces[1].catalog.map((item) => item.id), reasoning: "synthetic", infeasible: false };
  f.transport.mockImplementation(async (input) => {
    expect(String(input)).toMatch(/^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\/gemini-3\.8-flash:(countTokens|generateContent)$/);
    return String(input).endsWith(":countTokens") ? Response.json({ totalTokens: 2 }) :
      Response.json({ candidates: [{ content: { role: "model", parts: [{ text: JSON.stringify(selection) }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1, totalTokenCount: 4 } });
  });
  vi.stubGlobal("fetch", f.transport);
  return initial;
}
it("P13 runs the actual planner/SDK on fake transport with zero financial changes and no campaign pass", async () => {
  const f = await initializedFixture(), initial = await fakePlannerRuntime(f);
  const receipt = await runInitialProbe(f.root, f.id, f.approval, (workspaceId, requestId, fixtureTime, shared, policy) =>
    aiProposal({ workspaceId, actorId: "owner-a", expiresAt: Date.now() + 100000, nonce: "offline-test" },
      requestId, shared, { fixtureTime, transportPolicy: policy }), f.clock, f.transport);
  expect(receipt.status).toBe("INITIAL_FEASIBILITY_OBSERVED"); expect(receipt.fullCampaignAccepted).toBe(false);
  expect(receipt.negativeCase.providerHttp).toBe(0); expect(f.transport).toHaveBeenCalledTimes(2);
  expect(plannerCases(f.manifest.fixtureTime)).toHaveLength(12); expect(plannerVerdict([], true, false)).toBe(false);
  for (const [index, entry] of f.manifest.cases.entries()) {
    const current = JSON.parse(await readFile(path.join(f.paths.data, `${entry.workspaceId}.json`), "utf8"));
    expect(financialSnapshot(current)).toBe(financialSnapshot(initial.workspaces[index]));
  }
  await expect(runInitialProbe(f.root, f.id, f.approval, async () => { throw new Error("no replay"); }, f.clock, f.transport)).rejects.toThrow();
  expect(f.transport).toHaveBeenCalledTimes(2);
});
it("P14 rejects source/build/fixture drift before calling a provider", async () => {
  const f = await initializedFixture();
  await writeFile(path.join(f.root, ".next", "BUILD_ID"), "changed-build");
  await expect(readProbe(f.root, f.id)).rejects.toThrow();
  await writeFile(path.join(f.root, ".next", "BUILD_ID"), "offline-build");
  await writeFile(path.join(f.root, "src", "changed.ts"), "// changed source\n");
  await expect(readProbe(f.root, f.id)).rejects.toThrow();
  await rm(path.join(f.root, "src", "changed.ts"));
  const file = path.join(f.paths.data, `${f.manifest.cases[1].workspaceId}.json`);
  const changed = JSON.parse(await readFile(file, "utf8")) as Workspace;
  changed.requests[0].budget = 59999; await writeFile(file, JSON.stringify(changed));
  await expect(readProbe(f.root, f.id)).rejects.toThrow(); expect(f.transport).not.toHaveBeenCalled();
});
it("P15 runtime admission fails without an exact execution flag and leaves provider transport untouched", async () => {
  const f = await fixture(); vi.stubEnv("RUN_INITIAL_GEMINI_PROBE", "false");
  expect(() => admitProbeRuntime(f.root, f.manifest, f.approval)).toThrow(); expect(f.transport).not.toHaveBeenCalled();
});
it("P16 CLI unknown operation is credential-free and prints no fake secret", async () => {
  const cli = path.resolve("scripts/planner-probe.ts"), loader = pathToFileURL(path.resolve("node_modules/tsx/dist/loader.mjs")).href;
  const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", loader, cli, "not-an-operation"],
      { cwd: process.cwd(), env: { NODE_ENV: "test", SystemRoot: process.env.SystemRoot, PATH: process.env.PATH }, windowsHide: true });
    let output = ""; const timer = setTimeout(() => { child.kill(); reject(new Error("offline CLI deadline")); }, 10000);
    child.stdout.on("data", (chunk) => { output += chunk; }); child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, output }); });
  });
  expect(result.code).toBe(1); expect(result.output).toContain("Initial probe refused or stopped");
  expect(result.output).not.toContain("FAKE_PRIVATE_SENTINEL");
});
it("P17 count timeout aborts the attempted count without dispatching generation", async () => {
  const f = await fixture(), deadline = new AbortController();
  const originalTimeout = AbortSignal.timeout;
  const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) =>
    ms === 10000 ? deadline.signal : originalTimeout(ms));
  let entered!: () => void;
  const reached = new Promise<void>((resolve) => { entered = resolve; });
  f.transport.mockImplementation(async (_input, init) => new Promise<Response>((_resolve, reject) => {
    init!.signal!.addEventListener("abort", () => reject(new Error("offline count timeout")), { once: true });
    entered();
  }));
  try {
    const guard = await f.make(), result = f.request(guard.policy).then(() => "UNEXPECTED", () => "STOPPED");
    await reached; deadline.abort(); expect(await result).toBe("STOPPED");
    expect(f.transport).toHaveBeenCalledTimes(1);
  } finally { timeout.mockRestore(); }
});
it("P18 refuses a corrupted journal, and window exit between count and generation", async () => {
  const f = await fixture(); f.transport.mockImplementationOnce(async () => {
    f.advance(300000); return Response.json({ totalTokens: 2 });
  });
  const guard = await f.make(); await expect(f.request(guard.policy)).rejects.toThrow();
  expect(f.transport).toHaveBeenCalledTimes(1);
  const second = await fixture();
  await writeFile(path.join(second.paths.quota, "events", "000000.json"), "{}");
  await expect(second.make()).rejects.toThrow(); expect(second.transport).not.toHaveBeenCalled();
});
it.each(["ledger", "orders", "donations", "recoveries", "inventory", "distributions", "approvals"] as const)(
  "P19 refuses a changed protected array: %s", async (field) => {
    const f = await initializedFixture(); await fakePlannerRuntime(f);
    await expect(runInitialProbe(f.root, f.id, f.approval, async (workspaceId, requestId, fixtureTime, shared, policy) => {
      const candidate = await aiProposal({ workspaceId, actorId: "owner-a", expiresAt: Date.now() + 100000, nonce: "offline-test" },
        requestId, shared, { fixtureTime, transportPolicy: policy });
      const file = path.join(f.paths.data, `${workspaceId}.json`);
      const current = JSON.parse(await readFile(file, "utf8")) as Workspace;
      await writeFile(file, JSON.stringify({ ...current, [field]: [...current[field], { offlineTamper: true }] }));
      return candidate;
    }, f.clock, f.transport)).rejects.toThrow();
    await expect(readFile(path.join(f.paths.evidence, "receipt.json"))).rejects.toThrow();
    await expect(readFile(path.join(f.paths.quota, "block.lock"))).resolves.toBeDefined();
  });
it("P20 invented catalog output never produces a successful probe receipt", async () => {
  const f = await initializedFixture(); await fakePlannerRuntime(f, ["invented-catalog-id"]);
  await expect(runInitialProbe(f.root, f.id, f.approval, (workspaceId, requestId, fixtureTime, shared, policy) =>
    aiProposal({ workspaceId, actorId: "owner-a", expiresAt: Date.now() + 100000, nonce: "offline-test" },
      requestId, shared, { fixtureTime, transportPolicy: policy }), f.clock, f.transport)).rejects.toThrow();
  await expect(readFile(path.join(f.paths.evidence, "receipt.json"))).rejects.toThrow();
  expect(JSON.parse(await readFile(path.join(f.paths.evidence, "failed.json"), "utf8")).fullCampaignAccepted).toBe(false);
});
it("P21 repeated initialization cannot overwrite evidence or reset the project origin", async () => {
  const f = await initializedFixture(), before = await readFile(path.join(f.paths.quota, "origin.json"), "utf8");
  await expect(initializeProbe(f.root, f.id, f.manifest.binding)).rejects.toThrow();
  expect(await readFile(path.join(f.paths.quota, "origin.json"), "utf8")).toBe(before);
  expect(JSON.parse(await readFile(path.join(f.paths.evidence, "manifest.json"), "utf8")).id).toBe(f.id);
});
it.each([
  ["PAYMENTS_MODE", "sandbox"], ["PROVIDER_ACTIONS_ENABLED", "false"], ["FINANCIAL_ACTIONS_ENABLED", "true"],
  ["APP_ENV", "hosted"], ["VERCEL", "true"], ["STORAGE_MODE", "supabase"], ["AI_MODE", "manual"],
  ["GEMINI_MODEL", "unapproved-model"], ["PROBE_APPROVED_APPROVAL_SHA256", "0".repeat(64)],
  ["PROBE_CREDENTIAL_REFERENCE", "wrong-reference"], ["PROBE_OPERATOR", "wrong-operator"],
  ["AI_MAX_HTTP_REQUESTS", "4"], ["PANTRYPILOT_DATA_DIR", "wrong-data"], ["GEMINI_API_KEY", ""],
])("P22 runtime refuses invalid binding %s", async (name, value) => {
  const f = await initializedFixture(); await fakePlannerRuntime(f); vi.stubEnv(name, value);
  expect(() => admitProbeRuntime(f.root, f.manifest, f.approval)).toThrow(); expect(f.transport).not.toHaveBeenCalled();
});

it("A1 recovers one returned503 with a newly charged count/generation pair", async () => {
  const f = await fixture(); f.approval.sessionPolicy = SESSION_A1.id;
  f.approval.ownerAttestedAt = f.clock.now(); f.approval.quietSince = f.clock.now();
  f.approval.usageObservedAt = f.clock.now() - 120000; await f.coordination();
  let generation = 0;
  f.transport.mockImplementation(async input => String(input).endsWith(":countTokens") ?
    Response.json({ totalTokens: 2 }) : ++generation === 1 ? new Response(null, { status: 503 }) :
      Response.json({ usageMetadata: { promptTokenCount: 3 } }));
  await withProjectLock(f.paths.quota, async () => {
    const guarded = await f.make(); await f.request(guarded.policy);
    const audit = await auditSessionProbeQuota(f.paths.quota, INITIAL_PROBE.project, f.id);
    expect(audit.countCalls).toBe(2); expect(audit.generationCalls).toBe(2); expect(audit.httpReserved).toBe(4);
  });
  const events = (await new H2Journal(f.paths.quota).read()).map(e => e.value);
  expect(events.filter(e => e.kind === "generation-transient")).toHaveLength(1);
  expect(events.some(e => e.kind === "poison")).toBe(false);
  expect(f.transport).toHaveBeenCalledTimes(4); expect(globalThis.fetch).not.toHaveBeenCalled();
});
it.each([401, 403, 404, 429])("A1 refuses status%s without a retry", async status => {
  const f = await fixture(); f.approval.sessionPolicy = SESSION_A1.id;
  f.approval.ownerAttestedAt = f.clock.now(); await f.coordination();
  f.transport.mockImplementation(async input => String(input).endsWith(":countTokens") ?
    Response.json({ totalTokens: 2 }) : new Response(null, { status }));
  await expect(withProjectLock(f.paths.quota, async () => f.request((await f.make()).policy))).rejects.toThrow();
  expect(f.transport).toHaveBeenCalledTimes(2);
});
it("A1 repeated503 stops after one retry and preserves the poison", async () => {
  const f = await fixture(); f.approval.sessionPolicy = SESSION_A1.id;
  f.approval.ownerAttestedAt = f.clock.now(); await f.coordination();
  f.transport.mockImplementation(async input => String(input).endsWith(":countTokens") ?
    Response.json({ totalTokens: 2 }) : new Response(null, { status: 503 }));
  await expect(withProjectLock(f.paths.quota, async () => f.request((await f.make()).policy))).rejects.toThrow();
  expect(f.transport).toHaveBeenCalledTimes(4);
  expect((await new H2Journal(f.paths.quota).read()).some(e => e.value.kind === "poison")).toBe(true);
  await expect(f.make()).rejects.toThrow();
});

it("A1 boundary never reserves a fourth pair when the third generation returns503", async () => {
  const f = await fixture(); f.approval.sessionPolicy = SESSION_A1.id;
  f.approval.ownerAttestedAt = f.clock.now(); await f.coordination();
  let generations = 0;
  f.transport.mockImplementation(async input => String(input).endsWith(":countTokens") ?
    Response.json({ totalTokens: 2 }) : ++generations === 3 ? new Response(null, { status: 503 }) :
      Response.json({ usageMetadata: { promptTokenCount: 3 } }));
  await expect(withProjectLock(f.paths.quota, async () => {
    const guard = await f.make();
    await f.request(guard.policy); await f.request(guard.policy); await f.request(guard.policy);
  })).rejects.toThrow();
  expect(f.transport).toHaveBeenCalledTimes(6);
  expect((await new H2Journal(f.paths.quota).read()).filter(e => e.value.kind === "pair-reserved")).toHaveLength(3);
});

it.each(["count503", "network-unknown", "abort503"])("A1 boundary does not retry%s", async failure => {
  const f = await fixture(); f.approval.sessionPolicy = SESSION_A1.id;
  f.approval.ownerAttestedAt = f.clock.now(); await f.coordination();
  f.transport.mockImplementation(async input => {
    if (String(input).endsWith(":countTokens")) return failure === "count503" ?
      new Response(null, { status: 503 }) : Response.json({ totalTokens: 2 });
    if (failure === "network-unknown") throw new Error("OFFLINE_SENSITIVE_ERROR_SENTINEL");
    f.control.abort(); return new Response(null, { status: 503 });
  });
  await expect(withProjectLock(f.paths.quota, async () => f.request((await f.make()).policy))).rejects.toThrow();
  expect(f.transport).toHaveBeenCalledTimes(failure === "count503" ? 1 : 2);
  const events = await new H2Journal(f.paths.quota).read();
  expect(events.some(e => e.value.kind === "poison")).toBe(true);
  expect(events.some(e => e.value.kind === "generation-transient")).toBe(false);
  expect(JSON.stringify(events)).not.toContain("OFFLINE_SENSITIVE_ERROR_SENTINEL");
});

it("A1 boundary rejects orphan transient records", async () => {
  const f = await fixture(); f.approval.sessionPolicy = SESSION_A1.id;
  f.approval.ownerAttestedAt = f.clock.now(); await f.coordination();
  await withProjectLock(f.paths.quota, async () => f.request((await f.make()).policy));
  await new H2Journal(f.paths.quota).append({ kind: "generation-transient", pair: "orphan", identity: "0".repeat(64),
    campaign: f.id, caseId: 2, day: f.approval.day, at: f.clock.now(), httpStatus: 503, policy: SESSION_A1.id });
  await expect(auditSessionProbeQuota(f.paths.quota, INITIAL_PROBE.project, f.id)).rejects.toThrow();
});

it("A1 boundary keeps diagnostic recovery out of H3 outcomes while retaining shared charges", async () => {
  const f = await fixture(); f.approval.sessionPolicy = SESSION_A1.id;
  f.approval.ownerAttestedAt = f.clock.now(); await f.coordination();
  let generations = 0;
  f.transport.mockImplementation(async input => String(input).endsWith(":countTokens") ? Response.json({ totalTokens: 2 }) :
    ++generations === 1 ? new Response(null, { status: 503 }) : Response.json({ usageMetadata: { promptTokenCount: 3 } }));
  await withProjectLock(f.paths.quota, async () => f.request((await f.make()).policy));
  await expect(auditH3Quota(f.paths.quota, INITIAL_PROBE.project, f.id)).rejects.toThrow();
  const later = await auditH3Quota(f.paths.quota, INITIAL_PROBE.project, randomUUID());
  expect(later.countCalls).toBe(0); expect(later.generationCalls).toBe(0);
  expect((await new H2Journal(f.paths.quota).read()).filter(e => e.value.kind === "pair-reserved")).toHaveLength(2);
});

it.each(["identity", "status", "case", "day", "duplicate", "contradictory-success"])(
  "A1 boundary audit rejects invalid transient%s with a valid control", async drift => {
    const populate = async (bad: boolean) => {
      const f = await fixture(), pair = randomUUID(), identity = "a".repeat(64), journal = new H2Journal(f.paths.quota);
      const common = { pair, identity, campaign: f.id, caseId: 2, day: f.approval.day, at: f.clock.now() };
      for (const e of [{ kind: "pair-reserved" }, { kind: "count-start" }, { kind: "count-result", count: 2 }, { kind: "generation-start" }])
        await journal.append({ ...common, ...e });
      const transient = { ...common, kind: "generation-transient", httpStatus: 503, policy: SESSION_A1.id };
      if (bad && drift === "identity") transient.identity = "b".repeat(64);
      if (bad && drift === "status") transient.httpStatus = 429;
      if (bad && drift === "case") transient.caseId = 3;
      if (bad && drift === "day") transient.day = "2026-10-31";
      await journal.append(transient);
      if (bad && drift === "duplicate") await journal.append(transient);
      if (bad && drift === "contradictory-success") await journal.append({ ...common, kind: "generation-result", actual: 3 });
      return f;
    };
    const good = await populate(false);
    expect((await auditSessionProbeQuota(good.paths.quota, INITIAL_PROBE.project, good.id)).httpReserved).toBe(2);
    const bad = await populate(true);
    await expect(auditSessionProbeQuota(bad.paths.quota, INITIAL_PROBE.project, bad.id)).rejects.toThrow();
  });

it("A1 boundary actual planner recovers503 once, persists one proposal and preserves finances", async () => {
  const f = await initializedFixture();
  let now = f.clock.now(), elapsed = 0;
  f.clock = { now: () => now, monotonic: () => elapsed, sleep: async (ms, signal) => {
    signal.throwIfAborted(); now += ms; elapsed += ms;
  } };
  Object.assign(f.approval, { sessionPolicy: SESSION_A1.id, ownerAttestedAt: now, quietSince: now });
  await writeFile(path.join(f.paths.evidence, "coordination.json"), JSON.stringify({ approvalHash: sha(f.approval), exclusive: true, unaccountedUse: false }));
  const initial = await fakePlannerRuntime(f), healthy = f.transport.getMockImplementation()!;
  let generations = 0, executions = 0;
  f.transport.mockImplementation(async (input, init) => {
    if (String(input).endsWith(":generateContent") && ++generations === 1) return new Response(null, { status: 503 });
    return healthy(input, init);
  });
  const receipt = await runInitialProbe(f.root, f.id, f.approval, (workspaceId, requestId, fixtureTime, shared, policy) => {
    executions++;
    return aiProposal({ workspaceId, actorId: "owner-a", expiresAt: Date.now() + 100000, nonce: "offline-a1-recovery" },
      requestId, shared, { fixtureTime, transportPolicy: policy, sessionTimeoutMs: 300000 });
  }, f.clock, f.transport);
  expect(executions).toBe(1); expect(f.transport).toHaveBeenCalledTimes(4);
  expect(receipt.countCalls).toBe(2); expect(receipt.generationCalls).toBe(2); expect(receipt.fullCampaignAccepted).toBe(false);
  const positive = JSON.parse(await readFile(path.join(f.paths.data, f.manifest.cases[1].workspaceId + ".json"), "utf8")) as Workspace;
  expect(positive.proposals).toHaveLength(1); expect(positive.agentRuns).toHaveLength(1);
  expect(financialSnapshot(positive)).toBe(financialSnapshot(initial.workspaces[1]));
  const events = (await new H2Journal(f.paths.quota).read()).map(e => e.value);
  expect(events.filter(e => e.kind === "generation-transient")).toHaveLength(1);
  expect(events.some(e => e.kind === "poison")).toBe(false);
});
