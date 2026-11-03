import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { H2Journal, createH2Policy, initializeQuota, pacificDay, sha, withProjectLock,
  type SafetyClock } from "../scripts/lib/planner-quota";
import { INITIAL_PROBE, initializeProbe, probePaths, probeLimits, runInitialProbe } from "../scripts/lib/planner-probe";

const roots: string[] = [];
const secret = "FAKE_DIAGNOSTIC_SECRET_NEVER_PERSIST";
beforeEach(() => { vi.stubGlobal("fetch", vi.fn(() => { throw new Error("UNEXPECTED_EGRESS"); })); });
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) {
    expect(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)).toBe(true);
    expect(path.basename(root).startsWith("pantrypilot-diagnostic-")).toBe(true);
    await rm(root, { recursive: true, force: true });
  }
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "pantrypilot-diagnostic-")); roots.push(root);
  const quota = path.join(root, "quota"), project = INITIAL_PROBE.project, campaign = randomUUID();
  let now = Date.now();
  const clock: SafetyClock = { now: () => now, monotonic: () => 0,
    sleep: async (ms, signal) => { signal.throwIfAborted(); now += ms; } };
  await initializeQuota(quota, { project, day: pacificDay(now), knownUsed: 0, evidenceReference: "synthetic-diagnostic" });
  const control = new AbortController();
  let countResponse: () => Promise<Response> = async () => Response.json({ totalTokens: 237 });
  let generationResponse: () => Promise<Response> = async () => Response.json({ usageMetadata: { promptTokenCount: 240 } });
  const transport = vi.fn<typeof fetch>().mockImplementation(async () => countResponse());
  const generation = vi.fn(async () => generationResponse());
  const make = () => createH2Policy({ root: quota, project, campaign, caseId: 2, model: "fixture-model",
    day: pacificDay(now), approvedDay: pacificDay(now), knownProjectUseReference: "synthetic-diagnostic",
    signal: control.signal, assertActive: () => control.signal.throwIfAborted(), clock, transport });
  const request = (policy = make()) => policy.dispatch({ modelId: "fixture-model",
    body: JSON.stringify({ contents: [{ parts: [{ text: secret }] }], generationConfig: { maxOutputTokens: 1024 } }),
    init: { headers: { "x-goog-api-key": secret } }, signal: control.signal, send: generation });
  return { root, quota, clock, control, transport, generation, request, make,
    fail: (side: string, action: () => Promise<Response>) => { if (side === "COUNT") countResponse = action; else generationResponse = action; } };
}
async function refused(f: Awaited<ReturnType<typeof fixture>>, phase: string, status?: number) {
  await expect(withProjectLock(f.quota, () => f.request())).rejects.toThrow("H2 transport stopped");
  const rows = await new H2Journal(f.quota).read();
  const poisons = rows.filter(r => r.value.kind === "poison");
  expect(poisons).toHaveLength(1);
  expect(poisons[0].value.diagnostic).toEqual({ version: 1, phase, ...(status === undefined ? {} : { httpStatus: status }) });
  const text = JSON.stringify(rows);
  for (const denied of [secret, "x-goog-api-key", "authorization", "https://private.invalid", "response-secret", "error-secret"])
    expect(text).not.toContain(denied);
  expect(rows.filter(r => r.value.kind === "pair-reserved")).toHaveLength(1);
  expect(rows.filter(r => r.value.kind === "generation-result")).toHaveLength(0);
  expect(await readFile(path.join(f.quota, "block.lock"), "utf8")).toContain("owner");
  const sent = f.transport.mock.calls.length + f.generation.mock.calls.length;
  await expect(f.request(f.make())).rejects.toThrow();
  expect(f.transport.mock.calls.length + f.generation.mock.calls.length).toBe(sent);
  expect(globalThis.fetch).not.toHaveBeenCalled();
}
it.each(["COUNT", "GENERATION"])("DIAG HTTP failures are attributed to %s without exposing response text", async side => {
  // One request per fresh owned fixture; an existing poisoned project is never reused.
  for (const status of [400, 401, 403, 404, 429, 500]) {
    const f = await fixture();
    f.fail(side, async () => new Response(JSON.stringify({ error: { message: `${secret} response-secret` } }),
      { status, headers: { "content-type": "application/json", authorization: secret } }));
    await refused(f, `${side}_HTTP_STATUS`, status);
    expect(f.transport).toHaveBeenCalledTimes(1);
    expect(f.generation).toHaveBeenCalledTimes(side === "COUNT" ? 0 : 1);
  }
});
it.each(["COUNT", "GENERATION"])("DIAG %s network errors never retain exception message or stack", async side => {
  const f = await fixture(); f.fail(side, async () => { throw new Error(`${secret} error-secret https://private.invalid`); });
  await refused(f, `${side}_SEND`);
});
it.each(["COUNT", "GENERATION"])("DIAG %s aborted send remains a failed, locked operation", async side => {
  const f = await fixture();
  f.fail(side, async () => { f.control.abort(new Error(secret)); f.control.signal.throwIfAborted(); return Response.json({}); });
  await refused(f, `${side}_SEND`);
});
it.each(["COUNT", "GENERATION"])("DIAG %s wrong content type is distinguishable from invalid JSON", async side => {
  const f = await fixture(); f.fail(side, async () => new Response(secret, { headers: { "content-type": "text/plain" } }));
  await refused(f, `${side}_CONTENT_TYPE`, 200);
});
it.each(["COUNT", "GENERATION"])("DIAG %s malformed JSON records phase and status only", async side => {
  const f = await fixture(); f.fail(side, async () => new Response(secret, { headers: { "content-type": "application/json" } }));
  await refused(f, `${side}_JSON_PARSE`, 200);
});
it.each(["COUNT", "GENERATION"])("DIAG %s oversized body keeps the original byte bound", async side => {
  const f = await fixture(); f.fail(side, async () => new Response(secret.repeat(40000),
    { headers: { "content-type": "application/json" } }));
  await refused(f, `${side}_BODY_READ`, 200);
});
it.each(["COUNT", "GENERATION"])("DIAG %s body-stream failure does not persist its error", async side => {
  const f = await fixture(); f.fail(side, async () => new Response(new ReadableStream({ start(controller) {
    controller.error(new Error(secret));
  } }), { headers: { "content-type": "application/json" } }));
  await refused(f, `${side}_BODY_READ`, 200);
});
it.each([0, 50001, "237"])("DIAG invalid measured count %s retains original acceptance", async value => {
  const f = await fixture(); f.fail("COUNT", async () => Response.json({ totalTokens: value }));
  await refused(f, "COUNT_VALIDATION", 200); expect(f.generation).not.toHaveBeenCalled();
});
it.each([undefined, 0, 62501])("DIAG invalid usage %s is separate from generation transport", async value => {
  const f = await fixture(); f.fail("GENERATION", async () => Response.json({ usageMetadata: { promptTokenCount: value } }));
  await refused(f, "GENERATION_USAGE", 200);
  expect((await new H2Journal(f.quota).read()).some(r => r.value.kind === "usage-refused")).toBe(true);
});
it("DIAG status zero is omitted instead of becoming an invented HTTP response", async () => {
  const f = await fixture(); f.fail("GENERATION", async () => Response.error());
  await refused(f, "GENERATION_HTTP_STATUS");
});
it("DIAG successful response still returns the original readable body and journal contract", async () => {
  const f = await fixture(); const response = await withProjectLock(f.quota, () => f.request());
  expect(await response.json()).toEqual({ usageMetadata: { promptTokenCount: 240 } });
  const rows = await new H2Journal(f.quota).read();
  expect(rows.some(r => r.value.kind === "poison" || r.value.diagnostic !== undefined)).toBe(false);
  expect(rows.filter(r => r.value.kind === "generation-result")).toHaveLength(1);
  expect(f.transport).toHaveBeenCalledTimes(1); expect(f.generation).toHaveBeenCalledTimes(1);
  expect(globalThis.fetch).not.toHaveBeenCalled();
});
it("DIAG original-format poison remains readable and still prevents sending", async () => {
  const f = await fixture(); await new H2Journal(f.quota).append({ kind: "poison", campaign: "historical", day: pacificDay(f.clock.now()) });
  await expect(f.request()).rejects.toThrow(); expect(f.transport).not.toHaveBeenCalled(); expect(f.generation).not.toHaveBeenCalled();
  const original = (await new H2Journal(f.quota).read())[1].value;
  expect(original).toEqual({ kind: "poison", campaign: "historical", day: pacificDay(f.clock.now()) });
});
it("DIAG initial probe retains a safe outer execution phase without raw exceptions", async () => {
  const f = await fixture(), id = randomUUID(), paths = probePaths(f.root, id);
  for (const dir of ["src", "scripts", "tests", ".next"]) await mkdir(path.join(f.root, dir), { recursive: true });
  for (const name of ["package.json", "package-lock.json", "tsconfig.json", "vitest.config.ts", "playwright.config.ts"])
    await writeFile(path.join(f.root, name), "offline diagnostic identity\n");
  await writeFile(path.join(f.root, ".next/BUILD_ID"), "diagnostic-fixture");
  const now = Date.now(), clock: SafetyClock = { now: () => now, monotonic: () => 0, sleep: async () => {} };
  await initializeQuota(paths.quota, { project: INITIAL_PROBE.project, day: pacificDay(now), knownUsed: 0, evidenceReference: "synthetic-only" });
  const manifest = await initializeProbe(f.root, id, { canonicalRoot: f.root, project: INITIAL_PROBE.project,
    model: INITIAL_PROBE.model, credentialReference: "fake-key-reference", operator: "offline-test" });
  const approval = { manifestHash: sha(manifest), day: pacificDay(now), quotaHead: (await new H2Journal(paths.quota).read()).at(-1)!.hash,
    quietSince: now - 901000, usageObservedAt: now - 1000, windowStart: now, windowEnd: now + 300000,
    knownPriorHttp: 0, laterExternalReservedHttp: 0, usageReference: "synthetic-only" };
  await writeFile(path.join(paths.evidence, "coordination.json"), JSON.stringify({ approvalHash: sha(approval), exclusive: true, unaccountedUse: false }));
  await expect(runInitialProbe(f.root, id, approval, async () => { throw new Error(secret); }, clock, f.transport)).rejects.toThrow("Initial probe stopped");
  const failedText = await readFile(path.join(paths.evidence, "failed.json"), "utf8");
  expect(JSON.parse(failedText)).toMatchObject({ status: "STOPPED_NOT_ACCEPTED", fullCampaignAccepted: false,
    diagnostic: { version: 1, phase: "PLANNER_EXECUTION" } });
  expect(failedText).not.toContain(secret); expect(f.transport).not.toHaveBeenCalled();
  expect(await readFile(path.join(paths.quota, "block.lock"), "utf8")).toContain("owner");
  expect(probeLimits.maxHttpRequests).toBe(3);
});
