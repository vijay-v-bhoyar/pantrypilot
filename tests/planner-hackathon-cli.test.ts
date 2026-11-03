import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { hackathonMain, H3_REFUSAL } from "../scripts/hackathon-eval";
import { initializeHackathon } from "../scripts/lib/planner-hackathon";
import { initializeQuota, pacificDay } from "../scripts/lib/planner-quota";
import { campaignPaths } from "../scripts/lib/planner-campaign";
import { seedWorkspace } from "../src/lib/seed";

const roots: string[] = [];
afterEach(async () => { vi.useRealTimers(); vi.unstubAllGlobals(); for (const root of roots.splice(0)) {
  expect(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)).toBe(true);
  expect(path.basename(root).startsWith("pp-h3-cli-")).toBe(true);
  await rm(root, { recursive: true, force: true });
} });
function protectedEnv(values: NodeJS.ProcessEnv = { NODE_ENV: "test" }) {
  const reads = vi.fn();
  const env = new Proxy(values, { get(target, key: string) {
    if (key === "GEMINI_API_KEY") { reads(); throw new Error("KEY_MUST_NOT_BE_READ"); }
    return target[key];
  } });
  return { env, reads };
}
it.each([[], ["legacy"], ["run-block"], ["status", "../../escape", "synthetic-project"],
  ["init", "unapproved.json"], ["run-block", randomUUID(), "synthetic-project", "missing-grant.json"]].map(args => [args]))(
  "H3CLIinvalid/unapproved%jdoes not read key or send", async args => {
    const { env, reads } = protectedEnv(); const output = vi.fn();
    const fetch = vi.fn(() => { throw new Error("NO_EGRESS"); }); vi.stubGlobal("fetch", fetch);
    expect(await hackathonMain(args, { env, output })).toBe(1);
    expect(output).toHaveBeenCalledWith(H3_REFUSAL); expect(reads).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
it.each(["RUN_H3_EVAL", "APP_ENV", "STORAGE_MODE", "PAYMENTS_MODE", "PROVIDER_ACTIONS_ENABLED", "FINANCIAL_ACTIONS_ENABLED", "AI_MODE", "VERCEL"])(
  "H3CLIrefuses incorrect%sprofile before credentials", async key => {
    const values: NodeJS.ProcessEnv = { NODE_ENV: "test", RUN_H3_EVAL: "true", APP_ENV: "local", STORAGE_MODE: "local",
      PAYMENTS_MODE: "simulation", PROVIDER_ACTIONS_ENABLED: "true", FINANCIAL_ACTIONS_ENABLED: "false", AI_MODE: "gemini" };
    values[key] = "wrong";
    const { env, reads } = protectedEnv(values), output = vi.fn();
    expect(await hackathonMain(["run-block", randomUUID(), "synthetic-project", "absent.json"], { env, output })).toBe(1);
    expect(reads).not.toHaveBeenCalled();
  });
it("H3CLIstatus and incomplete finalize remain credential-free; no full acceptance", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pp-h3-cli-")); roots.push(root);
  for (const dir of ["src", "scripts", "tests", ".next"]) await mkdir(path.join(root, dir));
  for (const n of ["package.json", "package-lock.json", "tsconfig.json", "vitest.config.ts", "playwright.config.ts"])
    await writeFile(path.join(root, n), "{}");
  await writeFile(path.join(root, ".next/BUILD_ID"), "synthetic");
  const id = randomUUID(), project = "synthetic-project", paths = campaignPaths(root, id, project);
  const now = Date.parse("2026-11-03T16:00:00Z");
  await initializeQuota(paths.quota, { project, day: pacificDay(now), knownUsed: 0, evidenceReference: "synthetic" });
  const limits = { maxHttpRequests: 6, maxInputBytes: 32768, maxOutputTokens: 1024, timeoutMs: 300000 };
  vi.useFakeTimers(); vi.setSystemTime(now);
  await initializeHackathon(root, id, { project, model: "synthetic-model", operator: "synthetic-owner",
    credentialReference: "fake-key-reference", limits, session: { ...limits, maxHttpRequests: 20 } }, seedWorkspace());
  vi.useRealTimers();
  const { env, reads } = protectedEnv(), output = vi.fn();
  expect(await hackathonMain(["status", id, project], { root, env, output })).toBe(0);
  expect(JSON.parse(output.mock.calls[0][0])).toMatchObject({ completed: 0, total: 12, fullCampaignAccepted: false });
  expect(await hackathonMain(["finalize", id, project], { root, env, output })).toBe(1);
  expect(reads).not.toHaveBeenCalled();
});
