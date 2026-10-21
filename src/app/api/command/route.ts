import { z } from "zod";
import { execute } from "@/lib/commands";
import { withWorkspace } from "@/lib/storage";
import { checkOrigin, getSession } from "@/lib/session";
import { body, respond } from "@/lib/http";
export async function POST(request: Request) {
  return respond(async () => {
    checkOrigin(request);
    const s = await getSession();
    const input = z
      .object({
        command: z.string().max(40),
        data: z.unknown(),
        key: z.string().max(100),
      })
      .strict()
      .parse(await body(request));
    return withWorkspace(s.workspaceId, (w) =>
      execute(w, s.actorId, input.command, input.data, input.key),
    );
  });
}
