import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { seedWorkspace } from "@/lib/seed";
import { execute } from "@/lib/commands";
import { createWorkspace, loadWorkspace, withWorkspace } from "@/lib/storage";
import { aiProposal } from "@/lib/ai";
import type { PurchaseRequest, Session } from "@/lib/types";
const mock = vi.hoisted(() => ({ generate: vi.fn() }));
vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ai")>()),
  generateText: mock.generate,
}));
let root: string, session: Session, requestId: string;
beforeEach(async () => {
  mock.generate.mockReset();
  root = await mkdtemp(path.join(os.tmpdir(), "pantrypilot-agent-test-"));
  vi.stubEnv("PANTRYPILOT_DATA_DIR", root);
  vi.stubEnv("APP_ENV", "local");
  vi.stubEnv("STORAGE_MODE", "local");
  vi.stubEnv("PAYMENTS_MODE", "simulation");
  vi.stubEnv("AI_MAX_HTTP_REQUESTS", "4");
  vi.stubEnv("AI_MAX_INPUT_BYTES", "32768");
  vi.stubEnv("AI_MAX_OUTPUT_TOKENS", "1024");
  vi.stubEnv("AI_TIMEOUT_MS", "60000");
  vi.stubEnv("AI_MODE", "gemini");
  vi.stubEnv("PROVIDER_ACTIONS_ENABLED", "true");
  vi.stubEnv("GEMINI_API_KEY", "test-only-never-a-real-key");
  vi.stubEnv("GEMINI_MODEL", "gemini-3.5-flash-lite");
  vi.stubEnv("AI_DAILY_LIMIT", "50");
  const w = seedWorkspace();
  const r = execute(
    w,
    "owner-a",
    "request",
    {
      siteId: "hope-main",
      kitId: "kit-hope",
      fundId: "hope-kits",
      target: 50,
      budget: 60000,
      deadline: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10),
      notes: "PRIVATE-NOTES-NOT-FOR-PROVIDER",
    },
    randomUUID(),
  ) as PurchaseRequest;
  w.kits[0].name = "PRIVATE-KIT-NAME";
  w.kits[0].components[0].name = "PRIVATE-COMPONENT-NAME";
  w.inventory[0].name = "PRIVATE-LOT-NAME";
  await createWorkspace(w);
  session = {
    workspaceId: w.id,
    actorId: "owner-a",
    expiresAt: Date.now() + 100000,
    nonce: "fixture",
  };
  requestId = r.id;
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});
type Options = {
  prompt: string;
  tools: Record<string, { execute: () => Promise<unknown> }>;
  abortSignal: AbortSignal;
};
const result = {
  output: {
    catalogIds: ["harvest-rice", "harvest-beans", "supply-oats", "supply-soap"],
    reasoning: "Approved synthetic offers selected.",
    infeasible: false,
  },
  steps: [{}],
};

it.each([undefined, "   "])("rejects missing/blank explicit model %s before reserving quota", async (model) => {
  vi.stubEnv("GEMINI_MODEL", model);
  mock.generate.mockResolvedValue(result);
  await expect(aiProposal(session, requestId)).rejects.toMatchObject({
    code: "AI_MODEL", status: 503,
  });
  expect(mock.generate).not.toHaveBeenCalled();
  expect((await loadWorkspace(session.workspaceId)).agentRuns).toEqual([]);
});

