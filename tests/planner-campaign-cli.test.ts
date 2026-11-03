import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
const run = promisify(execFile);
const env = (): NodeJS.ProcessEnv => ({ NODE_ENV: "test", ...Object.fromEntries(
  ["SystemRoot", "WINDIR", "SystemDrive", "ComSpec", "PATH", "PATHEXT", "TEMP", "TMP"]
    .flatMap((key) => process.env[key] ? [[key, process.env[key]!]] : [])) });
it.each([[], ["--case", "1"], ["--retry-case", "1"], ["--reset-quota"], ["--accept-partial"],
  ["run-block", "invalid-id", "invalid-project"], ["status", "../escape", "project"]].map((args) => ({ args })))(
  "IMP-T17/18 scrubbed CLI refuses invalid/legacy admission %j without secrets, env loading or mutations", async ({ args }) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pantrypilot-h2-cli-"));
    try {
      await writeFile(path.join(root, ".env.local"), "GEMINI_API_KEY=PRIVATE_ENV_FILE_SENTINEL\n");
      const cli = path.resolve("scripts/live-eval.ts"), loader = pathToFileURL(path.resolve("node_modules/tsx/dist/loader.mjs")).href;
      const error = await run(process.execPath, ["--import", loader, cli, ...args], { cwd: root, env: env(), timeout: 10000 })
        .then(() => null, (failure: { code: number; stdout: string; stderr: string }) => failure);
      expect(error).not.toBeNull(); expect(error!.code).toBe(1); expect(error!.stderr).toBe("");
      expect(error!.stdout).toContain("No provider request was sent");
      expect(error!.stdout).not.toContain("PRIVATE_ENV_FILE_SENTINEL");
      expect(await readdir(root)).toEqual([".env.local"]);
    } finally {
      const resolved = path.resolve(root);
      expect(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)).toBe(true);
      expect(path.basename(resolved).startsWith("pantrypilot-h2-cli-")).toBe(true);
      await rm(resolved, { recursive: true, force: true });
    }
  });
it("IMP-T05 separate Node processes cannot concurrently own one project lock", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pantrypilot-h2-cli-"));
  const quota = path.join(root, "quota"); await mkdir(quota);
  const loader = pathToFileURL(path.resolve("node_modules/tsx/dist/loader.mjs")).href;
  const quotaModuleUrl = pathToFileURL(path.resolve("scripts/lib/planner-quota.ts")).href;
  const firstCode = `import {withProjectLock} from ${JSON.stringify(quotaModuleUrl)};
    await withProjectLock(${JSON.stringify(quota)}, async()=>{
      process.stdout.write('LOCKED\\n'); await new Promise(resolve=>process.stdin.once('data',resolve));
    });`;
  const first = spawn(process.execPath, ["--import", loader, "--input-type=module", "--eval", firstCode],
    { cwd: root, env: env(), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const ended = new Promise<number | null>((resolve, reject) => { first.once("close", resolve); first.once("error", reject); });
  try {
    await new Promise<void>((resolve, reject) => { first.stdout.once("data", (data: Buffer) =>
      data.toString().includes("LOCKED") ? resolve() : reject(new Error("Unexpected child output")));
    first.once("error", reject); first.once("exit", () => reject(new Error("Child stopped before lock handoff"))); });
    const secondCode = `import {withProjectLock} from ${JSON.stringify(quotaModuleUrl)};
      try { await withProjectLock(${JSON.stringify(quota)},async()=>process.stdout.write('BYPASS')); }
      catch { process.stdout.write('REFUSED'); process.exitCode=1; }`;
    const second = await run(process.execPath, ["--import", loader, "--input-type=module", "--eval", secondCode],
      { cwd: root, env: env(), timeout: 5000 }).then(() => null,
      (error: { code: number; stdout: string }) => error);
    expect(second?.code).toBe(1); expect(second?.stdout).toBe("REFUSED");
    first.stdin.end("release"); expect(await ended).toBe(0);
  } finally {
    if (first.exitCode === null) { first.kill(); await ended; }
    expect(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)).toBe(true);
    expect(path.basename(root).startsWith("pantrypilot-h2-cli-")).toBe(true);
    await rm(root, { recursive: true, force: true });
  }
});
