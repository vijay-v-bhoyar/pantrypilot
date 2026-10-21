import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { ensure } from "../../src/lib/errors";
import type { ModelLimits } from "../../src/lib/model-budget";
import type { Proposal } from "../../src/lib/types";

type ComparedPlan = Pick<Proposal, "source" | "digest" | "total" | "shortages">;
export function comparePlannerBaseline(baseline: ComparedPlan, candidate: ComparedPlan) {
  for (const plan of [baseline, candidate]) ensure(
    /^[a-f0-9]{64}$/.test(plan.digest) && Number.isSafeInteger(plan.total) && plan.total >= 0 && Array.isArray(plan.shortages),
    "EVAL_OUTPUT", "Comparison requires validated cents, digests and feasibility.");
  ensure(baseline.source === "deterministic" && candidate.source === "gemini",
    "EVAL_OUTPUT", "Comparison requires independent deterministic and Gemini proposals.");
  const baselineFeasible = baseline.shortages.length === 0;
  const candidateFeasible = candidate.shortages.length === 0;
  const delta = candidate.total - baseline.total;
  ensure(Number.isSafeInteger(delta), "EVAL_OUTPUT", "Comparison cents are out of range.");
  return { baselineDigest: baseline.digest, candidateDigest: candidate.digest,
    baselineTotalCents: baseline.total, candidateTotalCents: candidate.total,
    baselineFeasible, candidateFeasible, feasibilityMatches: baselineFeasible === candidateFeasible,
    // Null prevents an infeasible basket being advertised as a cost saving.
    comparableCostDeltaCents: baselineFeasible && candidateFeasible ? delta : null };
}

export const evaluationFailure = Object.freeze({
  code: "EVAL_CASE_FAILED",
  message: "The model case could not complete. No successful result is claimed.",
});
export type EvaluationRow = {
  case: number; status: "PASS" | "FAIL" | "BLOCKED";
  source?: "gemini"; digest?: string;
  error?: typeof evaluationFailure;
  comparison?: ReturnType<typeof comparePlannerBaseline>;
};
export function evaluationConfigDigest(model: string, limits: ModelLimits, session: ModelLimits) {
  return createHash("sha256").update(JSON.stringify({ model, limits, session })).digest("hex");
}
export async function evaluatePlannerCase(index: number, execute: () => Promise<unknown>): Promise<EvaluationRow> {
  try {
    const result = await execute() as { source?: unknown; digest?: unknown; shortages?: unknown } | null;
    ensure(result?.source === "gemini" && typeof result.digest === "string" &&
      /^[a-f0-9]{64}$/.test(result.digest) && Array.isArray(result.shortages),
      "EVAL_OUTPUT", "The model case did not return a validated proposal.");
    const impossible = index % 4 === 0;
    return { case: index + 1, status: Boolean(result.shortages.length) === impossible ? "PASS" : "FAIL",
      source: "gemini", digest: result.digest };
  } catch {
    return { case: index + 1, status: "FAIL", error: evaluationFailure };
  }
}
// Reject existing targets and symlink ancestry before reserving a run.
export async function reserveEvaluationDirectories(root: string, runId: string) {
  ensure(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(runId), "EVAL_CONFIG", "Use a fresh evaluation run UUID.");
  const reserve = async (parts: string[]) => {
    let current = path.resolve(root);
    for (const [index, part] of parts.entries()) {
      current = path.join(current, part);
      if (index === parts.length - 1) { await mkdir(current); continue; }
      await mkdir(current).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
      const info = await lstat(current);
      ensure(info.isDirectory() && !info.isSymbolicLink(), "EVAL_CONFIG", "Evaluation directories must be local isolated directories.");
    }
    return current;
  };
  const evidence = await reserve(["output", "live-evals", runId]);
  const data = await reserve([".data", "ai-evals", runId]);
  return { evidence, data };
}
export async function writeEvaluationReceipt(directory: string, receipt: unknown) {
  await writeFile(path.join(directory, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" });
}
export async function evaluationSourceDigest(root: string) {
  const files = ["package.json", "package-lock.json", "tsconfig.json"];
  const visit = async (relative: string) => {
    for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
      ensure(!entry.isSymbolicLink(), "EVAL_CONFIG", "Evaluation source must not contain linked files.");
      const file = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await visit(file);
      else if (/\.tsx?$/.test(entry.name)) files.push(file);
    }
  };
  await visit("src"); await visit("scripts");
  const digest = createHash("sha256");
  for (const file of files.sort()) digest.update(file + "\0").update(await readFile(path.join(root, file)));
  return digest.digest("hex");
}
