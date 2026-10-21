import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { ownedWorkspace, enrollOwner } from "@/lib/enrollment";
import { withWorkspace } from "@/lib/storage";
import { digest } from "@/lib/planner";
import { POST as join } from "@/app/api/join/route";
import { GET as callback } from "@/app/api/auth/callback/route";
import type { Workspace } from "@/lib/types";
const mock = vi.hoisted(() => ({
  rpc: vi.fn(),
  getUser: vi.fn(),
  exchange: vi.fn(),
  member: vi.fn(),
  session: vi.fn(),
  from: vi.fn(),
  upsert: vi.fn(),
}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ rpc: mock.rpc, from: mock.from }),
}));
vi.mock("@/lib/auth", () => ({
  authClient: async () => ({
    auth: { getUser: mock.getUser, exchangeCodeForSession: mock.exchange },
  }),
  serviceClient: () => ({ rpc: mock.rpc, from: mock.from }),
}));
vi.mock("@/lib/session", () => ({
  checkOrigin: () => {},
  setSession: mock.session,
}));
let stored: Workspace, userId: string, failSave: boolean;
beforeEach(() => {
  vi.stubEnv("APP_ENV", "local");
  vi.stubEnv("VERCEL", "");
  vi.stubEnv("STORAGE_MODE", "supabase");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://fixture.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "fixture-not-real");
  vi.stubEnv("PAYMENTS_MODE", "simulation");
  vi.stubEnv("APP_URL", "http://127.0.0.1:3100");
  for (const fn of Object.values(mock)) fn.mockReset();
  userId = randomUUID();
  stored = ownedWorkspace(userId);
  failSave = false;
  mock.getUser.mockResolvedValue({
    data: { user: { id: userId } },
    error: null,
  });
  mock.member.mockResolvedValue({ data: null, error: null });
  mock.exchange.mockResolvedValue({
    data: { user: { id: userId } },
    error: null,
  });
  const query = {
    select: () => query,
    eq: () => query,
    maybeSingle: mock.member,
    single: async () => ({
      data: { payload: structuredClone(stored) },
      error: null,
    }),
    upsert: mock.upsert,
  };
  mock.from.mockReturnValue(query);
  mock.rpc.mockImplementation(
    async (name: string, args: Record<string, unknown>) => {
      if (name === "claim_workspace")
        return { data: structuredClone(stored), error: null };
      if (name === "save_workspace_membership" || name === "save_workspace") {
        if (failSave) return { data: false, error: null };
        stored = structuredClone(args.new_payload) as Workspace;
        return { data: true, error: null };
      }
      if (name === "release_workspace") return { data: null, error: null };
      return { data: null, error: { message: "unconfigured fixture" } };
    },
  );
});
afterEach(() => vi.unstubAllEnvs());

