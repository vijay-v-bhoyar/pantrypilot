import { expect, it } from "vitest";
import { seedWorkspace } from "@/lib/seed";
import { snapshot, restoreDemo } from "@/lib/snapshot";
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
