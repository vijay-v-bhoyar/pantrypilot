import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { POST } from "@/app/api/analytics-agent/route";
import { analysisPrompts } from "@/lib/dashboard";
import { seedWorkspace } from "@/lib/seed";
import type { Workspace } from "@/lib/types";

const mocks = vi.hoisted(() => ({ mutate: vi.fn(), generate: vi.fn() }));
vi.mock("@/lib/session", () => ({
  checkOrigin: vi.fn(),
  getSession: async () => ({ workspaceId: "fixture", actorId: "owner-a", nonce: "fixture", expiresAt: Date.now() + 10000 }),
}));
vi.mock("@/lib/storage", () => ({ withWorkspace: mocks.mutate }));
vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ai")>()),
  generateText: mocks.generate,
}));
let workspace: Workspace;
beforeEach(() => {
  vi.stubEnv("APP_ENV", "local");
  vi.stubEnv("STORAGE_MODE", "local");
  vi.stubEnv("AI_MAX_HTTP_REQUESTS", "4");
  vi.stubEnv("AI_MAX_INPUT_BYTES", "32768");
  vi.stubEnv("AI_MAX_OUTPUT_TOKENS", "1024");
  vi.stubEnv("AI_TIMEOUT_MS", "60000");
  vi.stubEnv("AI_MODE", "gemini");
  vi.stubEnv("PROVIDER_ACTIONS_ENABLED", "true");
  vi.stubEnv("GEMINI_API_KEY", "test-only-never-a-real-key");
  vi.stubEnv("GEMINI_MODEL", "gemini-3.5-flash-lite");
  workspace = seedWorkspace();
  mocks.mutate.mockReset();
  mocks.generate.mockReset();
  mocks.mutate.mockImplementation(async (_id: string, action: (w: Workspace) => unknown) => action(workspace));
  mocks.generate.mockImplementation(async (options: {
    tools: { readOperationalEvidence: { execute: () => Promise<unknown> }; selectDashboard: { execute: (input: { focus: string }) => Promise<unknown> } };
  }) => {
    await options.tools.readOperationalEvidence.execute();
    await options.tools.selectDashboard.execute({ focus: "recovery" });
    return {};
  });
});
afterEach(() => vi.unstubAllEnvs());
function request() {
  return new Request("http://127.0.0.1:3100/api/analytics-agent", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: analysisPrompts[0] }),
  });
}
it.each([undefined, "   "])("rejects missing/blank analyst model %s before run persistence", async (model) => {
  vi.stubEnv("GEMINI_MODEL", model);
  const response = await POST(request());
  expect(response.status).toBe(503);
  expect((await response.json()).error.code).toBe("AI_MODEL");
  expect(mocks.mutate).not.toHaveBeenCalled();
  expect(mocks.generate).not.toHaveBeenCalled();
  expect(workspace.agentRuns).toEqual([]);
});
it("uses the explicit selected analyst model and changes no financial state", async () => {
  const ledger = structuredClone(workspace.ledger);
  const response = await POST(request());
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ focus: "recovery", evidence: {
    availableCents: 60000, reservedCents: 0, pendingRecoveryCents: 0,
    pendingRecoveryCases: 0, readyKits: 10, receivedShipments: 0,
    recordedKits: 0, unreceivedOrders: 0,
  } });
  expect(mocks.generate.mock.calls[0][0].model.modelId).toBe("gemini-3.5-flash-lite");
  expect(mocks.generate.mock.calls[0][0]).toMatchObject({ maxOutputTokens: 1024, maxRetries: 0 });
  expect(workspace.ledger).toEqual(ledger);
  expect(workspace.orders).toEqual([]);
  expect(workspace.agentRuns).toHaveLength(1);
  expect(workspace.agentRuns[0].status).toBe("completed");
});