it("verified callback mints a session only after the persisted actor is confirmed", async () => {
  const actorId = stored.actors[0].id;
  mock.rpc.mockResolvedValue({
    data: { workspace_id: stored.id, actor_id: actorId, created: false },
    error: null,
  });
  const response = await callback(
    new Request("http://127.0.0.1:3100/api/auth/callback?code=fixture"),
  );
  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe(
    "http://127.0.0.1:3100/workspace",
  );
  expect(mock.session).toHaveBeenCalledExactlyOnceWith(stored.id, actorId);
});
it("callback denies a revoked actor rather than issuing a stale privileged session", async () => {
  const actorId = stored.actors[0].id;
  stored.actors = [];
  mock.rpc.mockResolvedValue({
    data: { workspace_id: stored.id, actor_id: actorId, created: false },
    error: null,
  });
  const response = await callback(
    new Request("http://127.0.0.1:3100/api/auth/callback?code=fixture"),
  );
  expect(response.status).toBe(401);
  expect((await response.json()).error.code).toBe("SESSION_REVOKED");
  expect(mock.session).not.toHaveBeenCalled();
});
it("callback denies unverified sign-in before workspace enrollment", async () => {
  mock.exchange.mockResolvedValue({
    data: { user: null },
    error: { message: "private-provider-error" },
  });
  const response = await callback(
    new Request("http://127.0.0.1:3100/api/auth/callback?code=fixture"),
  );
  expect(response.status).toBe(401);
  expect(mock.rpc).not.toHaveBeenCalled();
  expect(mock.session).not.toHaveBeenCalled();
});
function invitation() {
  const token = "fixture-invitation-never-real";
  stored.invitations = [
    {
      id: randomUUID(),
      organizationId: "hope",
      role: "finance",
      tokenHash: digest(token),
      used: false,
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    },
  ];
  return token;
}
function request(body: unknown) {
  return new Request("http://127.0.0.1:3100/api/join", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
it("builds an owner workspace without synthetic financial or supplier records", () => {
  expect(stored.demo).toBe(false);
  expect(stored.ownerId).toBe(userId);
  expect(stored.actors).toHaveLength(1);
  expect(stored.actors[0].role).toBe("owner");
  for (const key of [
    "ledger",
    "inventory",
    "catalog",
    "suppliers",
    "campaigns",
  ] as const)
    expect(stored[key]).toEqual([]);
});
it("uses a single bootstrap RPC and accepts an existing binding on safe retry", async () => {
  const result = {
    workspace_id: stored.id,
    actor_id: stored.actors[0].id,
    created: false,
  };
  mock.rpc.mockResolvedValue({ data: result, error: null });
  expect(await enrollOwner(userId)).toEqual(result);
  expect(mock.rpc).toHaveBeenCalledExactlyOnceWith(
    "bootstrap_owned_workspace",
    expect.objectContaining({ member_user_id: userId }),
  );
  expect(mock.from).not.toHaveBeenCalled();
});
it("rejects unknown bootstrap outcomes and malformed bindings without exposing database details", async () => {
  for (const result of [
    { data: null, error: { message: "PRIVATE-KEY" } },
    {
      data: { workspace_id: "wrong", actor_id: "wrong", created: true },
      error: null,
    },
  ]) {
    mock.rpc.mockResolvedValue(result);
    await expect(enrollOwner(userId)).rejects.toMatchObject({
      code: "AUTH_ENROLLMENT",
      status: 503,
    });
  }
});
it("saves aggregate and membership together and releases the matching lease", async () => {
  const actorId = randomUUID();
  await withWorkspace(
    stored.id,
    (w) => {
      w.actors.push({
        id: actorId,
        name: "Member",
        role: "finance",
        organizationId: "hope",
      });
      return actorId;
    },
    { userId, actorId: (id) => id },
  );
  const save = mock.rpc.mock.calls.find(
    (c) => c[0] === "save_workspace_membership",
  )![1];
  expect(save.member_user_id).toBe(userId);
  expect(save.member_actor_id).toBe(actorId);
  expect(save.new_payload.revision).toBe(1);
  expect(mock.rpc).toHaveBeenLastCalledWith("release_workspace", {
    workspace_id: stored.id,
    lease_id: save.lease_id,
  });
  expect(mock.rpc.mock.calls.some((c) => c[0] === "save_workspace")).toBe(
    false,
  );
});
it("does not confirm a failed joint save or skip lease release", async () => {
  failSave = true;
  await expect(
    withWorkspace(stored.id, () => stored.actors[0].id, {
      userId,
      actorId: (id) => id,
    }),
  ).rejects.toMatchObject({ code: "PERSISTENCE", status: 503 });
  expect(stored.revision).toBe(0);
  expect(mock.rpc.mock.calls.at(-1)![0]).toBe("release_workspace");
});
it("rejects missing member actors and local-file enrollment before commit", async () => {
  await expect(
    withWorkspace(stored.id, () => "missing", { userId, actorId: (id) => id }),
  ).rejects.toMatchObject({ code: "AUTH_ENROLLMENT" });
  expect(
    mock.rpc.mock.calls.some((c) => c[0] === "save_workspace_membership"),
  ).toBe(false);
  vi.stubEnv("STORAGE_MODE", "local");
  mock.rpc.mockClear();
  await expect(
    withWorkspace(stored.id, () => "unused", { userId, actorId: (id) => id }),
  ).rejects.toMatchObject({ code: "AUTH_CONFIG" });
  expect(mock.rpc).not.toHaveBeenCalled();
});
it("invitation enrollment derives identity from verified auth and consumes the token in the joint commit", async () => {
  const token = invitation();
  const response = await join(request({ workspaceId: stored.id, token }));
  expect(response.status).toBe(200);
  expect(stored.invitations[0].used).toBe(true);
  const saved = mock.rpc.mock.calls.find(
    (c) => c[0] === "save_workspace_membership",
  )![1];
  expect(saved.member_user_id).toBe(userId);
  expect(stored.actors.find((a) => a.id === saved.member_actor_id)?.role).toBe(
    "finance",
  );
  expect(mock.session).toHaveBeenCalledExactlyOnceWith(
    stored.id,
    saved.member_actor_id,
  );
  expect(mock.upsert).not.toHaveBeenCalled();
});
it("failed enrollment keeps the invitation reusable and never mints a session", async () => {
  const token = invitation();
  failSave = true;
  expect((await join(request({ workspaceId: stored.id, token }))).status).toBe(
    503,
  );
  expect(stored.invitations[0].used).toBe(false);
  expect(stored.actors).toHaveLength(1);
  expect(mock.session).not.toHaveBeenCalled();
  failSave = false;
  expect((await join(request({ workspaceId: stored.id, token }))).status).toBe(
    200,
  );
  expect(stored.actors).toHaveLength(2);
});
it("reuses an existing actor without consuming another invitation", async () => {
  const token = invitation();
  mock.member.mockResolvedValue({
    data: { actor_id: stored.actors[0].id },
    error: null,
  });
  expect((await join(request({ workspaceId: stored.id, token }))).status).toBe(
    200,
  );
  expect(stored.actors).toHaveLength(1);
  expect(stored.invitations[0].used).toBe(false);
});
it("denies forged identity fields, expired/used invitations, demos and unauthenticated users", async () => {
  const token = invitation();
  expect(
    (
      await join(
        request({
          workspaceId: stored.id,
          token,
          userId: randomUUID(),
          role: "owner",
        }),
      )
    ).status,
  ).toBe(422);
  stored.invitations[0].used = true;
  expect((await join(request({ workspaceId: stored.id, token }))).status).toBe(
    422,
  );
  stored.invitations[0].used = false;
  stored.invitations[0].expiresAt = new Date(0).toISOString();
  expect((await join(request({ workspaceId: stored.id, token }))).status).toBe(
    422,
  );
  stored.demo = true;
  expect((await join(request({ workspaceId: stored.id, token }))).status).toBe(
    422,
  );
  mock.getUser.mockResolvedValue({ data: { user: null }, error: null });
  expect((await join(request({ workspaceId: stored.id, token }))).status).toBe(
    401,
  );
  expect(mock.session).not.toHaveBeenCalled();
  expect(mock.upsert).not.toHaveBeenCalled();
});
