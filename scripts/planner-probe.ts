import path from "node:path";
import { fileURLToPath } from "node:url";
import { aiProposal } from "../src/lib/ai";
import { admitProbeRuntime, initializeProbe, readProbe, runInitialProbe,
  type ProbeApproval, type ProbeBinding } from "./lib/planner-probe";
import { h2Assert, readRecord, sha, type QuotaOrigin } from "./lib/planner-quota";

async function main(args: string[]) {
  const root = process.cwd();
  h2Assert(path.resolve(root) === path.resolve(fileURLToPath(new URL("../", import.meta.url))));
  if (args[0] === "init") {
    h2Assert(args.length === 2 && args[1].endsWith(".json"));
    const input = await readRecord<{ id: string; binding: ProbeBinding; quotaOrigin?: QuotaOrigin }>(path.resolve(args[1]));
    h2Assert(Object.keys(input).every((key) => ["id", "binding", "quotaOrigin"].includes(key)));
    const manifest = await initializeProbe(root, input.id, input.binding, input.quotaOrigin);
    console.log(JSON.stringify({ status: "INITIALIZED_NOT_EXECUTED", id: manifest.id,
      manifestHash: sha(manifest), sourceDigest: manifest.sourceDigest, buildId: manifest.buildId,
      fullCampaignAccepted: false })); return;
  }
  h2Assert(args.length === 3 && args[0] === "run" && args[2].endsWith(".json"));
  const { manifest } = await readProbe(root, args[1]);
  const approval = await readRecord<ProbeApproval>(path.resolve(args[2]));
  admitProbeRuntime(root, manifest, approval);
  const result = await runInitialProbe(root, args[1], approval, async (workspaceId, requestId, fixtureTime, shared, policy) =>
    aiProposal({ workspaceId, actorId: "owner-a", expiresAt: Date.now() + 100000, nonce: "initial-probe" },
      requestId, shared, { fixtureTime, transportPolicy: policy }));
  console.log(JSON.stringify(result));
}
main(process.argv.slice(2)).catch(() => {
  console.log("Initial probe refused or stopped. No successful result is claimed; preserve existing evidence and project lock.");
  process.exitCode = 1;
});
