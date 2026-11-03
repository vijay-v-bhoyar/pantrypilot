import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { seedWorkspace } from "../src/lib/seed";
import { evaluatePlannerCase, financialSnapshot } from "../scripts/lib/planner-evaluation";
import { campaignPaths, finalizeCampaign, initializeCampaign, readCampaign, runCampaignBlock,
  type CampaignBinding } from "../scripts/lib/planner-campaign";
import { H2, H2Journal, createH2Policy, initializeQuota, pacificDay, safeDirectory, sha, type SafetyClock } from "../scripts/lib/planner-quota";
import type { Workspace } from "../src/lib/types";
const roots: string[] = [];
afterEach(async () => { vi.unstubAllGlobals(); vi.useRealTimers(); for (const root of roots.splice(0)) {
  expect(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)).toBe(true);
  expect(path.basename(root).startsWith("pantrypilot-h2-campaign-")).toBe(true);
  await rm(root, { recursive: true, force: true });
} });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "pantrypilot-h2-campaign-")); roots.push(root);
  for (const dir of ["src", "scripts", "tests", ".next"]) await mkdir(path.join(root, dir));
  for (const file of ["package.json", "package-lock.json", "tsconfig.json", "vitest.config.ts", "playwright.config.ts"])
    await writeFile(path.join(root, file), "{}");
  await writeFile(path.join(root, ".next", "BUILD_ID"), "fixture-build");
  const id = randomUUID(), project = "gen-lang-client-0107804522";
  const limits = { maxHttpRequests: 10, maxInputBytes: 32768, maxOutputTokens: 1024, timeoutMs: 300000 };
  const binding: CampaignBinding = { model: "fixture-model", project, credentialReference: "fake-reference",
    operator: "synthetic-executor", limits, session: { ...limits, maxHttpRequests: 20 } };
  const workspace = seedWorkspace(); workspace.createdAt = "2026-10-27T12:00:00.000Z";
  vi.useFakeTimers(); vi.setSystemTime(Date.parse(workspace.createdAt));
  const manifest = await initializeCampaign(root, id, binding, workspace); vi.useRealTimers();
  const paths = campaignPaths(root, id, project);
  expect(manifest.cases.map((c) => c.requestId)).toHaveLength(12);
  expect(new Set(manifest.cases.map((c) => c.requestId)).size).toBe(12);
  expect(workspace.requests.every((r) => r.deadline === manifest.cases[0].deadline)).toBe(true);
  await initializeQuota(paths.quota, { project, day: "2026-10-27", knownUsed: 0, evidenceReference: "synthetic-origin" });
  let now = Date.parse(workspace.createdAt), elapsed = 0;
  const clock: SafetyClock = { now: () => now, monotonic: () => elapsed,
    sleep: async (ms, signal) => { signal.throwIfAborted(); now += ms; elapsed += ms; } };
  const advance = (ms: number) => { now += ms; elapsed += ms; };
  const approval = () => ({ manifestHash: sha(manifest), day: pacificDay(now), quotaReference: "synthetic-origin" });
  const run = (callback?: Parameters<typeof runCampaignBlock>[5]) => runCampaignBlock(root, id, project, binding,
    approval(), callback || (async (_manifest, caseId, assertActive, signal) => {
      const transport: typeof fetch = async (url) => String(url).endsWith(":countTokens") ?
        Response.json({ totalTokens: 1 }) : Response.json({ usageMetadata: { promptTokenCount: 2 } });
      const policy = createH2Policy({ root: paths.quota, project, campaign: id, caseId, model: binding.model,
        day: pacificDay(now), approvedDay: pacificDay(now), knownProjectUseReference: "synthetic-origin",
        signal, assertActive, clock, transport });
      const row = await evaluatePlannerCase(caseId - 1, async () => {
        await policy.dispatch({ modelId: binding.model, body: JSON.stringify({ contents: ["synthetic"] }), init: {},
          signal, send: () => transport("https://generativelanguage.googleapis.com/v1beta/models/fixture-model:generateContent") });
        return { source: "gemini", digest: "a".repeat(64), shortages: (caseId - 1) % 4 === 0 ? ["budget"] : [] };
      });
      return { infrastructureFailed: false, row };
    }), clock);
  return { root, id, project, binding, workspace, manifest, paths, clock, advance, approval, run };
}
it("IMP-T01/02 twelve separate days preserve cases, original verdict and immutable evidence", async () => {
  const f = await fixture(); vi.stubGlobal("fetch", vi.fn(() => { throw new Error("UNEXPECTED_EGRESS"); }));
  await expect(finalizeCampaign(f.root, f.id, f.project)).rejects.toThrow();
  // An incomplete finalize preserves its lock; explicit reviewed recovery is required, never auto-unlock.
  // Use a separate intact campaign for the successful completion path.
  const good = await fixture();
  for (let day = 0; day < 12; day++) { if (day) good.advance(86400000);
    const finish = await good.run(); expect(finish.caseId).toBe(day + 1); expect(finish.row.status).toBe("PASS"); }
  const final = await finalizeCampaign(good.root, good.id, good.project);
  expect(final.accepted).toBe(true); expect(final.rows).toHaveLength(12);
  expect(final.sideEffectsUnchanged).toBe(true); expect(final.infrastructureFailed).toBe(false);
  expect(final.quota.countCalls).toBe(12); expect(final.quota.generationCalls).toBe(12);
  expect(final.quota.httpReserved).toBe(24);
  await expect(finalizeCampaign(good.root, good.id, good.project)).rejects.toThrow();
  expect(globalThis.fetch).not.toHaveBeenCalled();
});
it("IMP-T02 no second case/day, no reordering or partial accepted result", async () => {
  const f = await fixture(); await f.run();
  await expect(f.run()).rejects.toThrow();
  const progress = await readCampaign(f.root, f.id, f.project);
  expect(progress.outcomes.map((o) => o.row.case)).toEqual([1]);
  expect(progress.outcomes[0].row.status).toBe("PASS");
});
it.each(["ledger", "orders", "donations", "recoveries", "inventory", "distributions", "approvals"] as const)(
  "IMP-T03 protects original financial array %s between blocks", async (field) => {
    const f = await fixture(); await f.run();
    const file = path.join(f.paths.data, `${f.workspace.id}.json`);
    const data = JSON.parse(await readFile(file, "utf8")) as Workspace;
    (data[field] as unknown[]).push({ marker: "changed" }); await writeFile(file, JSON.stringify(data));
    expect(financialSnapshot(data)).not.toBe(f.manifest.initialFinancial);
    await expect(readCampaign(f.root, f.id, f.project)).rejects.toThrow();
  });
