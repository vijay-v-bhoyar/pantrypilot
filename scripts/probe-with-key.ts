import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { admitProbeRuntimeSettings, readProbe, validateProbeApproval,
  INITIAL_PROBE, type ProbeApproval } from "./lib/planner-probe";
import { h2Assert, readRecord, safetyClock } from "./lib/planner-quota";
import { readHiddenProbeKey, probeChildEnvironment,
  type HiddenInput, type HiddenOutput } from "./lib/probe-key-input";

/** Run-only owner launcher. Does not initialize, supply approvals or load dotenv. */
export async function runKeyedProbe(args: string[], input: HiddenInput = process.stdin,
  output: HiddenOutput = process.stderr, parent: NodeJS.ProcessEnv = process.env) {
  const root = process.cwd(), scriptRoot = fileURLToPath(new URL("../", import.meta.url));
  h2Assert(path.resolve(root) === path.resolve(scriptRoot) && args.length === 2 &&
    /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(args[0]) && args[1].endsWith(".json") &&
    !Object.hasOwn(parent, "GEMINI_API_KEY"));
  // The unchanged child independently validates process.env and all original dispatch guards again.
  h2Assert(parent === process.env);
  const { manifest } = await readProbe(root, args[0]);
  const approval = await readRecord<ProbeApproval>(path.resolve(args[1]));
  admitProbeRuntimeSettings(root, manifest, approval);
  validateProbeApproval(manifest, approval, safetyClock);
  let key = await readHiddenProbeKey(input, output);
  let env: NodeJS.ProcessEnv | undefined;
  try {
    // Owner entry consumes time: refuse if the measured usage/window became stale while typing.
    validateProbeApproval(manifest, approval, safetyClock);
    admitProbeRuntimeSettings(root, manifest, approval);
    env = probeChildEnvironment(parent, key);
    return await new Promise<number>((resolve) => {
      const child = spawn(process.execPath, ["--import", "tsx", path.join(root, "scripts", "planner-probe.ts"),
        "run", args[0], path.resolve(args[1])], { cwd: root, env, shell: false, windowsHide: true,
        // Existing CLI persists its bounded evidence; discard streams to prevent secret diagnostics escaping.
        stdio: ["ignore", "ignore", "ignore"], timeout: INITIAL_PROBE.windowMs + 1000 });
      child.once("error", () => resolve(1));
      child.once("close", (code) => resolve(Number.isInteger(code) && code !== null && code >= 0 && code <= 255 ? code : 1));
    });
  } finally {
    if (env) delete env.GEMINI_API_KEY;
    key = "";
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  runKeyedProbe(process.argv.slice(2)).then((code) => {
    console.log(JSON.stringify({ status: "PROBE_PROCESS_EXITED", code,
      qualification: "Not inferred from exit status. Inspect the preserved probe evidence; no automatic retry." }));
    process.exitCode = code;
  }).catch(() => {
    console.log("Key entry or probe launch refused/stopped. Preserve evidence and reconcile before another attempt.");
    process.exitCode = 1;
  });
}
