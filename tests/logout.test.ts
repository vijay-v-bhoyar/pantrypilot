import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { POST } from "@/app/api/logout/route";
import {
  decodeSession,
  encodeSession,
  getSession,
  revokeSession,
} from "@/lib/session";
import { seedWorkspace } from "@/lib/seed";
import { view } from "@/lib/commands";

const mocks = vi.hoisted(() => ({
  signOut: vi.fn(),
  load: vi.fn(),
  mutate: vi.fn(),
  jar: new Map<string, string>(),
  deleted: [] as string[],
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      mocks.jar.has(name) ? { value: mocks.jar.get(name) } : undefined,
    getAll: () => [...mocks.jar.keys()].map((name) => ({ name })),
    delete: (name: string) => {
      mocks.deleted.push(name);
      mocks.jar.delete(name);
    },
  }),
}));
vi.mock("@/lib/auth", () => ({
  authClient: async () => ({ auth: { signOut: mocks.signOut } }),
}));
vi.mock("@/lib/storage", () => ({
  loadWorkspace: mocks.load,
  withWorkspace: mocks.mutate,
}));

const session = {
  workspaceId: "logout-workspace",
  actorId: "owner-a",
  nonce: "logout-test-nonce",
  expiresAt: Date.now() + 60000,
};
let workspace: ReturnType<typeof seedWorkspace>;
const request = (origin = "http://127.0.0.1:3100") =>
  new Request(`${origin}/api/logout`, { method: "POST", headers: { origin } });
beforeEach(() => {
  vi.stubEnv("APP_ENV", "local");
  vi.stubEnv("VERCEL", "");
  vi.stubEnv("APP_URL", "http://127.0.0.1:3100");
  vi.stubEnv("STORAGE_MODE", "supabase");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://fixture.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "fixture-key");
  vi.stubEnv("PAYMENTS_MODE", "simulation");
  mocks.signOut.mockReset();
  mocks.load.mockReset();
  mocks.mutate.mockReset();
  mocks.jar.clear();
  mocks.deleted.length = 0;
  workspace = seedWorkspace(session.workspaceId, "fixture-owner");
  mocks.load.mockImplementation(async () => workspace);
  mocks.mutate.mockImplementation(async (_id, callback) => callback(workspace));
  mocks.signOut.mockResolvedValue({ error: null });
  mocks.jar.set("pantrypilot_session", encodeSession(session));
  for (const name of [
    "sb-fixture-auth-token.0",
    "sb-fixture-auth-token.1",
    "sb-fixture-auth-token-code-verifier",
    "sb-other-auth-token",
    "unrelated",
  ])
    mocks.jar.set(name, "private-fixture");
});
afterEach(() => vi.unstubAllEnvs());

it("revokes the current provider session, clears only its cookies, and denies copied app-cookie replay", async () => {
  const copied = mocks.jar.get("pantrypilot_session")!;
  const response = await POST(request());
  expect(response.status).toBe(200);
  expect(mocks.signOut).toHaveBeenCalledExactlyOnceWith({ scope: "local" });
  expect(mocks.deleted).toEqual(
    expect.arrayContaining([
      "pantrypilot_session",
      "sb-fixture-auth-token.0",
      "sb-fixture-auth-token.1",
      "sb-fixture-auth-token-code-verifier",
    ]),
  );
  expect(mocks.jar.has("sb-other-auth-token")).toBe(true);
  expect(mocks.jar.has("unrelated")).toBe(true);
  mocks.jar.set("pantrypilot_session", copied);
  await expect(getSession()).rejects.toMatchObject({
    code: "SESSION_REVOKED",
    status: 401,
  });
  expect(view(workspace, "owner-a")).not.toHaveProperty("revokedSessionNonces");
});
it("does not revoke another concurrent app session and prunes only expired tombstones", async () => {
  workspace.revokedSessionNonces = { expired: 1, other: Date.now() + 60000 };
  await revokeSession(session);
  expect(workspace.revokedSessionNonces).not.toHaveProperty("expired");
  expect(workspace.revokedSessionNonces.other).toBeGreaterThan(Date.now());
  mocks.jar.set(
    "pantrypilot_session",
    encodeSession({ ...session, nonce: "still-active" }),
  );
  await expect(getSession()).resolves.toMatchObject({ nonce: "still-active" });
});
it.each(["error", "throw"])(
  "clears browser credentials but reports unconfirmed provider revocation on %s",
  async (mode) => {
    if (mode === "error")
      mocks.signOut.mockResolvedValue({
        error: { message: "private-provider-detail" },
      });
    else mocks.signOut.mockRejectedValue(new Error("private-provider-detail"));
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("LOGOUT_UNCONFIRMED");
    expect(mocks.jar.has("pantrypilot_session")).toBe(false);
    expect([...mocks.jar.keys()].some((x) => x.startsWith("sb-fixture-"))).toBe(
      false,
    );
  },
);
it("does not claim completed logout if durable app revocation fails", async () => {
  mocks.mutate.mockRejectedValue(new Error("private-database-detail"));
  const response = await POST(request());
  expect(response.status).toBe(503);
  expect(JSON.stringify(await response.json())).not.toContain(
    "private-database-detail",
  );
  expect(mocks.signOut).toHaveBeenCalledOnce();
  expect(mocks.jar.has("pantrypilot_session")).toBe(false);
});
it("rejects foreign origin before revocation or cookie changes", async () => {
  const response = await POST(request("https://attacker.example"));
  expect(response.status).toBe(403);
  expect(mocks.signOut).not.toHaveBeenCalled();
  expect(mocks.mutate).not.toHaveBeenCalled();
  expect(mocks.deleted).toEqual([]);
});
it("supports local demo logout without a Supabase provider", async () => {
  vi.stubEnv("STORAGE_MODE", "local");
  expect((await POST(request())).status).toBe(200);
  expect(mocks.signOut).not.toHaveBeenCalled();
});
it("clears invalid app cookies without trying to revoke an untrusted workspace", async () => {
  mocks.jar.set("pantrypilot_session", "forged.signature");
  expect((await POST(request())).status).toBe(200);
  expect(mocks.mutate).not.toHaveBeenCalled();
  expect(() => decodeSession("forged.signature")).toThrow();
});
