import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { evaluationConfigDigest } from "../scripts/lib/planner-evaluation";
import { expect, it } from "vitest";

const run = promisify(execFile);
it.each([undefined, "   "])("live evaluation refuses model %s before creating a workspace", async (model) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pantrypilot-model-eval-"));
  const env = { ...process.env, APP_ENV: "local", VERCEL: "", STORAGE_MODE: "local",
    AI_MODE: "gemini", PROVIDER_ACTIONS_ENABLED: "true", RUN_LIVE_EVAL: "true",
    PAYMENTS_MODE: "simulation", FINANCIAL_ACTIONS_ENABLED: "false",
    AI_MAX_HTTP_REQUESTS: "2", AI_MAX_INPUT_BYTES: "32768", AI_MAX_OUTPUT_TOKENS: "512", AI_TIMEOUT_MS: "60000",
    GEMINI_API_KEY: "test-only-never-a-real-key", PANTRYPILOT_DATA_DIR: root,
    GEMINI_MODEL: model,
  };
  if (model === undefined) delete env.GEMINI_MODEL;
  try {
    const failure = await run(process.execPath, ["--import", "tsx", "scripts/live-eval.ts"], {
      cwd: process.cwd(), env, timeout: 10000,
    }).then(() => null, (error: { code: number; stdout: string; stderr: string }) => error);
    expect(failure).not.toBeNull();
    expect(failure!.code).toBe(1);
    expect(failure!.stdout).toContain("explicit qualified model");
    expect(failure!.stdout).toContain("No provider request was sent");
    expect(failure!.stderr).toBe("");
    expect(await readdir(root)).toEqual([]);
  } finally {
    const tempBase = path.resolve(os.tmpdir()) + path.sep;
    const resolved = path.resolve(root);
    if (!resolved.startsWith(tempBase) || !path.basename(resolved).startsWith("pantrypilot-model-eval-")) {
      throw new Error("Refusing cleanup outside the dedicated test temporary directory.");
    }
    await rm(resolved, { recursive: true, force: true });
  }
});
it.each([
  { RUN_LIVE_EVAL: "false" }, { APP_ENV: "hosted" }, { STORAGE_MODE: "supabase" },
  { PAYMENTS_MODE: "sandbox" }, { FINANCIAL_ACTIONS_ENABLED: "true" },
  { PROVIDER_ACTIONS_ENABLED: "false" }, { AI_MODE: "manual" },
  { AI_MAX_HTTP_REQUESTS: "" }, { EVAL_MAX_HTTP_REQUESTS: "121" },
  { EVAL_APPROVED_CONFIG_SHA256: "changed-budget" }, { PANTRYPILOT_DATA_DIR: ".data" },
])("blocks unsafe evaluation admission without writes or diagnostic output: %j", async (override) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pantrypilot-eval-admission-"));
  const cli = path.resolve("scripts/live-eval.ts");
  const tsx = pathToFileURL(path.resolve("node_modules/tsx/dist/loader.mjs")).href;
  const runId = randomUUID();
  const limits = { maxHttpRequests: 2, maxInputBytes: 32768, maxOutputTokens: 512, timeoutMs: 60000 };
  const env = { ...process.env, APP_ENV: "local", VERCEL: "", STORAGE_MODE: "local",
    AI_MODE: "gemini", PROVIDER_ACTIONS_ENABLED: "true", RUN_LIVE_EVAL: "true",
    PAYMENTS_MODE: "simulation", FINANCIAL_ACTIONS_ENABLED: "false",
    GEMINI_API_KEY: "fake-key-PRIVATE_DIAGNOSTIC", GEMINI_MODEL: "fixture-model",
    NEXT_PUBLIC_SUPABASE_URL: "", SUPABASE_SERVICE_ROLE_KEY: "", PAYPAL_MERCHANTS_JSON: "",
    AI_MAX_HTTP_REQUESTS: "2", AI_MAX_INPUT_BYTES: "32768", AI_MAX_OUTPUT_TOKENS: "512", AI_TIMEOUT_MS: "60000",
    EVAL_MAX_HTTP_REQUESTS: "12", EVAL_RUN_ID: runId,
    EVAL_APPROVED_CONFIG_SHA256: evaluationConfigDigest("fixture-model", limits, { ...limits, maxHttpRequests: 12 }),
    PANTRYPILOT_DATA_DIR: path.join(root, ".data", "ai-evals", runId),
    ...override,
  };
  try {
    const failure = await run(process.execPath, ["--import", tsx, cli], {
      cwd: root, env, timeout: 10000,
    }).then(() => null, (error: { code: number; stdout: string; stderr: string }) => error);
    expect(failure).not.toBeNull(); expect(failure!.code).toBe(1);
    expect(failure!.stderr).toBe("");
    expect(failure!.stdout).toContain("No provider request was sent");
    expect(failure!.stdout).not.toContain("PRIVATE_DIAGNOSTIC");
    expect(await readdir(root)).toEqual([]);
  } finally {
    const resolved = path.resolve(root);
    if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(resolved).startsWith("pantrypilot-eval-admission-"))
      throw new Error("Refusing cleanup outside the dedicated test directory.");
    await rm(resolved, { recursive: true, force: true });
  }
});