it.each([
  new Error("SYNTHETIC_SERVER_DIAGNOSTIC_MARKER"),
  "SYNTHETIC_SERVER_DIAGNOSTIC_MARKER",
])("keeps unknown analyst failure details out of persisted state and staff projections: %s", async (failure) => {
  const before = structuredClone(workspace);
  mocks.generate.mockRejectedValue(failure);
  const response = await POST(request());
  expect(response.status).toBe(503);
  expect(JSON.stringify(await response.json())).not.toContain("SYNTHETIC_SERVER_DIAGNOSTIC_MARKER");
  expect(workspace.agentRuns).toHaveLength(1);
  expect(workspace.agentRuns[0]).toMatchObject({ status: "failed", source: "gemini", error: "The analyst could not complete. Check your dashboard before retrying." });
  expect(JSON.stringify(workspace)).not.toContain("SYNTHETIC_SERVER_DIAGNOSTIC_MARKER");
  const { view } = await import("@/lib/commands");
  for (const actorId of ["owner-a", "finance-a", "coordinator-a", "owner-b", "supplier-a", "donor"])
    expect(JSON.stringify(view(workspace, actorId))).not.toContain("SYNTHETIC_SERVER_DIAGNOSTIC_MARKER");
  for (const field of ["ledger", "orders", "donations", "recoveries", "dashboards", "inventory", "distributions"] as const)
    expect(workspace[field]).toEqual(before[field]);
});
it.each([undefined, "0", "1025", "Infinity"])("denies invalid analyst output budget %s before persistence", async (value) => {
  vi.stubEnv("AI_MAX_OUTPUT_TOKENS", value);
  const response = await POST(request());
  expect(response.status).toBe(503);
  expect((await response.json()).error.code).toBe("AI_BUDGET_CONFIG");
  expect(mocks.mutate).not.toHaveBeenCalled(); expect(mocks.generate).not.toHaveBeenCalled();
});
it("discards a late analyst answer after the request was cancelled", async () => {
  const control = new AbortController();
  mocks.generate.mockImplementation(async (options) => {
    await options.tools.readOperationalEvidence.execute();
    await options.tools.selectDashboard.execute({ focus: "recovery" });
    control.abort(new Error("PRIVATE_CANCELLATION_REASON"));
    return {};
  });
  const source = request();
  const response = await POST(new Request(source, { signal: control.signal }));
  expect(response.status).toBe(503);
  expect(JSON.stringify(await response.json())).not.toContain("PRIVATE_CANCELLATION_REASON");
  expect(workspace.agentRuns[0].status).toBe("failed");
  expect(JSON.stringify(workspace)).not.toContain("PRIVATE_CANCELLATION_REASON");
  expect(workspace.orders).toEqual([]);
});

it("passes only scoped numeric aggregates through the evidence tool", async () => {
  workspace.organizations[0].name = "PRIVATE-NONPROFIT";
  workspace.kits[0].name = "PRIVATE-KIT";
  let projection: unknown;
  mocks.generate.mockImplementation(async (options) => {
    projection = await options.tools.readOperationalEvidence.execute();
    await options.tools.selectDashboard.execute({ focus: "funds" });
    return { text: "Invented balance $999999" };
  });
  const response = await POST(request());
  expect(response.status).toBe(200);
  expect(projection).toMatchObject({ availableCents: 60000, readyKits: 10 });
  expect(Object.values(projection as Record<string, unknown>).every(v => typeof v === "number")).toBe(true);
  expect(JSON.stringify(projection)).not.toContain("PRIVATE-");
  const result = await response.json();
  expect(result.evidence.availableCents).toBe(60000);
  expect(JSON.stringify(result)).not.toContain("999999");
});
it("rejects view selection that skipped operational evidence", async () => {
  mocks.generate.mockImplementation(async (options) => {
    await options.tools.selectDashboard.execute({ focus: "funds" });
    return {};
  });
  const response = await POST(request());
  expect(response.status).not.toBe(200);
  expect((await response.json()).error.code).toBe("AI_OUTPUT");
  expect(workspace.agentRuns[0].status).toBe("failed");
  expect(workspace.dashboards).toEqual([]);
});
it("rejects an answer whose operational evidence changed during model execution", async () => {
  mocks.generate.mockImplementation(async (options) => {
    await options.tools.readOperationalEvidence.execute();
    workspace.ledger[0].amount += 100; // Independent concurrent posting fixture.
    await options.tools.selectDashboard.execute({ focus: "funds" });
    return {};
  });
  const response = await POST(request());
  expect(response.status).toBe(409);
  expect((await response.json()).error.code).toBe("STALE");
  expect(workspace.agentRuns[0].status).toBe("failed");
  expect(workspace.dashboards).toEqual([]);
});
it("keeps real workspace data outside model evidence egress", async () => {
  workspace.demo = false;
  const response = await POST(request());
  expect(response.status).toBe(403);
  expect(mocks.generate).not.toHaveBeenCalled();
  expect(workspace.agentRuns).toEqual([]);
});
it.each(["permission", "organization", "classification"])("discards an analyst answer after %s changed", async (change) => {
  mocks.generate.mockImplementation(async (options) => {
    await options.tools.readOperationalEvidence.execute();
    await options.tools.selectDashboard.execute({ focus: "funds" });
    const actor = workspace.actors.find(a => a.id === "owner-a")!;
    if (change === "permission") actor.role = "supplier";
    else if (change === "organization") actor.organizationId = "river";
    else workspace.demo = false;
    return {};
  });
  const response = await POST(request());
  expect(response.status).toBe(change === "permission" ? 403 : 409);
  expect(workspace.agentRuns[0].status).toBe("failed");
  expect(workspace.dashboards).toEqual([]);
  expect(workspace.orders).toEqual([]);
});
