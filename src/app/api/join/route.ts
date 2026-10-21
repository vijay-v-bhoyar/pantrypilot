import { randomUUID } from "node:crypto";
import { z } from "zod";
import { authClient, serviceClient } from "@/lib/auth";
import { body, respond } from "@/lib/http";
import { checkOrigin, setSession } from "@/lib/session";
import { withWorkspace } from "@/lib/storage";
import { digest } from "@/lib/planner";
import { ensure } from "@/lib/errors";
import { record } from "@/lib/commands";
export async function POST(request: Request) {
  return respond(async () => {
    checkOrigin(request);
    const input = z
      .object({
        workspaceId: z.string().uuid(),
        token: z.string().max(100).optional(),
        campaignId: z.string().max(80).optional(),
      })
      .strict()
      .parse(await body(request));
    const client = await authClient();
    const { data, error } = await client.auth.getUser();
    ensure(
      !error && data.user,
      "AUTH",
      "Sign in with Google to accept an invitation.",
      401,
    );
    const user = data.user;
    const member = await withWorkspace(
      input.workspaceId,
      async (w) => {
        ensure(
          !w.demo,
          "DEMO",
          "Synthetic demo memberships cannot enroll real identities. Use the built-in role tour.",
        );
        const service = serviceClient();
        const existing = await service
          .from("memberships")
          .select("actor_id")
          .eq("user_id", user.id)
          .eq("workspace_id", w.id)
          .maybeSingle();
        ensure(!existing.error, "AUTH", "Membership lookup unavailable.", 503);
        const existingActor = existing.data?.actor_id;
        if (existingActor && w.actors.some((a) => a.id === existingActor))
          return existingActor;
        const invitation = input.token
          ? w.invitations.find(
              (i) =>
                i.tokenHash === digest(input.token!) &&
                !i.used &&
                i.expiresAt > new Date().toISOString(),
            )
          : undefined;
        const campaign = input.campaignId
          ? w.campaigns.find(
              (c) => c.id === input.campaignId && c.status === "published",
            )
          : undefined;
        ensure(
          invitation || campaign,
          "INVITATION",
          "This invitation expired, was used, or the campaign is unavailable.",
        );
        const org = invitation?.organizationId ?? campaign!.organizationId;
        const a = {
          id: randomUUID(),
          organizationId: org,
          name: "Pantry member",
          role: invitation?.role ?? ("donor" as const),
          supplierId: invitation?.supplierId,
        };
        w.actors.push(a);
        if (invitation) invitation.used = true;
        record(w, a, "join", a.id, `Enrollment as ${a.role}`);
        return a.id;
      },
      { userId: user.id, actorId: (actorId) => actorId },
    );
    await setSession(input.workspaceId, member);
    return { joined: true };
  });
}
