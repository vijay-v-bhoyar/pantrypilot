import { randomUUID } from "node:crypto";
import { z } from "zod";
import { createWorkspace, loadWorkspace } from "@/lib/storage";
import { seedWorkspace } from "@/lib/seed";
import { checkOrigin, getSession, setSession } from "@/lib/session";
import { body, respond } from "@/lib/http";
import { ensure } from "@/lib/errors";
import { reserveDemoStart } from "@/lib/runtime-quota";
export const runtime = "nodejs";
export async function POST(request: Request) {
  return respond(async () => {
    checkOrigin(request);
    const input = z
      .object({ actorId: z.string().max(80).optional() })
      .strict()
      .parse(await body(request));
    if (input.actorId) {
      const s = await getSession();
      const w = await loadWorkspace(s.workspaceId);
      ensure(
        w.demo,
        "DEMO_ONLY",
        "Role tours are available only in an isolated demo.",
        403,
      );
      ensure(
        w.actors.some((a) => a.id === input.actorId),
        "ACTOR",
        "That demo role is unavailable.",
      );
      await setSession(w.id, input.actorId);
      return { workspaceId: w.id };
    }
    await reserveDemoStart(request);
    const w = seedWorkspace(randomUUID());
    await createWorkspace(w);
    await setSession(w.id, "owner-a");
    return { workspaceId: w.id };
  });
}
