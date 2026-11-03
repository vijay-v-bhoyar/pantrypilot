import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { seedWorkspace } from "../src/lib/seed";
import type { Workspace } from "../src/lib/types";
import { plannerCases, financialSnapshot, evaluatePlannerCase } from "../scripts/lib/planner-evaluation";
import { campaignPaths, readCampaign, hackathonLifecycle } from "../scripts/lib/planner-campaign";
import { H3, HACKATHON_CUTOFF, initializeHackathon, readHackathon, finalizeHackathon, runHackathonBlock,
  planHackathonDates, validateHackathonGrant, createHackathonBudget, type HackathonGrant,
  type HackathonExecutor, type PlanningDay } from "../scripts/lib/planner-hackathon";
import { H2, H2Journal, createH3Policy, auditH3Quota, initializeQuota, pacificDay, projectDayUsed,
  sha, type SafetyClock } from "../scripts/lib/planner-quota";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals(); vi.useRealTimers();
  for (const root of roots.splice(0)) {
    expect(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)).toBe(true);
    expect(path.basename(root).startsWith("pp-h3-")).toBe(true);
    await rm(root, { recursive: true, force: true });
  }
});
async function fixture(knownUsed = 0) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pp-h3-")); roots.push(root);
  for (const dir of ["src", "scripts", "tests", ".next"]) await mkdir(path.join(root, dir));
  for (const n of ["package.json", "package-lock.json", "tsconfig.json", "vitest.config.ts", "playwright.config.ts"])
    await writeFile(path.join(root, n), "{}");
  await writeFile(path.join(root, ".next/BUILD_ID"), "synthetic-build");
  let now = Date.parse("2026-11-03T16:00:00Z"), elapsed = 0;
  const advance = (n: number) => { now += n; elapsed += n; };
  const clock: SafetyClock = { now: () => now, monotonic: () => elapsed,
    sleep: async (n, signal) => { signal.throwIfAborted(); advance(n); signal.throwIfAborted(); } };
  const id = randomUUID(), project = "synthetic-project";
  const limits = { maxHttpRequests: 6, maxInputBytes: 32768, maxOutputTokens: 1024, timeoutMs: 300000 };
  const binding = { model: "fixture-model", project, credentialReference: "fake-reference", operator: "synthetic-owner",
    limits, session: { ...limits, maxHttpRequests: 20 } };
  const paths = campaignPaths(root, id, project);
  await initializeQuota(paths.quota, { project, day: pacificDay(now), knownUsed, evidenceReference: "synthetic-origin" });
  vi.useFakeTimers(); vi.setSystemTime(now); const workspace = seedWorkspace();
  const manifest = await initializeHackathon(root, id, binding, workspace); vi.useRealTimers();
  const journal = new H2Journal(paths.quota);
  const grant = async (extra: Partial<HackathonGrant> = {}): Promise<HackathonGrant> => {
    const events = await journal.read();
    const origin = JSON.parse(await readFile(path.join(paths.quota, "origin.json"), "utf8"));
    const state = await readHackathon(root, id, project);
    return { policy: H3.policy, scope: "H3_SINGLE_CASE", canonicalRoot: root, campaignId: id,
      caseId: state.outcomes.length + 1, sourceDigest: manifest.sourceDigest, buildId: manifest.buildId,
      configDigest: manifest.configDigest, manifestHash: sha(manifest), project, model: binding.model,
      operator: binding.operator, credentialReference: binding.credentialReference, quotaHead: events.at(-1)!.hash,
      day: pacificDay(now), quietSince: now - 900000, usageObservedAt: now, windowStart: now, windowEnd: now + 300000,
      knownPriorHttp: projectDayUsed(events.map(e => e.value), origin, pacificDay(now)), laterExternalReservedHttp: 0,
      usageReference: "synthetic-usage", nonce: randomUUID(), pid: 1234, maxHttpRequests: 12, ...extra };
  };
  const activate = async (g: HackathonGrant) => writeFile(path.join(paths.evidence, "h3-activation.json"),
    JSON.stringify({ approvalHash: sha(g), nonce: g.nonce, pid: g.pid, exclusive: true, unaccountedUse: false }));
  const execute: HackathonExecutor = async (_m, caseId, active, signal, policy) => {
    active(); await policy.dispatch({ modelId: binding.model, body: "{}", init: {}, signal,
      send: async () => Response.json({ usageMetadata: { promptTokenCount: 2 } }) });
    const row = await evaluatePlannerCase(caseId - 1, async () => ({ source: "gemini", digest: "a".repeat(64),
      shortages: (caseId - 1) % 4 === 0 ? ["synthetic-infeasible"] : [] }));
    return { row, infrastructureFailed: false };
  };
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ totalTokens: 1 })));
  const run = async (g?: HackathonGrant, callback: HackathonExecutor = execute) => {
    g ||= await grant(); await activate(g);
    return runHackathonBlock(root, id, project, g, sha(g), g.pid, callback, clock);
  };
  return { root, id, project, binding, paths, manifest, workspace, clock, advance, grant, activate, run, journal, execute };
}
it("H3 preserves all12original fixtures, financial arrays and H2schema isolation", async () => {
  const f = await fixture();
  expect(f.manifest.schemaVersion).toBe(3); expect(f.manifest.policy).toEqual(H3);
  expect(f.manifest.cases.map(c => ({ case: c.case, slot: c.slot, target: c.target, budget: c.budget,
    deadline: c.deadline, siteId: c.siteId, kitId: c.kitId, fundId: c.fundId, notes: c.notes }))).toEqual(plannerCases(f.manifest.fixtureTime));
  expect(financialSnapshot(f.workspace)).toBe(f.manifest.initialFinancial);
  await expect(readCampaign(f.root, f.id, f.project)).rejects.toThrow();
  expect(H2.caseCounts).toBe(10); expect(H2.campaignHttp).toBe(240);
});
it("H3 same-day completed cases, clean quota defer and all12original outcomes finalize separately", async () => {
  const f = await fixture();
  for (let i = 0; i < 12; i++) {
    let result = await f.run();
    if (result.status === "DEFER") {
      await expect(access(path.join(f.paths.quota, "block.lock"))).rejects.toThrow();
      f.advance(86400000); result = await f.run();
    }
    expect(result.status).toBe("COMPLETED");
  }
  const state = await readHackathon(f.root, f.id, f.project);
  expect(state.outcomes[0].day).toBe(state.outcomes[1].day);
  expect(state.outcomes.map(o => o.row.case)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
  const final = await finalizeHackathon(f.root, f.id, f.project);
  expect(final).toMatchObject({ schemaVersion: 3, policy: H3.policy, hackathonGateAccepted: true, fullCampaignAccepted: false });
  expect(final).not.toHaveProperty("accepted"); expect(final.quota.httpReserved).toBe(24);
}, 30000); // Twelve durable case/receipt cycles; application60second budgets are tested separately.
it.each([1, 2])("H3 retains%dordinary FAILrows and the original11of12verdict", async failures => {
  const f = await fixture();
  for (let i = 0; i < 12; i++) {
    const callback: HackathonExecutor = async (...args) => {
      const actual = await f.execute(...args);
      return i < failures ? { ...actual, row: { case: i + 1, status: "FAIL" } } : actual;
    };
    if ((await f.run(undefined, callback)).status === "DEFER") {
      f.advance(86400000); await f.run(undefined, callback);
    }
  }
  const final = await finalizeHackathon(f.root, f.id, f.project);
  expect(final.hackathonGateAccepted).toBe(failures === 1); expect(final.rows).toHaveLength(12);
  expect(final.rows[0].status).toBe("FAIL");
}, 30000);
it.each([9, 19, 20])("H3 headroom deficit with%sprior use defers before callback/nonce/lock", async prior => {
  const f = await fixture(prior), g = await f.grant(), execute = vi.fn();
  const head = (await f.journal.read()).at(-1)!.hash;
  expect(await runHackathonBlock(f.root, f.id, f.project, g, sha(g), g.pid, execute, f.clock)).toMatchObject({ status: "DEFER" });
  expect((await f.journal.read()).at(-1)!.hash).toBe(head); expect(execute).not.toHaveBeenCalled();
  await expect(access(path.join(f.paths.quota, "block.lock"))).rejects.toThrow();
});
it("H3 external traffic charges once, reserved traffic reduces headroom", async () => {
  const f = await fixture(); const g = await f.grant({ knownPriorHttp: 4, laterExternalReservedHttp: 4 });
  expect((await f.run(g)).status).toBe("COMPLETED");
  expect((await f.journal.read()).filter(e => e.value.kind === "h3-external-accounting").map(e => e.value.http)).toEqual([4]);
  const next = await f.grant({ laterExternalReservedHttp: 4 });
  expect((await f.run(next)).status).toBe("DEFER");
});
it.each(["sourceDigest", "buildId", "configDigest", "manifestHash", "project", "model", "operator", "credentialReference", "canonicalRoot", "campaignId", "quotaHead", "nonce", "policy", "scope"] as const)(
  "H3 rejects wrong%swithout key callback", async field => {
    const f = await fixture(), g = { ...await f.grant(), [field]: "wrong" } as HackathonGrant;
    await expect(f.run(g, vi.fn())).rejects.toThrow();
  });
it.each([{ pid: 999 }, { caseId: 2 }, { maxHttpRequests: 144 }, { usageObservedAt: 1 },
  { maxHttpRequests: 6 },
  { quietSince: Date.parse("2026-11-03T16:00:00Z") }, { knownPriorHttp: -1 }, { laterExternalReservedHttp: 21 },
  { windowEnd: HACKATHON_CUTOFF + 1 }])("H3 rejects stale/inexact grant%j", async patch => {
  const f = await fixture(), g = { ...await f.grant(), ...patch } as HackathonGrant;
  expect(() => validateHackathonGrant(f.root, f.manifest, 1, g, sha(g), 1234, f.clock)).toThrow();
});
it("H3 refuses stale head, unknown fields, missing activation and replay", async () => {
  const f = await fixture(), g = await f.grant();
  await expect(runHackathonBlock(f.root, f.id, f.project, g, sha(g), 1234, f.execute, f.clock)).rejects.toThrow();
  await f.journal.append({ kind: "unrelated-use-observation" });
  await expect(f.run(g)).rejects.toThrow();
  const other = await fixture(); const unknown = { ...await other.grant(), unexpected: true };
  expect(() => validateHackathonGrant(other.root, other.manifest, 1, unknown, sha(unknown), 1234, other.clock)).toThrow();
  const good = await other.grant(); await other.run(good); await expect(other.run(good)).rejects.toThrow();
});
it.each(["throw", "infrastructure", "coordination"])("H3 uncertain%sretains lock and prevents continuation", async kind => {
  const f = await fixture();
  const callback: HackathonExecutor = async (_m, caseId, active, signal, policy) => {
    if (kind === "throw") throw new Error("SENTINEL_SECRET_NOT_PERSISTED");
    if (kind === "coordination") {
      await writeFile(path.join(f.paths.evidence, "h3-activation.json"), "{}");
      return f.execute(_m, caseId, active, signal, policy);
    }
    return { row: { case: caseId, status: "FAIL" }, infrastructureFailed: true };
  };
  await expect(f.run(undefined, callback)).rejects.toThrow();
  await expect(access(path.join(f.paths.quota, "block.lock"))).resolves.toBeUndefined();
  await expect(f.run()).rejects.toThrow();
  expect(JSON.stringify((await f.journal.read()).map(e => e.value))).not.toContain("SENTINEL_SECRET");
});
it.each([1, 3, 6])("H3 transport%d-pair ceiling is variable usage, not forced repetitions", async pairs => {
  const f = await fixture(); const signal = new AbortController().signal;
  const policy = createH3Policy({ root: f.paths.quota, project: f.project, campaign: f.id, caseId: 1,
    model: f.binding.model, day: pacificDay(f.clock.now()), approvedDay: pacificDay(f.clock.now()),
    knownProjectUseReference: "synthetic", laterExternalReservedHttp: 0, signal, assertActive: () => {}, clock: f.clock });
  const request = () => policy.dispatch({ modelId: f.binding.model, body: "{}", init: {}, signal,
    send: async () => Response.json({ usageMetadata: { promptTokenCount: 2 } }) });
  for (let i = 0; i < pairs; i++) await request();
  expect((await auditH3Quota(f.paths.quota, f.project, f.id)).httpReserved).toBe(pairs * 2);
  if (pairs === 6) { await expect(request()).rejects.toThrow();
    expect((await f.journal.read()).filter(e => e.value.kind === "pair-reserved")).toHaveLength(6); }
});
it("H3 fifth pair reservation remains charged when original60second application signal aborts pacing", async () => {
  const f = await fixture(); const control = new AbortController(), start = f.clock.now();
  const clock = { ...f.clock, sleep: async (ms: number) => { f.advance(ms); if (f.clock.now() - start >= 60000) control.abort(); } };
  const policy = createH3Policy({ root: f.paths.quota, project: f.project, campaign: f.id, caseId: 1,
    model: f.binding.model, day: pacificDay(start), approvedDay: pacificDay(start), knownProjectUseReference: "synthetic",
    laterExternalReservedHttp: 0, signal: control.signal, assertActive: () => control.signal.throwIfAborted(), clock });
  const request = () => policy.dispatch({ modelId: f.binding.model, body: "{}", init: {}, signal: control.signal,
    send: async () => Response.json({ usageMetadata: { promptTokenCount: 2 } }) });
  for (let i = 0; i < 4; i++) await request(); await expect(request()).rejects.toThrow();
  const events = (await f.journal.read()).map(e => e.value);
  expect(events.filter(e => e.kind === "count-start")).toHaveLength(4);
  expect(events.filter(e => e.kind === "pair-reserved")).toHaveLength(5);
  expect(events.some(e => e.kind === "poison")).toBe(true);
});
it("H3 calendar uses whole-case headroom, attendance, known traffic and exact deadline", () => {
  const start = Date.parse("2026-11-03T16:00:00Z");
  const days: PlanningDay[] = Array.from({ length: 10 }, (_, i) => ({ day: pacificDay(start + i * 86400000),
    knownPriorHttp: 0, reservedHttp: 0, attended: true, windowStart: start + i * 86400000,
    windowEnd: start + i * 86400000 + 3600000 }));
  expect(planHackathonDates(Array(12).fill(8), days).allocations).toHaveLength(6);
  expect(planHackathonDates(Array(12).fill(12), days).feasibleUnderAssumptions).toBe(false);
  expect(planHackathonDates(Array(12).fill(6), days).allocations).toHaveLength(6);
  expect(planHackathonDates(Array(12).fill(2), days.map(d => ({ ...d, knownPriorHttp: null }))).unplacedCases).toBe(12);
  expect(planHackathonDates(Array(12).fill(2), days.map(d => ({ ...d, attended: false }))).unplacedCases).toBe(12);
  expect(planHackathonDates(Array(12).fill(2), days.map(d => ({ ...d, reservedHttp: 9 }))).unplacedCases).toBe(12);
  const late = { ...days.at(-1)!, windowStart: HACKATHON_CUTOFF - 299999, windowEnd: HACKATHON_CUTOFF + 1 };
  expect(planHackathonDates(Array(12).fill(2), [late]).unplacedCases).toBe(12);
});
it.each(["ledger", "orders", "donations", "recoveries", "inventory", "distributions", "approvals"] as const)(
  "H3 still rejects changed financial array%s", async field => {
    const f = await fixture(); const file = path.join(f.paths.data, `${f.workspace.id}.json`);
    const w = JSON.parse(await readFile(file, "utf8")) as Workspace;
    (w[field] as unknown[]).push({ changed: true }); await writeFile(file, JSON.stringify(w));
    await expect(readHackathon(f.root, f.id, f.project)).rejects.toThrow();
  });
it("H3 rejects a quota-head race after the project lock is acquired", async () => {
  const f = await fixture(), g = await f.grant(), execute = vi.fn(); await f.activate(g);
  const pending = runHackathonBlock(f.root, f.id, f.project, g, sha(g), g.pid, execute, f.clock);
  const mutation = (async () => {
    for (let i = 0; i < 5000; i++) {
      try { await access(path.join(f.paths.quota, "block.lock")); await f.journal.append({ kind: "racing-external-observation" }); return; }
      catch { await new Promise<void>(resolve => setImmediate(resolve)); }
    }
    throw new Error("Owned synthetic lock never appeared");
  })();
  await expect(pending).rejects.toThrow(); await mutation;
  expect(execute).not.toHaveBeenCalled();
  await expect(access(path.join(f.paths.quota, "block.lock"))).resolves.toBeUndefined();
});
it("H3 new schema rejects unknown manifest fields", async () => {
  const f = await fixture(), file = path.join(f.paths.evidence, "manifest.json");
  await writeFile(file, JSON.stringify({ ...f.manifest, extra: true }));
  await expect(readHackathon(f.root, f.id, f.project)).rejects.toThrow();
});
it("H3 exact144transport-envelope audit and attempted73rdpair refuse extra send", async () => {
  // Fabricated transport ledger, not six-generation application success or real quota dates.
  const f = await fixture(); const entries = await f.journal.read(); let previous = entries.at(-1)!.hash, sequence = entries.length;
  const append = async (value: Record<string, unknown>) => {
    const event = { sequence, previous, value, hash: sha({ sequence, previous, value }) };
    const name = `${String(sequence).padStart(6, "0")}.json`;
    await writeFile(path.join(f.paths.quota, "events", name), JSON.stringify(event), { flag: "wx" });
    await writeFile(path.join(f.paths.quota, "seals", name), JSON.stringify({ hash: event.hash }), { flag: "wx" });
    previous = event.hash; sequence++;
  };
  const start = f.clock.now();
  for (let caseId = 1; caseId <= 12; caseId++) for (let i = 0; i < 6; i++) {
    const at = start + (caseId - 1) * 86400000 + i * 16000, pair = randomUUID();
    const common = { pair, campaign: f.id, caseId, identity: "a".repeat(64), day: pacificDay(at), at };
    await append({ ...common, kind: "pair-reserved" }); await append({ ...common, kind: "count-start" });
    await append({ ...common, kind: "count-result", count: 1 }); await append({ ...common, kind: "generation-start", reservedTokens: 62500 });
    await append({ ...common, kind: "generation-result", actual: 2 });
  }
  expect((await auditH3Quota(f.paths.quota, f.project, f.id)).httpReserved).toBe(144);
  f.advance(12 * 86400000); const signal = new AbortController().signal, send = vi.fn();
  const policy = createH3Policy({ root: f.paths.quota, project: f.project, campaign: f.id, caseId: 1,
    model: f.binding.model, day: pacificDay(f.clock.now()), approvedDay: pacificDay(f.clock.now()),
    knownProjectUseReference: "synthetic", laterExternalReservedHttp: 0, signal, assertActive: () => {}, clock: f.clock });
  await expect(policy.dispatch({ modelId: f.binding.model, body: "{}", init: {}, signal, send })).rejects.toThrow();
  expect(send).not.toHaveBeenCalled();
  expect((await f.journal.read()).filter(e => e.value.kind === "pair-reserved")).toHaveLength(72);
}, 30000);
it("H3 missing/wrong approval hash cannot reach callback", async () => {
  const f = await fixture(), g = await f.grant(), callback = vi.fn();
  for (const approved of ["", "0".repeat(64)])
    await expect(runHackathonBlock(f.root, f.id, f.project, g, approved, g.pid, callback, f.clock)).rejects.toThrow();
  expect(callback).not.toHaveBeenCalled();
});
it.each([-1, 300001])("H3 active clock rollback/expiry%sretains the lock", async delta => {
  const f = await fixture();
  await expect(f.run(undefined, async (_m, _caseId, active) => {
    f.advance(delta); active(); throw new Error("unreachable");
  })).rejects.toThrow();
  await expect(access(path.join(f.paths.quota, "block.lock"))).resolves.toBeUndefined();
});
it.each(["countHTTP", "generationJSON", "generationUsage"])("H3%sdiagnostics retain allowlisted phase/status only", async failure => {
  const f = await fixture();
  if (failure === "countHTTP") vi.stubGlobal("fetch", vi.fn(async () => new Response("SENTINEL_SECRET", { status: 403 })));
  await expect(f.run(undefined, async (_m, _caseId, _active, signal, policy) => {
    await policy.dispatch({ modelId: f.binding.model, body: "{}", init: { headers: { "x-goog-api-key": "SENTINEL_KEY" } }, signal,
      send: async () => failure === "generationJSON" ? new Response("SENTINEL_SECRET", { headers: { "content-type": "application/json" } }) :
        Response.json({ usageMetadata: { promptTokenCount: 62501 }, ignored: "SENTINEL_SECRET" }) });
    throw new Error("unreachable");
  })).rejects.toThrow();
  const events = (await f.journal.read()).map(e => e.value);
  const poison = events.find(e => e.kind === "poison")!;
  expect(poison).toBeDefined(); expect(Object.keys(poison.diagnostic as object).sort()).toEqual(["httpStatus", "phase", "version"]);
  expect(JSON.stringify(events)).not.toContain("SENTINEL");
  await expect(access(path.join(f.paths.quota, "block.lock"))).resolves.toBeUndefined();
});
it("H3 cannot accept twelve PASSlabels without generation evidence", async () => {
  const f = await fixture();
  for (let i = 0; i < 12; i++) await hackathonLifecycle.run(f.root, f.id, f.project, f.binding,
    { manifestHash: sha(f.manifest), day: pacificDay(f.clock.now()), quotaReference: "synthetic" },
    async (_m, caseId) => ({ row: { case: caseId, status: "PASS" }, infrastructureFailed: false }), async () => {}, f.clock);
  await expect(finalizeHackathon(f.root, f.id, f.project)).rejects.toThrow();
  await expect(access(path.join(f.paths.evidence, "final.json"))).rejects.toThrow();
});
it("H3 approval-window abort reaches the budget signal and preserves live attempt counts", () => {
  const control = new AbortController();
  const budget = createHackathonBudget({ maxHttpRequests: 20, maxInputBytes: 32768, maxOutputTokens: 1024, timeoutMs: 300000 }, control.signal);
  expect(budget.attempts).toBe(0); budget.charge(); expect(budget.attempts).toBe(1);
  control.abort(); expect(budget.signal.aborted).toBe(true);
  expect(() => budget.assertActive()).toThrow(); expect(() => budget.charge()).toThrow();
  expect(budget.attempts).toBe(1);
});
it("H3 shortened approval window aborts an active callback and retains uncertainty lock", async () => {
  const f = await fixture(); const grant = await f.grant({ windowEnd: f.clock.now() + 100 });
  await expect(f.run(grant, async (_m, _caseId, active, signal) => {
    await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    expect(signal.aborted).toBe(true); active(); throw new Error("unreachable");
  })).rejects.toThrow();
  await expect(access(path.join(f.paths.quota, "block.lock"))).resolves.toBeUndefined();
  expect(fetch).not.toHaveBeenCalled();
});
