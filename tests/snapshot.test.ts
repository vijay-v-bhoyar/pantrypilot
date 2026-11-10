import { expect, it, vi } from "vitest";
import { seedWorkspace } from "@/lib/seed";
import { snapshot, restoreDemo } from "@/lib/snapshot";

const route = vi.hoisted(() => ({ loadWorkspace: vi.fn(), setSession: vi.fn() }));
vi.mock("@/lib/storage", () => ({ loadWorkspace: route.loadWorkspace }));
vi.mock("@/lib/session", () => ({ checkOrigin: vi.fn(), setSession: route.setSession }));
vi.mock("@/lib/config", () => ({ configuration: () => ({ hosted: false }) }));

import { POST } from "@/app/api/restore-session/route";
it("round-trips synthetic data into a separate workspace", () => {
  const w = seedWorkspace();
  const restored = restoreDemo(snapshot(w));
  expect(restored.id).not.toBe(w.id);
  expect(restored.ledger).toEqual(w.ledger);
  expect(restored.inventory).toEqual(w.inventory);
  expect(restored.ownerId).toBe("local-restored-demo");
});
it("rejects tampered backup data and real/provider-backed workspaces", () => {
  const s = snapshot(seedWorkspace());
  s.workspace.inventory[0].quantity = 1;
  expect(() => restoreDemo(s)).toThrow("checksum");
  const real = seedWorkspace();
  real.demo = false;
  expect(() => restoreDemo(snapshot(real))).toThrow("synthetic");
  const provider = seedWorkspace();
  provider.ledger[0].evidence = "paypal_sandbox";
  expect(() => restoreDemo(snapshot(provider))).toThrow("Provider-backed");
});

it("rejects checksummed snapshots without an owner linked to an organization", () => {
  const ownerless = seedWorkspace();
  ownerless.actors = ownerless.actors.filter(actor => actor.role !== "owner");
  expect(() => restoreDemo(snapshot(ownerless))).toThrow("needs an owner");

  const detached = seedWorkspace();
  for (const actor of detached.actors.filter(actor => actor.role === "owner")) {
    actor.organizationId = "missing-organization";
  }
  expect(() => restoreDemo(snapshot(detached))).toThrow("needs an owner");
});

it("does not issue a session for an existing ownerless clone", async () => {
  const clone = restoreDemo(snapshot(seedWorkspace()));
  clone.actors = clone.actors.filter(actor => actor.role !== "owner");
  route.loadWorkspace.mockResolvedValueOnce(clone);

  const response = await POST(new Request("http://127.0.0.1:3100/api/restore-session", {
    method: "POST",
    body: JSON.stringify({ workspaceId: clone.id }),
  }));

  expect(response.status).toBe(422);
  expect(await response.json()).toMatchObject({ error: { code: "RESTORE_SCOPE" } });
  expect(route.setSession).not.toHaveBeenCalled();
});
