import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { createWorkspace, loadWorkspace, withWorkspace } from "../src/lib/storage";
import { seedWorkspace } from "../src/lib/seed";
import { execute } from "../src/lib/commands";
import { AppError } from "../src/lib/errors";

// Explicit operator invocation only. No payment/model activation or permanent mode change.
const ref = process.env.SUPABASE_QUALIFICATION_PROJECT_REF || "";
assert.equal(process.env.RUN_SUPABASE_QUALIFICATION, "true");
assert.match(ref, /^[a-z]{20}$/);
assert.equal(process.env.NEXT_PUBLIC_SUPABASE_URL, `https://${ref}.supabase.co`);
assert.equal(process.env.APP_ENV, "local");
assert.equal(process.env.PAYMENTS_MODE, "simulation");
assert.equal(process.env.AI_MODE, "manual");
assert.equal(process.env.PROVIDER_ACTIONS_ENABLED, "false");
assert.ok(process.env.SUPABASE_SERVICE_ROLE_KEY);
process.env.STORAGE_MODE = "supabase";

const readId = process.argv[2] === "--read" ? process.argv[3] : undefined;
if (readId) {
  assert.match(readId, /^[0-9a-f-]{36}$/);
  const state = await loadWorkspace(readId);
  assert.equal(state.ownerId, `qualification:${readId}`);
  assert.equal(state.revision, Number(process.argv[4]));
  assert.equal(state.organizations[0].sites.length, Number(process.argv[5]));
  console.log("Independent process readback: PASS");
} else {
  const id = randomUUID();
  const owner = `qualification:${id}`;
  const service = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const browser = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false } });
  let phase = "create";
  try {
    await createWorkspace(seedWorkspace(id, owner));
    assert.equal((await loadWorkspace(id)).revision, 0);
    console.log("App create/load via Supabase Data API: PASS");
    phase = "mutation and independent readback";
    await withWorkspace(id, (state) => execute(state, "owner-a", "site", { name: "Qualification site" }, randomUUID()));
    await Promise.all(Array.from({ length: 8 }, (_, index) => withWorkspace(id, (state) => execute(state, "owner-a", "site", { name: `Concurrent fixture ${index}` }, randomUUID()))));
    const state = await loadWorkspace(id);
    assert.equal(state.revision, 9);
    assert.equal(state.organizations[0].sites.length, 11);
    const independent = await promisify(execFile)(process.execPath, ["--import", "tsx", "--env-file-if-exists=.env.local", fileURLToPath(import.meta.url), "--read", id, "9", "11"], { env: process.env, timeout: 30000 });
    assert.equal(independent.stdout.trim(), "Independent process readback: PASS");
    console.log("Leased app mutation, eight serialized updates and independent process readback: PASS");
    phase = "rollback and duplicate prevention";
    await assert.rejects(withWorkspace(id, (draft) => { draft.ledger = []; throw new Error("qualification rollback"); }), /qualification rollback/);
    assert.equal((await loadWorkspace(id)).revision, 9);
    assert.equal((await loadWorkspace(id)).ledger.length, state.ledger.length);
    await assert.rejects(createWorkspace(seedWorkspace(id, owner)), (error: unknown) => error instanceof AppError && error.code === "PERSISTENCE");
    console.log("Failed mutation rollback and duplicate creation denial: PASS");
    phase = "browser isolation";
    const direct = await browser.from("workspaces").select("payload").eq("id", id);
    assert.ok(direct.error);
    assert.equal(direct.data, null);
    const rpc = await browser.rpc("claim_workspace", { workspace_id: id, lease_id: randomUUID() });
    assert.ok(rpc.error);
    assert.equal(rpc.data, null);
    console.log("Actual publishable-key table and lease RPC denial: PASS");
    phase = "lease identity and revision guards";
    const lease = randomUUID();
    const claim = await service.rpc("claim_workspace", { workspace_id: id, lease_id: lease });
    assert.ok(!claim.error && claim.data);
    const stale = await service.rpc("save_workspace", { workspace_id: id, lease_id: lease, new_payload: state });
    assert.equal(stale.error, null);
    assert.equal(stale.data, false);
    const wrong = await service.rpc("save_workspace", { workspace_id: id, lease_id: randomUUID(), new_payload: { ...state, revision: 10 } });
    assert.equal(wrong.error, null);
    assert.equal(wrong.data, false);
    const release = await service.rpc("release_workspace", { workspace_id: id, lease_id: lease });
    assert.equal(release.error, null);
    assert.equal((await loadWorkspace(id)).revision, 9);
    console.log("Actual SDK stale-revision and wrong-lease denial: PASS");
  } catch {
    console.error(`Supabase app qualification failed at: ${phase}. No private error or credential emitted.`);
    process.exitCode = 1;
  } finally {
    // Only this invocation's tagged synthetic row; never a global cleanup.
    const removed = await service.from("workspaces").delete().eq("id", id).eq("owner_id", owner).eq("demo", true);
    const remaining = await service.from("workspaces").select("id").eq("id", id);
    if (removed.error || remaining.error || remaining.data?.length) {
      console.error(`Fixture cleanup needs review for workspace ${id}`);
      process.exitCode = 1;
    } else {
      console.log("Invocation-owned synthetic workspace cleanup: PASS");
    }
  }
}