it("rejects invalid quota configuration before invoking Gemini or saving a run", async () => {
  vi.stubEnv("AI_DAILY_LIMIT", "Infinity");
  await expect(aiProposal(session, requestId)).rejects.toMatchObject({
    code: "CONFIGURATION",
    status: 503,
  });
  expect(mock.generate).not.toHaveBeenCalled();
  expect((await loadWorkspace(session.workspaceId)).agentRuns).toHaveLength(0);
});
it("projects only approved fields and has no financial tool", async () => {
  mock.generate.mockImplementation(async (options: Options) => {
    expect(Object.keys(options.tools).sort()).toEqual([
      "catalog",
      "compare",
      "inventory",
    ]);
    const observed = JSON.stringify([
      options.prompt,
      await options.tools.inventory.execute(),
      await options.tools.catalog.execute(),
      await options.tools.compare.execute(),
    ]);
    expect(observed).not.toContain("PRIVATE-");
    expect(observed).not.toContain("donor");
    expect(observed).not.toContain("test-only-never");
    return result;
  });
  const p = await aiProposal(session, requestId);
  expect(mock.generate.mock.calls[0][0]).toMatchObject({ maxOutputTokens: 1024, maxRetries: 0 });
  expect(p.source).toBe("gemini");
  expect(p.total).toBe(35200);
  expect((await loadWorkspace(session.workspaceId)).orders).toEqual([]);
});
it.each([undefined, "0", "11", "Infinity"])("refuses invalid request budget %s before quota or model work", async (value) => {
  vi.stubEnv("AI_MAX_HTTP_REQUESTS", value);
  await expect(aiProposal(session, requestId)).rejects.toMatchObject({ code: "AI_BUDGET_CONFIG" });
  expect(mock.generate).not.toHaveBeenCalled();
  expect((await loadWorkspace(session.workspaceId)).agentRuns).toEqual([]);
});
it.each([new Error("PRIVATE_PROVIDER_DIAGNOSTIC"), "PRIVATE_PROVIDER_DIAGNOSTIC"])("does not persist raw planner diagnostics", async (failure) => {
  const before = await loadWorkspace(session.workspaceId);
  mock.generate.mockRejectedValue(failure);
  await expect(aiProposal(session, requestId)).rejects.toBe(failure);
  const after = await loadWorkspace(session.workspaceId);
  expect(after.agentRuns[0]).toMatchObject({ status: "failed",
    error: "The planner could not complete. Check existing proposals before retrying; AI may be stopped." });
  expect(JSON.stringify(after)).not.toContain("PRIVATE_PROVIDER_DIAGNOSTIC");
  for (const key of ["ledger", "orders", "donations", "recoveries", "inventory", "distributions", "approvals", "proposals"] as const)
    expect(after[key]).toEqual(before[key]);
});
it("discards a late answer even when stop was followed by resume", async () => {
  mock.generate.mockImplementation(async () => {
    await withWorkspace(session.workspaceId, (w) => {
      execute(w, "owner-a", "agentStop", { enabled: false }, randomUUID());
      execute(w, "owner-a", "agentStop", { enabled: true }, randomUUID());
    });
    return result;
  });
  await expect(aiProposal(session, requestId)).rejects.toThrow("stopped");
  expect((await loadWorkspace(session.workspaceId)).proposals).toEqual([]);
});
it("blocks merchant-entered offer text from hosted model egress", async () => {
  await withWorkspace(session.workspaceId, (w) => {
    execute(
      w,
      "supplier-a",
      "catalogCreate",
      {
        sku: "private-product",
        name: "PRIVATE-SUPPLIER-NOTE",
        unit: "units",
        packSize: 1,
        price: 100,
        availablePacks: 1,
        deliveryDays: 1,
        attributes: [],
      },
      randomUUID(),
    );
  });
  await expect(aiProposal(session, requestId)).rejects.toThrow(
    "merchant-entered",
  );
  expect(mock.generate).not.toHaveBeenCalled();
});
it("rejects an invented catalog offer and records failure without spending", async () => {
  mock.generate.mockResolvedValue({
    ...result,
    output: { ...result.output, catalogIds: ["invented"] },
  });
  await expect(aiProposal(session, requestId)).rejects.toThrow("invented");
  const w = await loadWorkspace(session.workspaceId);
  expect(w.proposals).toEqual([]);
  expect(w.orders).toEqual([]);
  expect(w.agentRuns[0].status).toBe("failed");
  expect(w.ledger).toHaveLength(2);
});
it("denies private workspaces and donor authority before model invocation", async () => {
  await expect(
    aiProposal({ ...session, actorId: "donor" }, requestId),
  ).rejects.toThrow("role");
  await withWorkspace(session.workspaceId, (w) => {
    w.demo = false;
  });
  await expect(aiProposal(session, requestId)).rejects.toThrow("synthetic");
  expect(mock.generate).not.toHaveBeenCalled();
});
it("counts failed attempts toward quota and enforces rate limits", async () => {
  mock.generate.mockRejectedValue(new Error("provider unavailable"));
  await expect(aiProposal(session, requestId)).rejects.toThrow("unavailable");
  await expect(aiProposal(session, requestId)).rejects.toThrow("ten seconds");
  expect(mock.generate).toHaveBeenCalledTimes(1);
  await withWorkspace(session.workspaceId, (w) => {
    w.agentRuns[0].createdAt = new Date(Date.now() - 11000).toISOString();
  });
  vi.stubEnv("AI_DAILY_LIMIT", "1");
  await expect(aiProposal(session, requestId)).rejects.toThrow("daily");
});
it("aborts an in-flight model run when the owner stops AI", async () => {
  let entered: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  mock.generate.mockImplementation(
    (options: Options) =>
      new Promise((_, reject) => {
        entered();
        options.abortSignal.addEventListener(
          "abort",
          () => reject(options.abortSignal.reason),
          { once: true },
        );
      }),
  );
  const pending = aiProposal(session, requestId);
  const observed = expect(pending).rejects.toThrow("stopped");
  await started;
  await withWorkspace(session.workspaceId, (w) =>
    execute(w, "owner-a", "agentStop", { enabled: false }, randomUUID()),
  );
  await observed;
  const w = await loadWorkspace(session.workspaceId);
  expect(w.proposals).toEqual([]);
  expect(w.agentRuns[0].error).toContain("stopped");
});
it("discards an output if the requesting role was revoked during inference", async () => {
  mock.generate.mockImplementation(async () => {
    await withWorkspace(session.workspaceId, (w) => {
      w.actors.find((a) => a.id === "owner-a")!.role = "donor";
    });
    return result;
  });
  await expect(aiProposal(session, requestId)).rejects.toThrow("role");
  expect((await loadWorkspace(session.workspaceId)).proposals).toEqual([]);
});
