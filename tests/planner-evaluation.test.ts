import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, mkdir, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { comparePlannerBaseline, evaluatePlannerCase, evaluationFailure, reserveEvaluationDirectories, writeEvaluationReceipt,
  evaluationConfigDigest } from "../scripts/lib/planner-evaluation";

it("compares exact cents and feasibility without calling a model or claiming savings for infeasible baskets", () => {
  const baseline = { source: "deterministic" as const, digest: "a".repeat(64), total: 35200, shortages: [] as string[] };
  const candidate = { ...baseline, source: "gemini" as const, digest: "b".repeat(64), total: 36000 };
  expect(comparePlannerBaseline(baseline, candidate)).toMatchObject({ baselineTotalCents: 35200,
    candidateTotalCents: 36000, comparableCostDeltaCents: 800, feasibilityMatches: true });
  expect(comparePlannerBaseline(baseline, { ...candidate, total: 34000 }).comparableCostDeltaCents).toBe(-1200);
  expect(comparePlannerBaseline(baseline, { ...candidate, shortages: ["budget"] })).toMatchObject({
    feasibilityMatches: false, comparableCostDeltaCents: null });
  expect(() => comparePlannerBaseline(baseline, { ...candidate, total: 1.5 })).toThrow();
  expect(() => comparePlannerBaseline(baseline, { ...candidate, source: "deterministic" })).toThrow();
});

it.each([new Error("PRIVATE_EXCEPTION_TOKEN"), "PRIVATE_EXCEPTION_TOKEN", { raw: "PRIVATE_EXCEPTION_TOKEN" }])("redacts arbitrary evaluation failures", async (failure) => {
  const row = await evaluatePlannerCase(0, async () => { throw failure; });
  expect(row).toEqual({ case: 1, status: "FAIL", error: evaluationFailure });
  expect(JSON.stringify(row)).not.toContain("PRIVATE_EXCEPTION_TOKEN");
});
it.each([undefined, null, {}, { source: "manual", digest: "a".repeat(64), shortages: [] },
  { source: "gemini", digest: "raw-private-diagnostic", shortages: [] }])("never reports invalid/unavailable/fallback output as success", async (result) => {
  expect((await evaluatePlannerCase(1, async () => result)).status).toBe("FAIL");
});
it("keeps positive and infeasibility oracles, including wrong negative answers", async () => {
  const proposal = { source: "gemini", digest: "a".repeat(64), shortages: [] };
  expect((await evaluatePlannerCase(1, async () => proposal)).status).toBe("PASS");
  expect((await evaluatePlannerCase(0, async () => proposal)).status).toBe("FAIL");
  expect((await evaluatePlannerCase(0, async () => ({ ...proposal, shortages: ["budget"] }))).status).toBe("PASS");
  expect((await evaluatePlannerCase(1, async () => ({ ...proposal, shortages: ["budget"] }))).status).toBe("FAIL");
});
it("binds approval to model and every per-run/session limit", () => {
  const limits = { maxHttpRequests: 2, maxInputBytes: 32768, maxOutputTokens: 512, timeoutMs: 60000 };
  const original = evaluationConfigDigest("fixture", limits, limits);
  expect(original).toMatch(/^[a-f0-9]{64}$/);
  expect(evaluationConfigDigest("other", limits, limits)).not.toBe(original);
  for (const key of Object.keys(limits) as (keyof typeof limits)[]) {
    expect(evaluationConfigDigest("fixture", { ...limits, [key]: 1 }, limits)).not.toBe(original);
    expect(evaluationConfigDigest("fixture", limits, { ...limits, [key]: 1 })).not.toBe(original);
  }
});
it("reserves fresh run evidence and never overwrites original receipts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pantrypilot-eval-evidence-"));
  try {
    const id = randomUUID(); const a = await reserveEvaluationDirectories(root, id);
    await writeEvaluationReceipt(a.evidence, { marker: "original" });
    await expect(writeEvaluationReceipt(a.evidence, { marker: "replacement" })).rejects.toMatchObject({ code: "EEXIST" });
    await expect(reserveEvaluationDirectories(root, id)).rejects.toMatchObject({ code: "EEXIST" });
    const b = await reserveEvaluationDirectories(root, randomUUID());
    expect(a.evidence).not.toBe(b.evidence);
    expect(JSON.parse(await readFile(path.join(a.evidence, "receipt.json"), "utf8"))).toEqual({ marker: "original" });
    await expect(reserveEvaluationDirectories(root, "../../escape")).rejects.toThrow("UUID");
  } finally { await rm(root, { recursive: true, force: true }); }
});
it("refuses linked evaluation directory ancestry", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pantrypilot-eval-link-"));
  try {
    await mkdir(path.join(root, "external"));
    await symlink(path.join(root, "external"), path.join(root, "output"), "junction");
    await expect(reserveEvaluationDirectories(root, randomUUID())).rejects.toThrow("isolated directories");
  } finally { await rm(root, { recursive: true, force: true }); }
});
