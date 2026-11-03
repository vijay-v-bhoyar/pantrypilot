import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { bindModelBudgetSignal, budgetedModelFetch, createModelBudget } from "../src/lib/model-budget";
import { H2Journal, initializeQuota, pacificDay, sha, type SafetyClock } from "../scripts/lib/planner-quota";
import { INITIAL_PROBE, initializeProbe, probeLimits, probePaths, runInitialProbe } from "../scripts/lib/planner-probe";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    expect(path.dirname(root)).toBe(path.resolve(os.tmpdir()));
    expect(path.basename(root)).toMatch(/^pp-approval-expiry-/);
    await rm(root, { recursive: true, force: true });
  }
});

it("keeps live shared counters and the original cap while adding approval cancellation", () => {
  const original = createModelBudget(probeLimits, "evaluation"), approval = new AbortController();
  const bound = bindModelBudgetSignal(original, approval.signal);
  original.charge(); expect(bound.attempts).toBe(1);
  bound.charge(); bound.charge(); expect(original.attempts).toBe(3);
  expect(() => bound.charge()).toThrow(); expect(original.attempts).toBe(3);
  approval.abort(); expect(bound.signal.aborted).toBe(true);
  expect(() => bound.assertActive()).toThrow();
});

it("preserves cancellation from the underlying model budget", () => {
  const deadline = new AbortController();
  vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(deadline.signal);
  const bound = bindModelBudgetSignal(createModelBudget(probeLimits), new AbortController().signal);
  deadline.abort(); expect(bound.signal.aborted).toBe(true);
  expect(() => bound.assertCapacity()).toThrow(); expect(bound.attempts).toBe(0);
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "pp-approval-expiry-")); roots.push(root);
  const id = randomUUID(), paths = probePaths(root, id), now = Date.now();
  for (const directory of ["src", "scripts", "tests", ".next"]) await mkdir(path.join(root, directory), { recursive: true });
  for (const file of ["package.json", "package-lock.json", "tsconfig.json", "vitest.config.ts", "playwright.config.ts"])
    await writeFile(path.join(root, file), "offline synthetic identity\n");
  await writeFile(path.join(root, ".next/BUILD_ID"), "offline-expiry-build");
  await initializeQuota(paths.quota, { project: INITIAL_PROBE.project, day: pacificDay(now), knownUsed: 0,
    evidenceReference: "offline-synthetic-only" });
  const manifest = await initializeProbe(root, id, { canonicalRoot: root, project: INITIAL_PROBE.project,
    model: INITIAL_PROBE.model, operator: "offline-owner", credentialReference: "no-real-key" });
  // A late admitted start has two minutes remaining, not a new five-minute window.
  const approval = { manifestHash: sha(manifest), quotaHead: (await new H2Journal(paths.quota).read()).at(-1)!.hash,
    day: pacificDay(now), quietSince: now - 931000, usageObservedAt: now - 31000,
    windowStart: now - 30000, windowEnd: now + 120000, knownPriorHttp: 0,
    laterExternalReservedHttp: 0, usageReference: "offline-observation" };
  await writeFile(path.join(paths.evidence, "coordination.json"), JSON.stringify({ approvalHash: sha(approval),
    exclusive: true, unaccountedUse: false }));
  const clock: SafetyClock = { now: () => now, monotonic: () => 0, sleep: async () => {} };
  return { root, id, paths, approval, clock };
}

it.each(["countTokens", "generateContent"])("absolute approval expiry aborts in-flight %s and retains failure accounting", async (phase) => {
  const f = await fixture(), deadline = new AbortController(), originalTimeout = AbortSignal.timeout;
  const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => ms === 120000 ? deadline.signal : originalTimeout(ms));
  const transport = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const method = String(input).split(":").at(-1);
    if (method === "countTokens" && phase === "generateContent") return Response.json({ totalTokens: 2 });
    expect(method).toBe(phase);
    return new Promise<Response>((_resolve, reject) => {
      const signal = init!.signal!;
      signal.addEventListener("abort", () => reject(new Error("offline approval deadline")), { once: true });
      deadline.abort();
    });
  });
  await expect(runInitialProbe(f.root, f.id, f.approval, async (_w, _r, _t, shared, policy) => {
    const fetcher = budgetedModelFetch(INITIAL_PROBE.model, createModelBudget(probeLimits),
      new AbortController().signal, shared, transport, policy);
    await fetcher(`https://generativelanguage.googleapis.com/v1beta/models/${INITIAL_PROBE.model}:generateContent`,
      { method: "POST", body: JSON.stringify({ contents: [{ parts: [{ text: "synthetic" }] }],
        generationConfig: { maxOutputTokens: 1024 } }) });
    throw new Error("must stop before a proposal");
  }, f.clock, transport)).rejects.toThrow("Preserve the project lock");
  expect(timeout).toHaveBeenCalledWith(120000);
  expect(transport).toHaveBeenCalledTimes(phase === "countTokens" ? 1 : 2);
  await expect(readFile(path.join(f.paths.quota, "block.lock"))).resolves.toBeDefined();
  await expect(readFile(path.join(f.paths.evidence, "receipt.json"))).rejects.toThrow();
  const failed = JSON.parse(await readFile(path.join(f.paths.evidence, "failed.json"), "utf8"));
  expect(failed.status).toBe("STOPPED_NOT_ACCEPTED");
  const events = await new H2Journal(f.paths.quota).read();
  expect(events.filter((e) => e.value.kind === "probe-http-attempt")).toHaveLength(phase === "countTokens" ? 1 : 2);
  const calls = transport.mock.calls.length;
  await expect(runInitialProbe(f.root, f.id, f.approval, async () => { throw new Error("no replay"); },
    f.clock, transport)).rejects.toThrow();
  expect(transport).toHaveBeenCalledTimes(calls);
});

it("an already-expired grant never reaches the planner and keeps the project lock", async () => {
  const f = await fixture(), execute = vi.fn(), transport = vi.fn<typeof fetch>();
  f.approval.windowEnd = f.clock.now();
  await expect(runInitialProbe(f.root, f.id, f.approval, execute, f.clock, transport)).rejects.toThrow();
  expect(execute).not.toHaveBeenCalled(); expect(transport).not.toHaveBeenCalled();
  await expect(readFile(path.join(f.paths.quota, "block.lock"))).resolves.toBeDefined();
});
