import { beforeAll, afterAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { seedWorkspace } from "@/lib/seed";
import { execute } from "@/lib/commands";
import type * as Storage from "@/lib/storage";
let storage: typeof Storage;
let root: string;
beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "pantrypilot-test-"));
  process.env.PANTRYPILOT_DATA_DIR = root;
  process.env.STORAGE_MODE = "local";
  process.env.APP_ENV = "local";
  process.env.PAYMENTS_MODE = "simulation";
  storage = await import("@/lib/storage");
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});
it("persists complete state and reopens it independently", async () => {
  const id = randomUUID();
  await storage.createWorkspace(seedWorkspace(id));
  await storage.withWorkspace(id, (w) =>
    execute(w, "owner-a", "site", { name: "New site" }, randomUUID()),
  );
  const reopened = await storage.loadWorkspace(id);
  expect(reopened.organizations[0].sites.at(-1)?.name).toBe("New site");
  expect(reopened.revision).toBe(1);
});
it("serializes competing changes without losing updates", async () => {
  const id = randomUUID();
  await storage.createWorkspace(seedWorkspace(id));
  await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      storage.withWorkspace(id, (w) =>
        execute(w, "owner-a", "site", { name: `Site ${i}` }, randomUUID()),
      ),
    ),
  );
  const reopened = await storage.loadWorkspace(id);
  expect(reopened.organizations[0].sites).toHaveLength(12);
  expect(reopened.revision).toBe(10);
});
it("does not save a failed mutation or poison the queue", async () => {
  const id = randomUUID();
  await storage.createWorkspace(seedWorkspace(id));
  await expect(
    storage.withWorkspace(id, (w) => {
      w.ledger = [];
      throw new Error("rollback");
    }),
  ).rejects.toThrow("rollback");
  expect((await storage.loadWorkspace(id)).ledger).toHaveLength(2);
  await storage.withWorkspace(id, (w) =>
    execute(w, "owner-a", "site", { name: "After failure" }, randomUUID()),
  );
  expect((await storage.loadWorkspace(id)).revision).toBe(1);
});
it("rejects path traversal and duplicate workspace overwrites", async () => {
  await expect(storage.loadWorkspace("../outside")).rejects.toThrow(
    "identifier",
  );
  const w = seedWorkspace();
  await storage.createWorkspace(w);
  await expect(storage.createWorkspace(w)).rejects.toThrow();
});
