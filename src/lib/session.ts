import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { configuration } from "./config";
import { ensure } from "./errors";
import { loadWorkspace, withWorkspace } from "./storage";
import type { Session } from "./types";
export const cookieName = "pantrypilot_session";
function secret() {
  configuration();
  return (
    process.env.SESSION_SECRET || "local-loopback-development-only-do-not-host"
  );
}
export function encodeSession(session: Session) {
  const body = Buffer.from(JSON.stringify(session)).toString("base64url");
  return `${body}.${createHmac("sha256", secret()).update(body).digest("base64url")}`;
}
export function decodeSession(token: string): Session {
  const [body, signature, ...extra] = token.split(".");
  ensure(
    body && signature && !extra.length,
    "SESSION",
    "Sign in or start an isolated demo.",
    401,
  );
  const expected = createHmac("sha256", secret()).update(body).digest();
  const received = Buffer.from(signature, "base64url");
  ensure(
    received.length === expected.length && timingSafeEqual(received, expected),
    "SESSION",
    "Invalid session.",
    401,
  );
  let session: Session;
  try {
    session = JSON.parse(Buffer.from(body, "base64url").toString()) as Session;
  } catch {
    throw new Error("Invalid session.");
  }
  ensure(
    typeof session.workspaceId === "string" &&
      typeof session.actorId === "string" &&
      typeof session.nonce === "string" &&
      session.nonce.length > 0 &&
      typeof session.expiresAt === "number" &&
      session.expiresAt > Date.now(),
    "SESSION",
    "Your session expired.",
    401,
  );
  return session;
}
export async function getSession() {
  const token = (await cookies()).get(cookieName)?.value;
  ensure(token, "SESSION", "Start a demo or sign in.", 401);
  const session = decodeSession(token);
  const workspace = await loadWorkspace(session.workspaceId);
  ensure(
    !workspace.revokedSessionNonces?.[session.nonce],
    "SESSION_REVOKED",
    "This session was signed out. Sign in again.",
    401,
  );
  return session;
}
export async function revokeSession(session: Session) {
  await withWorkspace(session.workspaceId, (workspace) => {
    const now = Date.now();
    workspace.revokedSessionNonces = Object.fromEntries(
      Object.entries(workspace.revokedSessionNonces || {}).filter(
        ([, expiry]) => expiry > now,
      ),
    );
    workspace.revokedSessionNonces[session.nonce] = session.expiresAt;
  });
}
export async function setSession(workspaceId: string, actorId: string) {
  const c = await cookies();
  c.set(
    cookieName,
    encodeSession({
      workspaceId,
      actorId,
      expiresAt: Date.now() + 86400000,
      nonce: randomBytes(16).toString("hex"),
    }),
    {
      httpOnly: true,
      secure: configuration().hosted,
      sameSite: "lax",
      path: "/",
      maxAge: 86400,
    },
  );
}
export function checkOrigin(request: Request) {
  const origin = request.headers.get("origin");
  const allowed = new URL(process.env.APP_URL || "http://127.0.0.1:3100")
    .origin;
  ensure(
    origin === allowed,
    "ORIGIN",
    "This request came from an untrusted origin.",
    403,
  );
}
