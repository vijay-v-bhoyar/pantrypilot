import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { POST } from "@/app/api/command/route";
import { execute } from "@/lib/commands";
import { seedWorkspace } from "@/lib/seed";
import { createWorkspace, loadWorkspace, withWorkspace } from "@/lib/storage";
import type { Distribution, StockCorrection } from "@/lib/types";
const fixture = vi.hoisted(() => ({ actorId: "coordinator-a", workspaceId: "", failRename: false }));
vi.mock("@/lib/session", async original => ({
  ...await original<typeof import("@/lib/session")>(),
  getSession: async () => ({ ...fixture, nonce: "fixture", expiresAt: Date.now() + 60000 }),
}));
vi.mock("node:fs/promises", async original => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, rename: (...args: Parameters<typeof fs.rename>) => {
    if (fixture.failRename) return Promise.reject(Object.assign(new Error("Synthetic persistent file lock"), { code: "EPERM" }));
    return fs.rename(...args);
  } };
});
let root: string, input: unknown;
const origin = "http://127.0.0.1:3101";
async function post(command: string, data: unknown, key = randomUUID(), requestOrigin = origin) {
  return POST(new Request(`${origin}/api/command`, { method: "POST", headers: { Origin: requestOrigin, "Content-Type": "application/json" }, body: JSON.stringify({ command, data, key }) }));
}
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "pantrypilot-correction-route-"));
  for (const [name, value] of Object.entries({ APP_ENV: "local", APP_URL: origin, VERCEL: "", STORAGE_MODE: "local", PAYMENTS_MODE: "simulation", FINANCIAL_ACTIONS_ENABLED: "true", PROVIDER_ACTIONS_ENABLED: "false", AI_MODE: "manual", PANTRYPILOT_DATA_DIR: root })) vi.stubEnv(name, value);
  fixture.actorId = "coordinator-a"; fixture.failRename = false;
  const w = seedWorkspace(); fixture.workspaceId = w.id;
  const d = execute(w, fixture.actorId, "distribute", { siteId: "hope-main", kitId: "kit-hope", quantity: 5 }, randomUUID()) as Distribution;
  input = { kind: "distribution", sourceId: d.id, quantity: 3, movements: d.movements!.map(m => ({ lotId: m.lotId, quantity: -m.quantity / 5 * 2 })), reason: "Synthetic transcription error", evidence: "Synthetic recount route fixture" };
  await createWorkspace(w);
});
afterEach(async () => { fixture.failRename = false; vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
async function proposed() {
  const response = await post("correctionPropose", input); expect(response.status).toBe(200);
  return response.json() as Promise<StockCorrection>;
}
it("persists coordinator proposal and owner approval once across concurrent replay and lost acknowledgment", async () => {
  const c = await proposed(), before = await loadWorkspace(fixture.workspaceId); fixture.actorId = "owner-a";
  const key = randomUUID(), data = { id: c.id, digest: c.digest };
  const responses = await Promise.all([post("correctionApprove", data, key), post("correctionApprove", data, key)]);
  expect(responses.map(r => r.status)).toEqual([200, 200]); // First response may be lost; durable readback is the oracle.
  const saved = await loadWorkspace(fixture.workspaceId);
  expect(saved.stockCorrections).toHaveLength(1); expect(saved.stockCorrections![0].status).toBe("applied");
  expect(saved.distributions).toEqual(before.distributions); expect(saved.ledger).toEqual(before.ledger);
  expect(saved.audit.filter(a => a.action === "correctionApprove")).toHaveLength(1);
  for (const m of c.movements) expect(saved.inventory.find(l => l.id === m.lotId)!.quantity).toBe(before.inventory.find(l => l.id === m.lotId)!.quantity + m.quantity);
  expect((await post("correctionApprove", data)).status).toBe(409);
});
it.each(["finance-a", "coordinator-a", "owner-b"])("enforces route authority for %s", async actor => {
  const c = await proposed(), before = await loadWorkspace(fixture.workspaceId); fixture.actorId = actor;
  expect((await post("correctionApprove", { id: c.id, digest: c.digest })).status).toBe(actor === "owner-b" ? 404 : 403);
  expect(await loadWorkspace(fixture.workspaceId)).toEqual(before);
});
it("rolls back the entire staged approval on failed atomic commit, then permits the same intended key", async () => {
  const c = await proposed(), before = await loadWorkspace(fixture.workspaceId); fixture.actorId = "owner-a"; fixture.failRename = true;
  const data = { id: c.id, digest: c.digest }, key = randomUUID();
  expect((await post("correctionApprove", data, key)).status).toBe(503);
  expect(await loadWorkspace(fixture.workspaceId)).toEqual(before);
  fixture.failRename = false; expect((await post("correctionApprove", data, key)).status).toBe(200);
  expect((await loadWorkspace(fixture.workspaceId)).audit.filter(a => a.action === "correctionApprove")).toHaveLength(1);
});
it("rejects changed stock atomically and preserves it for a new recount", async () => {
  const c = await proposed(); fixture.actorId = "owner-a";
  await withWorkspace(fixture.workspaceId, w => { w.inventory.find(l => l.id === c.movements[0].lotId)!.version++; });
  const before = await loadWorkspace(fixture.workspaceId);
  expect((await post("correctionApprove", { id: c.id, digest: c.digest })).status).toBe(409);
  expect(await loadWorkspace(fixture.workspaceId)).toEqual(before);
});
it("denies cross-origin correction writes before reading or mutating workspace", async () => {
  const before = await loadWorkspace(fixture.workspaceId);
  expect((await post("correctionPropose", input, randomUUID(), "https://untrusted.invalid")).status).toBe(403);
  expect(await loadWorkspace(fixture.workspaceId)).toEqual(before);
});
