import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { enrollOwner } from "../src/lib/enrollment";
import { encodeSession } from "../src/lib/session";
import { loadWorkspace } from "../src/lib/storage";

const ref = process.env.SUPABASE_QUALIFICATION_PROJECT_REF;
const origin = "http://127.0.0.1:3100";
assert.equal(process.env.RUN_SUPABASE_ISOLATION, "true");
assert.equal(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  `https://${ref}.supabase.co`,
);
assert.equal(ref, "qjuhtagioeztqsiccafy");
assert.equal(process.env.APP_ENV, "local");
assert.equal(process.env.STORAGE_MODE, "supabase");
assert.equal(process.env.APP_URL, origin);
assert.equal(process.env.PAYMENTS_MODE, "simulation");
assert.equal(process.env.AI_MODE, "manual");
assert.equal(process.env.PROVIDER_ACTIONS_ENABLED, "false");
const health = await (await fetch(`${origin}/api/health`)).json();
assert.equal(health.app, "PantryPilot");
assert.equal(health.storage, "supabase");
assert.equal(health.providerActions, false);
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const publicKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});
const run = randomUUID();
type Fixture = {
  userId: string;
  workspaceId: string;
  actorId: string;
  jar: Map<string, string>;
  refreshToken: string;
};
const fixtures: Fixture[] = [];
const createdUsers: string[] = [];
const api = async (fixture: Fixture, path: string, body?: unknown) => {
  const response = await fetch(`${origin}${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      Origin: origin,
      Cookie: [...fixture.jar]
        .map(([name, value]) => `${name}=${value}`)
        .join("; "),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: "manual",
  });
  for (const cookie of response.headers.getSetCookie()) {
    const pair = cookie.split(";")[0];
    const index = pair.indexOf("=");
    const name = pair.slice(0, index);
    const value = pair.slice(index + 1);
    if (/Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(cookie))
      fixture.jar.delete(name);
    else fixture.jar.set(name, value);
  }
  return { status: response.status, data: await response.json() };
};
const command = (fixture: Fixture, name: string, data: unknown) =>
  api(fixture, "/api/command", { command: name, data, key: randomUUID() });
let phase = "create synthetic auth fixtures";
try {
  for (const label of ["a", "b"]) {
    const email = `isolation-${run}-${label}@pantrypilot.invalid`;
    const password = randomBytes(32).toString("base64url");
    const created = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { role: "owner", organizationId: "untrusted-metadata" },
    });
    assert.equal(created.error, null);
    assert.ok(created.data.user);
    const userId = created.data.user.id;
    createdUsers.push(userId);
    const jar = new Map<string, string>();
    const client = createServerClient(url, publicKey, {
      cookies: {
        getAll: () => [...jar].map(([name, value]) => ({ name, value })),
        setAll: (values) =>
          values.forEach(({ name, value }) => jar.set(name, value)),
      },
    });
    const signed = await client.auth.signInWithPassword({ email, password });
    assert.equal(signed.error, null);
    assert.ok(signed.data.session);
    const binding = await enrollOwner(userId);
    const fixture = {
      userId,
      workspaceId: binding.workspace_id,
      actorId: binding.actor_id,
      jar,
      refreshToken: signed.data.session.refresh_token,
    };
    fixtures.push(fixture);
    fixture.jar.set(
      "pantrypilot_session",
      encodeSession({
        workspaceId: fixture.workspaceId,
        actorId: fixture.actorId,
        nonce: randomBytes(16).toString("hex"),
        expiresAt: Date.now() + 600000,
      }),
    );
    assert.equal((await enrollOwner(userId)).workspace_id, fixture.workspaceId);
    assert.equal(
      (await client.from("workspaces").select("payload")).error?.code,
      "42501",
    );
    assert.equal(
      (
        await client.rpc("bootstrap_owned_workspace", {
          member_user_id: userId,
          initial_payload: {},
        })
      ).error?.code,
      "42501",
    );
  }
  const [a, b] = fixtures;
  assert.notEqual(a.workspaceId, b.workspaceId);
  phase = "cross-owner read and mutation denial";
  assert.equal(
    (await command(a, "site", { name: `Isolation A ${run}` })).status,
    200,
  );
  const readA = await api(a, `/api/workspace?workspaceId=${b.workspaceId}`);
  assert.equal(readA.status, 200);
  assert.equal(readA.data.id, a.workspaceId);
  const readB = await api(b, "/api/workspace");
  assert.equal(readB.status, 200);
  assert.equal(readB.data.id, b.workspaceId);
  assert.ok(!JSON.stringify(readB.data).includes(`Isolation A ${run}`));
  assert.equal((await command(a, "revoke", { id: b.actorId })).status, 404);
  assert.equal(
    (
      await api(a, "/api/command", {
        workspaceId: b.workspaceId,
        command: "site",
        data: { name: "forged" },
        key: randomUUID(),
      })
    ).status,
    422,
  );
  assert.equal((await loadWorkspace(b.workspaceId)).revision, 0);
  console.log(
    "Two actual Supabase users: separate owner bindings, direct table/RPC denial and cross-owner API isolation PASS",
  );
  phase = "invitation and privilege boundaries";
  const uninvited = await api(b, "/api/join", { workspaceId: a.workspaceId });
  assert.equal(uninvited.status, 422);
  assert.equal(uninvited.data.error.code, "INVITATION");
  const invitation = await command(a, "invite", { role: "finance" });
  assert.equal(invitation.status, 200);
  assert.equal(
    (
      await api(b, "/api/join", {
        workspaceId: a.workspaceId,
        token: invitation.data.token,
        role: "owner",
      })
    ).status,
    422,
  );
  assert.equal(
    (
      await api(b, "/api/join", {
        workspaceId: a.workspaceId,
        token: invitation.data.token,
      })
    ).status,
    200,
  );
  const finance = await api(b, "/api/workspace");
  assert.equal(finance.data.id, a.workspaceId);
  assert.equal(finance.data.actor.role, "finance");
  const memberId = finance.data.actor.id;
  assert.equal(
    (
      await command(b, "organization", {
        name: "forged owner",
        description: "denied",
      })
    ).status,
    403,
  );
  const savedCookie = b.jar.get("pantrypilot_session")!;
  const [body, signature] = savedCookie.split(".");
  const forged = JSON.parse(Buffer.from(body, "base64url").toString());
  forged.actorId = a.actorId;
  b.jar.set(
    "pantrypilot_session",
    `${Buffer.from(JSON.stringify(forged)).toString("base64url")}.${signature}`,
  );
  assert.equal((await api(b, "/api/workspace")).status, 401);
  b.jar.set("pantrypilot_session", savedCookie);
  assert.equal((await command(a, "revoke", { id: memberId })).status, 200);
  const revoked = await api(b, "/api/workspace");
  assert.equal(revoked.status, 401);
  assert.equal(revoked.data.error.code, "SESSION_REVOKED");
  const reusedInvitation = await api(b, "/api/join", {
    workspaceId: a.workspaceId,
    token: invitation.data.token,
  });
  assert.equal(reusedInvitation.status, 422);
  assert.equal(reusedInvitation.data.error.code, "INVITATION");
  console.log(
    "Real identity invitation, metadata/role escalation, forged cookie, membership revocation and used-invite replay denial PASS",
  );
  phase = "provider logout and copied-cookie replay";
  const beforeLogout = b.jar.get("pantrypilot_session")!;
  const logout = await api(b, "/api/logout", {});
  assert.equal(logout.status, 200);
  assert.ok(!b.jar.has("pantrypilot_session"));
  assert.ok(
    ![...b.jar.keys()].some((name) => name.startsWith(`sb-${ref}-auth-token`)),
  );
  assert.equal((await api(b, "/api/workspace")).status, 401);
  b.jar.set("pantrypilot_session", beforeLogout);
  assert.equal((await api(b, "/api/workspace")).status, 401);
  const publicClient = createClient(url, publicKey, {
    auth: { persistSession: false },
  });
  const refreshed = await publicClient.auth.refreshSession({
    refresh_token: b.refreshToken,
  });
  assert.ok(refreshed.error);
  assert.equal(refreshed.data.session, null);
  assert.equal((await api(a, "/api/workspace")).status, 200);
  const oldProviderCookies = new Map(a.jar);
  assert.equal((await api(a, "/api/logout", {})).status, 200);
  phase = "signed-out provider access JWT re-enrollment";
  a.jar = oldProviderCookies;
  a.jar.delete("pantrypilot_session");
  const staleIdentity = await api(a, "/api/join", {
    workspaceId: a.workspaceId,
  });
  console.log(
    `Signed-out provider credential re-enrollment status: ${staleIdentity.status}`,
  );
  assert.equal(staleIdentity.status, 401);
  console.log(
    "Actual provider refresh revocation, browser-cookie clearing, copied app-cookie denial and other-user continuity PASS",
  );
} catch (error) {
  console.error(
    `Isolation qualification failed during ${phase}; private errors and credentials suppressed.`,
  );
  if (error instanceof assert.AssertionError) {
    const safe = (value: unknown) =>
      typeof value === "number" || typeof value === "boolean"
        ? value
        : "[non-numeric value suppressed]";
    console.error(
      JSON.stringify({
        actual: safe(error.actual),
        expected: safe(error.expected),
        line: error.stack
          ?.split("\n")
          .find((line) => line.includes("qualify-isolation.ts")),
      }),
    );
  }
  process.exitCode = 1;
} finally {
  let clean = true;
  for (const userId of createdUsers) {
    const removed = await admin
      .from("workspaces")
      .delete()
      .eq("owner_id", userId)
      .eq("demo", false);
    const remaining = await admin
      .from("workspaces")
      .select("id")
      .eq("owner_id", userId);
    if (removed.error || remaining.error || remaining.data?.length)
      clean = false;
  }
  for (const userId of createdUsers) {
    if ((await admin.auth.admin.deleteUser(userId)).error) clean = false;
    const remaining = await admin.auth.admin.getUserById(userId);
    if (remaining.data.user || remaining.error?.status !== 404) clean = false;
  }
  if (!clean) {
    console.error(
      `Invocation-owned fixture cleanup needs review for run ${run}; user IDs: ${createdUsers.join(", ")}.`,
    );
    process.exitCode = 1;
  } else
    console.log(
      "Only invocation-created users/workspaces cleaned and read back PASS",
    );
}
