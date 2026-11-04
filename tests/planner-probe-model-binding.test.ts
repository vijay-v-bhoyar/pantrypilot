import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { aiProposal } from "../src/lib/ai";
import { INITIAL_PROBE, GEMINI_36_PROBE, initializeProbe, probePaths, probePolicyForModel,
  readProbe, runInitialProbe, createProbePolicy } from "../scripts/lib/planner-probe";
import { initializeQuota, H2Journal, pacificDay, sha } from "../scripts/lib/planner-quota";
import { validateOwnerScope, inspectOwnerSubject, type OwnerScope } from "../scripts/owner-planner-runtime";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals(); vi.unstubAllEnvs();
  for (const root of roots.splice(0)) {
    expect(path.dirname(root)).toBe(path.resolve(os.tmpdir())); expect(path.basename(root)).toMatch(/^pp-model-binding-/);
    await rm(root, { recursive: true, force: true });
  }
});
it("preserves the legacy3.8policy hash and all caps for the explicit3.6variant", () => {
  expect(sha(INITIAL_PROBE)).toBe("d33f48e7ad0ef38d2443c701de99b0d44aa7abb389b191e0c5e0fe6a3c56e54b");
  expect(Object.isFrozen(INITIAL_PROBE)).toBe(true); expect(Object.isFrozen(GEMINI_36_PROBE)).toBe(true);
  const { id: oldId, model: oldModel, ...oldCaps } = INITIAL_PROBE;
  const { id: newId, model: newModel, ...newCaps } = GEMINI_36_PROBE;
  expect(newCaps).toEqual(oldCaps); expect(oldId).not.toBe(newId); expect(oldModel).toBe("gemini-3.8-flash");
  expect(newModel).toBe("gemini-3.6-flash"); expect(newCaps.pairs).toBe(3); expect(newCaps.http).toBe(6);
});
it.each(["", "unknown", "gemini-3.6-flash-latest", "gemini-4-argon"])("never defaults/falls back from unapproved model %s", model => {
  expect(() => probePolicyForModel(model)).toThrow();
});
async function fixture(model = GEMINI_36_PROBE.model) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pp-model-binding-")); roots.push(root);
  for (const dir of ["src", "scripts", "tests", ".next"]) await mkdir(path.join(root, dir));
  for (const file of ["package.json", "package-lock.json", "tsconfig.json", "vitest.config.ts", "playwright.config.ts"])
    await writeFile(path.join(root, file), "offline synthetic model binding\n");
  await writeFile(path.join(root, ".next/BUILD_ID"), "offline-model-build");
  const id = randomUUID(), paths = probePaths(root, id), now = Date.now();
  await initializeQuota(paths.quota, { project: INITIAL_PROBE.project, day: pacificDay(now), knownUsed: 0, evidenceReference: "offline-model-only" });
  const manifest = await initializeProbe(root, id, { canonicalRoot: root, project: INITIAL_PROBE.project, model,
    operator: "offline-owner", credentialReference: "offline-no-real-key" });
  const scope: OwnerScope = { version: 1, mode: "diagnostic", canonicalRoot: root, id, project: INITIAL_PROBE.project,
    model, operator: "offline-owner", credentialReference: "offline-no-real-key", sourceDigest: manifest.sourceDigest,
    buildId: manifest.buildId, manifestHash: sha(manifest), maxHttpRequests: 6, expiresAt: now + 300000,
    stageScriptSha256: "a".repeat(64), sourceInventorySha256: "b".repeat(64) };
  const approval = { manifestHash: sha(manifest), quotaHead: (await new H2Journal(paths.quota).read()).at(-1)!.hash,
    day: pacificDay(now), quietSince: now - 901000, usageObservedAt: now - 1000, windowStart: now, windowEnd: now + 300000,
    knownPriorHttp: 0, laterExternalReservedHttp: 0, usageReference: "offline-only" };
  await writeFile(path.join(paths.evidence, "coordination.json"), JSON.stringify({ approvalHash: sha(approval), exclusive: true, unaccountedUse: false }));
  return { root, id, paths, manifest, scope, approval };
}
it("binds the3.6manifest and owner scope without changing a default", async () => {
  const f = await fixture(); expect(f.manifest.policy).toEqual(GEMINI_36_PROBE);
  expect(() => validateOwnerScope(f.scope, f.root, Date.now())).not.toThrow();
  await expect(inspectOwnerSubject(f.scope, f.root)).resolves.toBeDefined();
  await expect(inspectOwnerSubject({ ...f.scope, model: INITIAL_PROBE.model }, f.root)).rejects.toThrow();
});
it.each(["policy", "model"])("refuses cross-model manifest %s drift before transport", async field => {
  const f = await fixture(), changed = structuredClone(f.manifest);
  if (field === "policy") changed.policy = INITIAL_PROBE; else changed.binding.model = INITIAL_PROBE.model;
  await writeFile(path.join(f.paths.evidence, "manifest.json"), JSON.stringify(changed));
  await expect(readProbe(f.root, f.id)).rejects.toThrow();
  const transport = vi.fn<typeof fetch>();
  await expect(createProbePolicy(f.root, changed, { ...f.approval, manifestHash: sha(changed) },
    new AbortController().signal, undefined, transport)).rejects.toThrow();
  expect(transport).not.toHaveBeenCalled();
});
it.each([200, 503])("installed SDK uses only explicit3.6endpoints and retains result semantics for HTTP%s", async status => {
  const f = await fixture(), initial = await readProbe(f.root, f.id);
  for (const [name, value] of Object.entries({ APP_ENV: "local", STORAGE_MODE: "local", PAYMENTS_MODE: "simulation",
    FINANCIAL_ACTIONS_ENABLED: "false", PROVIDER_ACTIONS_ENABLED: "true", AI_MODE: "gemini", VERCEL: "",
    GEMINI_API_KEY: "OFFLINE_ONLY_FAKE_PRIVATE_KEY", GEMINI_MODEL: GEMINI_36_PROBE.model,
    AI_MAX_HTTP_REQUESTS: "3", AI_MAX_INPUT_BYTES: "32768", AI_MAX_OUTPUT_TOKENS: "1024", AI_TIMEOUT_MS: "300000",
    PANTRYPILOT_DATA_DIR: f.paths.data })) vi.stubEnv(name, value);
  const selection = { catalogIds: initial.workspaces[1].catalog.map(item => item.id), reasoning: "offline", infeasible: false };
  const urls: string[] = [], base = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash";
  const transport = vi.fn<typeof fetch>().mockImplementation(async input => {
    const url = String(input); urls.push(url); expect([base + ":countTokens", base + ":generateContent"]).toContain(url);
    if (url.endsWith(":countTokens")) return Response.json({ totalTokens: 2 });
    if (status === 503) return Response.json({}, { status: 503 });
    return Response.json({ candidates: [{ content: { role: "model", parts: [{ text: JSON.stringify(selection) }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1, totalTokenCount: 4 } });
  });
  vi.stubGlobal("fetch", transport);
  const run = runInitialProbe(f.root, f.id, f.approval, (workspaceId, requestId, fixtureTime, shared, policy) =>
    aiProposal({ workspaceId, actorId: "owner-a", expiresAt: Date.now() + 100000, nonce: "offline-model" },
      requestId, shared, { fixtureTime, transportPolicy: policy }), undefined, transport);
  if (status === 200) { const receipt = await run; expect(receipt.status).toBe("INITIAL_FEASIBILITY_OBSERVED"); expect(receipt.fullCampaignAccepted).toBe(false); }
  else { await expect(run).rejects.toThrow(); await expect(readFile(path.join(f.paths.quota, "block.lock"))).resolves.toBeDefined(); }
  expect(urls).toEqual([base + ":countTokens", base + ":generateContent"]);
  expect((await new H2Journal(f.paths.quota).read()).filter(e => e.value.kind === "probe-http-attempt")).toHaveLength(2);
});
