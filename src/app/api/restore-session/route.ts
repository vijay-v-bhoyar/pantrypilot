import { z } from "zod";
import { configuration } from "@/lib/config";
import { loadWorkspace } from "@/lib/storage";
import { body, respond } from "@/lib/http";
import { checkOrigin, setSession } from "@/lib/session";
import { ensure } from "@/lib/errors";
export async function POST(request: Request) {
  return respond(async () => {
    checkOrigin(request);
    ensure(
      !configuration().hosted,
      "LOCAL_ONLY",
      "Operator demo restore is loopback-only.",
      403,
    );
    ensure(
      ["127.0.0.1", "localhost"].includes(new URL(request.url).hostname),
      "LOCAL_ONLY",
      "Use the loopback app.",
      403,
    );
    const input = z
      .object({ workspaceId: z.string().uuid() })
      .strict()
      .parse(await body(request));
    const w = await loadWorkspace(input.workspaceId);
    ensure(
      w.demo && w.ownerId === "local-restored-demo",
      "RESTORE_SCOPE",
      "This is not a restored synthetic workspace.",
    );
    const actor = w.actors.find((a) => a.role === "owner")!;
    await setSession(w.id, actor.id);
    return { restored: true };
  });
}