it("IMP-T14 rejects source, model/config/manifest and build drift before a callback", async () => {
  const f = await fixture(), execute = vi.fn();
  await writeFile(path.join(f.root, "src", "changed.ts"), "export const changed = true;");
  await expect(runCampaignBlock(f.root, f.id, f.project, f.binding, f.approval(), execute, f.clock)).rejects.toThrow();
  expect(execute).not.toHaveBeenCalled();
  const other = await fixture();
  const file = path.join(other.paths.evidence, "manifest.json");
  await writeFile(file, JSON.stringify({ ...other.manifest, policy: { ...H2, days: 6 } }));
  await expect(readCampaign(other.root, other.id, other.project)).rejects.toThrow();
});
it("IMP-T15 crash after a case-start marker retains lock and prevents replay", async () => {
  const f = await fixture(); const callback = vi.fn(async () => { throw new Error("uncertain mutation"); });
  await expect(f.run(callback)).rejects.toThrow(); await expect(f.run()).rejects.toThrow();
  await expect(readCampaign(f.root, f.id, f.project)).rejects.toThrow();
  expect(callback).toHaveBeenCalledTimes(1);
  const events = await new H2Journal(f.paths.evidence).read();
  expect(events.at(-1)?.value.kind).toBe("started");
});
it("IMP-T15 sticky infrastructure outcomes cannot continue or become partial success", async () => {
  const f = await fixture(); await f.run(async (_manifest, caseId) => ({ row: { case: caseId, status: "FAIL" },
    infrastructureFailed: true })); f.advance(86400000);
  await expect(f.run()).rejects.toThrow();
  expect((await readCampaign(f.root, f.id, f.project)).outcomes[0].infrastructureFailed).toBe(true);
});
it("IMP-T16 preserves existing targets and rejects traversal and linked ancestry", async () => {
  const f = await fixture();
  await expect(initializeCampaign(f.root, f.id, f.binding, f.workspace)).rejects.toThrow();
  expect(() => campaignPaths(f.root, "../../escape", f.project)).toThrow();
  const linked = path.join(f.root, "linked"); await symlink(f.paths.data, linked, "junction");
  await expect(safeDirectory(linked)).rejects.toThrow();
  expect(sha(await readFile(path.join(f.paths.evidence, "manifest.json"), "utf8"))).toMatch(/^[a-f0-9]{64}$/);
});
it("IMP-T06/12 quota-day crossing, near-midnight start and elapsed block deadline refuse", async () => {
  const f = await fixture(); f.advance(Date.parse("2026-10-28T06:59:00Z") - f.clock.now());
  const callback = vi.fn(); await expect(f.run(callback)).rejects.toThrow(); expect(callback).not.toHaveBeenCalled();
  const expired = await fixture(); await expect(expired.run(async (_manifest, _caseId, active) => {
    expired.advance(300001); active(); throw new Error("unreachable");
  })).rejects.toThrow();
});
