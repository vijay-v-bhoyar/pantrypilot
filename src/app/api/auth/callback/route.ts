import { authClient } from "@/lib/auth";
import { enrollOwner } from "@/lib/enrollment";
import { loadWorkspace } from "@/lib/storage";
import { actorFor } from "@/lib/commands";
import { setSession } from "@/lib/session";
import { ensure } from "@/lib/errors";
import { respond } from "@/lib/http";
import { authErrorResponse } from "@/lib/auth-error";
export async function GET(request: Request) {
  let ok = false;
  const response = await respond(async () => {
    const code = new URL(request.url).searchParams.get("code");
    ensure(code, "AUTH", "No authorization code received.", 401);
    const client = await authClient();
    const { data, error } = await client.auth.exchangeCodeForSession(code);
    ensure(!error && data.user, "AUTH", "Sign-in could not be verified.", 401);
    const { workspace_id: workspaceId, actor_id: actorId } = await enrollOwner(
      data.user.id,
    );
    actorFor(await loadWorkspace(workspaceId), actorId);
    await setSession(workspaceId, actorId);
    ok = true;
    return {};
  });
  return ok ? Response.redirect(`${process.env.APP_URL}/workspace`) : authErrorResponse(request, response, "callback");
}
