import { cookies } from "next/headers";
import {
  checkOrigin,
  cookieName,
  decodeSession,
  revokeSession,
} from "@/lib/session";
import { authClient } from "@/lib/auth";
import { configuration } from "@/lib/config";
import { ensure } from "@/lib/errors";
import { respond } from "@/lib/http";
export async function POST(request: Request) {
  return respond(async () => {
    checkOrigin(request);
    const jar = await cookies();
    let confirmed = true;
    try {
      const token = jar.get(cookieName)?.value;
      if (token) {
        let session;
        try {
          session = decodeSession(token);
        } catch {
          /* Invalid/expired cookies already deny access. */
        }
        if (session) await revokeSession(session);
      }
    } catch {
      confirmed = false;
    }
    try {
      if (configuration().storage === "supabase") {
        const { error } = await (
          await authClient()
        ).auth.signOut({ scope: "local" });
        if (error) confirmed = false;
      }
    } catch {
      confirmed = false;
    } finally {
      jar.delete(cookieName);
      const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
      if (url) {
        const prefix = `sb-${new URL(url).hostname.split(".")[0]}-auth-token`;
        for (const cookie of jar.getAll()) {
          if (
            cookie.name === prefix ||
            cookie.name === `${prefix}-code-verifier` ||
            cookie.name.startsWith(`${prefix}.`) ||
            cookie.name.startsWith(`${prefix}-code-verifier.`)
          ) {
            jar.delete(cookie.name);
          }
        }
      }
    }
    ensure(
      confirmed,
      "LOGOUT_UNCONFIRMED",
      "Browser credentials cleared, but server session revocation could not be confirmed.",
      503,
    );
    return { signedOut: true };
  });
}
